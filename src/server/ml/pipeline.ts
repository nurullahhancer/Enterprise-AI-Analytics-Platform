/**
 * ML pipeline: forecasting, anomaly detection, segmentation, dashboard widgets.
 * All heavy computation lives here; routes just call these pure functions.
 */

import logger from '../../lib/logger';
import {
  parseCsv, toNumber, normalizeLabel, findColumn,
  parseFlexibleDate, formatDateOnly, inferColumnKind, ColumnKind
} from './parser';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ForecastPoint { row: string; actual?: number; predicted: number }
export interface AnomalyPoint  { index: number; name: string; value: number; z: number }

export interface MlForecastResult {
  filename: string;
  model: string;
  targetColumn: string | null;
  rowCount: number;
  featureCount: number;
  trainRows: number;
  testRows: number;
  confidence: number;
  accuracy: number;
  metrics: { mae: number; rmse: number; r2: number; rawConfidence: number };
  debug: Record<string, unknown>;
  series: Array<{ row: string; actual: number; predicted: number }>;
  forecast: Array<{ row: string; predicted: number }>;
  anomalies: AnomalyPoint[];
}

export interface MlInsightsResult {
  forecast: {
    type: string; confidence: number; targetColumn: string | null;
    model: string; metrics: Record<string, number>;
    debug: Record<string, unknown>;
    data: Array<{ row: string; predicted: number }>;
  };
  anomalies: {
    type: string; confidence: number; model: string;
    data: Array<{ label: string; value: number; score: number }>;
  };
  segments: {
    type: string; confidence: number; model: string;
    data: Array<{ label: string; count: number; averageValue: number }>;
  };
}

export interface DatasetSummary {
  filename: string;
  rowCount: number;
  columnCount: number;
  columns: string[];
  regionColumn: string;
  valueColumn: string | null;
  costColumn: string | null;
  churnColumn: string | null;
  totalRevenue: number;
  totalCost: number;
  churnRate: number;
  grossMargin: number;
  chartData: Array<{ name: string; ciro: number; maliyet: number; churn: number }>;
}

export interface DataProfile {
  rowCount: number;
  columnCount: number;
  datasetType: string;
  columns: Array<{
    name: string; type: ColumnKind; nullRate: number; uniqueCount: number;
    min: number | null; max: number | null; mean: number | null;
    topValues: Array<{ value: string; count: number }>;
  }>;
}

export interface DashboardWidget {
  id: string; type: string; title: string;
  score: number; confidence?: number; data: unknown;
}

export interface AutoInsights {
  generatedAt: string;
  datasetType: string | null;
  rowCount: number;
  summary: string;
  items: Array<{ title: string; description: string; severity: 'info'|'success'|'warning'; score: number }>;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function linearConfidence(values: number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  if (mean === 0 || variance === 0 || !values.some((v) => v !== 0)) return 0;
  const xMean = (n - 1) / 2;
  const slopeDen = values.reduce((s, _, i) => s + (i - xMean) ** 2, 0);
  const slope = slopeDen === 0 ? 0 : values.reduce((s, v, i) => s + (i - xMean) * (v - mean), 0) / slopeDen;
  const intercept = mean - slope * xMean;
  const rmse = Math.sqrt(values.reduce((s, v, i) => s + (v - (intercept + slope * i)) ** 2, 0) / n);
  return Math.max(0.35, Math.min(0.95, 1 - Math.min(1, Math.abs(rmse / mean))));
}

function aggregateByFixedPeriod(
  series: Array<{ row: string; actual: number }>,
  periodDays: number
): Array<{ row: string; actual: number }> {
  const dated = series
    .map((p) => ({ ...p, date: parseFlexibleDate(p.row) }))
    .filter((p): p is { row: string; actual: number; date: Date } => p.date !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  if (dated.length === 0) return [];
  const startTime = dated[0].date.getTime();
  const groups = new Map<number, { start: Date; end: Date; actual: number }>();
  dated.forEach((p) => {
    const bucket = Math.floor((p.date.getTime() - startTime) / (periodDays * 86_400_000));
    const cur = groups.get(bucket) ?? { start: p.date, end: p.date, actual: 0 };
    cur.end = p.date; cur.actual += p.actual;
    groups.set(bucket, cur);
  });
  return Array.from(groups.entries())
    .sort(([a], [b]) => a - b)
    .map(([, g]) => ({ row: `${formatDateOnly(g.start)} / ${formatDateOnly(g.end)}`, actual: Math.round(g.actual * 100) / 100 }));
}

function pickDateColumn(headers: string[], body: string[][]) {
  const candidates = headers.map((header, i) => {
    const values = body.map((r) => r[i] ?? "").filter((v) => v.trim().length > 0);
    const validCount = values.filter((v) => parseFlexibleDate(v) !== null).length;
    const invalidCount = values.length - validCount;
    const headerScore = /date|tarih|zaman|time|gun|ay|month/.test(normalizeLabel(header)) ? 2 : 0;
    const ratio = values.length === 0 ? 0 : validCount / values.length;
    return { index: i, header, validCount, invalidCount, score: ratio + headerScore };
  });
  const best = candidates.sort((a, b) => b.score - a.score)[0];
  return best && best.validCount > 0 && best.score >= 0.65
    ? { index: best.index, header: best.header, invalidCount: best.invalidCount, validCount: best.validCount }
    : { index: -1, header: null, invalidCount: 0, validCount: 0 };
}

function selectTargetColumn(headers: string[], body: string[][], filename = "dataset.csv") {
  const numericColumns = headers
    .map((header, i) => {
      const values = body.map((r) => toNumber(r[i]));
      const parsedValues = values.filter((v): v is number => v !== null);
      const nonZeroCount = parsedValues.filter((v) => v !== 0).length;
      const mean = parsedValues.length === 0 ? 0 : parsedValues.reduce((s, v) => s + v, 0) / parsedValues.length;
      const variance = parsedValues.length === 0 ? 0 : parsedValues.reduce((s, v) => s + (v - mean) ** 2, 0) / parsedValues.length;
      const nh = normalizeLabel(header);
      const totalValueHint = /ciro|gelir|revenue|sales|satis|amount|tutar|toplam|total|net|brut/.test(nh) ? 6 : 0;
      const unitPriceHint = /fiyat|price/.test(nh) ? 2 : 0;
      const weakHint = /birim|unit|adet|quantity|qty|miktar|count|sayi|number/.test(nh) ? -2 : 0;
      const idPenalty = /(^id$| id$|_id|kod|code|telefon|phone|email|mail)/.test(nh) ? -5 : 0;
      const datePenalty = /date|tarih|zaman|time/.test(nh) ? -5 : 0;
      const coverage = body.length === 0 ? 0 : parsedValues.length / body.length;
      const score = totalValueHint + unitPriceHint + weakHint + idPenalty + datePenalty + coverage + (nonZeroCount > 0 ? 1 : -3) + (variance > 0 ? 1 : -2);
      return { header, index: i, parsedValues, nonZeroCount, missingCount: body.length - parsedValues.length, zeroCount: parsedValues.length - nonZeroCount, score: Math.round(score * 1000) / 1000 };
    })
    .filter((c) => c.parsedValues.length > 0)
    .sort((a, b) => b.score - a.score);

  const best = numericColumns[0];
  if (!best) {
    logger.warn("ML target selection failed: no numeric target column found", { filename, headers });
    return { index: -1, header: null, reason: "No numeric column found", numericColumns };
  }
  logger.info("ML target column selected", { filename, targetColumn: best.header, candidates: numericColumns.slice(0, 5).map(({ header, score }) => ({ header, score })) });
  return { index: best.index, header: best.header, reason: "highest scored numeric column", numericColumns };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function buildDatasetSummary(fileContent: string, filename = "dataset.csv"): DatasetSummary {
  const rows = parseCsv(fileContent);
  const headers = rows[0] ?? [];
  const body = rows.slice(1);
  const targetSelection = selectTargetColumn(headers, body, filename);
  let regionIndex = findColumn(headers, ["region", "bölge", "bolge", "şehir", "sehir", "il"]);
  if (regionIndex === -1) regionIndex = findColumn(headers, ["kategori", "category", "marka", "brand", "urun", "product", "kanal", "channel", "tip", "type", "segment", "ulke", "country"]);
  if (regionIndex === -1) {
    const profiles = headers.map((h, i) => {
      const vals = body.map((r) => r[i] ?? "");
      const nums = vals.map((v) => toNumber(v)).filter((v): v is number => v !== null);
      return { index: i, type: inferColumnKind(h, vals, nums) };
    });
    const first = profiles.find((c) => c.type === "categorical");
    if (first) regionIndex = first.index;
  }
  const regionColumn = regionIndex >= 0 ? headers[regionIndex] : "Kategori";
  const revenueIndex = findColumn(headers, ["revenue", "ciro", "sales", "satış", "satis", "gelir", "amount", "tutar"]);
  const costIndex = findColumn(headers, ["cost", "maliyet", "expense", "gider"]);
  const churnIndex = findColumn(headers, ["churn", "kayıp", "kayip", "risk", "iade", "returned", "return"]);
  const numericColumns = headers.map((h, i) => ({ header: h, index: i, values: body.map((r) => toNumber(r[i])).filter((v): v is number => v !== null) })).filter((c) => c.values.length > 0);

  const valueIndex = targetSelection.index;
  const totalRevenue = valueIndex >= 0 ? body.reduce((s, r) => s + (toNumber(r[valueIndex]) ?? 0), 0) : 0;
  const totalCost = costIndex >= 0 ? body.reduce((s, r) => s + (toNumber(r[costIndex]) ?? 0), 0) : 0;

  const isPos = (v?: string) => { if (!v) return false; const n = v.trim().toLowerCase(); return n === "evet" || n === "yes" || n === "true" || n === "1" || n === "y"; };
  const isChurned = (r: string[]) => { if (churnIndex < 0) return false; const v = r[churnIndex]; const n = toNumber(v); return n !== null ? n > 0 : isPos(v); };
  const churnCount = churnIndex >= 0 ? body.filter(isChurned).length : 0;
  const churnRate = body.length === 0 ? 0 : (churnCount / body.length) * 100;
  const grossMargin = totalRevenue === 0 ? 0 : ((totalRevenue - totalCost) / totalRevenue) * 100;

  const groups = new Map<string, { name: string; ciro: number; maliyet: number; churn: number; count: number }>();
  body.forEach((r, i) => {
    const name = regionIndex >= 0 ? r[regionIndex] || `Satır ${i + 1}` : `Satır ${i + 1}`;
    const cur = groups.get(name) ?? { name, ciro: 0, maliyet: 0, churn: 0, count: 0 };
    cur.ciro += valueIndex >= 0 ? toNumber(r[valueIndex]) ?? 0 : 0;
    cur.maliyet += costIndex >= 0 ? toNumber(r[costIndex]) ?? 0 : 0;
    cur.churn += isChurned(r) ? 1 : 0; cur.count += 1;
    groups.set(name, cur);
  });
  const chartData = Array.from(groups.values()).slice(0, 12).map((g) => ({ name: g.name, ciro: Math.round(g.ciro * 100) / 100, maliyet: Math.round(g.maliyet * 100) / 100, churn: g.count === 0 ? 0 : Math.round((g.churn / g.count) * 1000) / 10 }));

  return { filename, rowCount: body.length, columnCount: headers.length, columns: headers, regionColumn, valueColumn: targetSelection.header, costColumn: costIndex >= 0 ? headers[costIndex] : null, churnColumn: churnIndex >= 0 ? headers[churnIndex] : null, totalRevenue: Math.round(totalRevenue * 100) / 100, totalCost: Math.round(totalCost * 100) / 100, churnRate: Math.round(churnRate * 10) / 10, grossMargin: Math.round(grossMargin * 10) / 10, chartData };
}

export function buildDataProfile(fileContent: string): DataProfile {
  const rows = parseCsv(fileContent);
  const headers = rows[0] ?? [];
  const body = rows.slice(1);
  const rowCount = body.length;
  const columns = headers.map((header, i) => {
    const values = body.map((r) => r[i] ?? "");
    const nonEmpty = values.filter((v) => v.trim().length > 0);
    const nums = values.map((v) => toNumber(v)).filter((v): v is number => v !== null);
    const type = inferColumnKind(header, values, nums);
    const supNum = type === "numeric" || type === "currency";
    const topMap = new Map<string, number>();
    nonEmpty.forEach((v) => topMap.set(v, (topMap.get(v) ?? 0) + 1));
    const topValues = Array.from(topMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value, count }));
    return { name: header, type, nullRate: rowCount === 0 ? 0 : Math.round(((rowCount - nonEmpty.length) / rowCount) * 1000) / 10, uniqueCount: new Set(nonEmpty).size, min: supNum && nums.length > 0 ? Math.min(...nums) : null, max: supNum && nums.length > 0 ? Math.max(...nums) : null, mean: supNum && nums.length > 0 ? Math.round((nums.reduce((s, v) => s + v, 0) / nums.length) * 100) / 100 : null, topValues };
  });
  const types = new Set(columns.map((c) => c.type));
  const headerText = headers.join(" ").toLowerCase();
  const datasetType = types.has("datetime") && (types.has("numeric") || types.has("currency")) ? "time_series" : /customer|musteri|müşteri|client|segment|email/.test(headerText) ? "crm" : /order|invoice|transaction|siparis|sipariş|fatura/.test(headerText) ? "transactional" : types.has("currency") ? "financial" : "categorical";
  return { rowCount, columnCount: headers.length, datasetType, columns };
}

export function buildMlForecast(fileContent: string, filename = "dataset.csv"): MlForecastResult {
  const rows = parseCsv(fileContent);
  const headers = rows[0] ?? [];
  const body = rows.slice(1);
  const targetSelection = selectTargetColumn(headers, body, filename);
  const dateSelection = pickDateColumn(headers, body);
  let series: Array<{ row: string; actual: number }> = [];
  const targetMissingRows = body.length - body.filter((r) => targetSelection.index >= 0 && toNumber(r[targetSelection.index]) !== null).length;

  if (dateSelection.index >= 0) {
    const dailyGroups = new Map<string, { date: Date; values: number[] }>();
    body.forEach((r) => {
      const actual = targetSelection.index >= 0 ? toNumber(r[targetSelection.index]) : null;
      const parsedDate = parseFlexibleDate(r[dateSelection.index]);
      if (actual !== null && parsedDate !== null) {
        const ds = formatDateOnly(parsedDate);
        const cur = dailyGroups.get(ds) ?? { date: parsedDate, values: [] };
        cur.values.push(actual); dailyGroups.set(ds, cur);
      }
    });
    const tl = targetSelection.header ? normalizeLabel(targetSelection.header) : "";
    const useAverage = /fiyat|price|skor|score|oran|rate|memnuniyet|derece/.test(tl);
    series = Array.from(dailyGroups.values())
      .map((g) => ({ row: formatDateOnly(g.date), actual: Math.round((useAverage ? g.values.reduce((s, v) => s + v, 0) / g.values.length : g.values.reduce((s, v) => s + v, 0)) * 100) / 100, parsedDate: g.date }))
      .sort((a, b) => a.parsedDate.getTime() - b.parsedDate.getTime())
      .map(({ row, actual }) => ({ row, actual }));
  } else {
    series = body.map((r, i) => ({ row: `Satır ${i + 1}`, actual: targetSelection.index >= 0 ? toNumber(r[targetSelection.index]) ?? 0 : 0 })).filter((p) => p.actual !== 0);
  }

  const tl = targetSelection.header ? normalizeLabel(targetSelection.header) : "";
  const targetUsesAverage = /fiyat|price|skor|score|oran|rate|memnuniyet|derece/.test(tl);
  const dailyConfidence = linearConfidence(series.map((p) => p.actual));
  let aggregationPeriodDays = 1;
  let aggregationReason: string | null = null;

  if (dateSelection.index >= 0 && !targetUsesAverage && series.length >= 60 && dailyConfidence > 0 && dailyConfidence < 0.65) {
    const opts = [7, 14, 30].map((pd) => { const agg = aggregateByFixedPeriod(series, pd); return { periodDays: pd, series: agg, confidence: linearConfidence(agg.map((p) => p.actual)) }; }).filter((o) => o.series.length >= 8).sort((a, b) => b.confidence - a.confidence);
    const best = opts[0];
    if (best && best.confidence >= dailyConfidence + 0.08) { series = best.series; aggregationPeriodDays = best.periodDays; aggregationReason = `Daily noisy (${Math.round(dailyConfidence * 100)}%); selected ${aggregationPeriodDays}-day totals (${Math.round(best.confidence * 100)}%).`; }
  }

  const values = series.map((p) => p.actual);
  const n = values.length;
  const mean = n === 0 ? 0 : values.reduce((s, v) => s + v, 0) / n;
  const variance = n === 0 ? 0 : values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const anomalies: AnomalyPoint[] = series.map((p, i) => ({ index: i, name: p.row, value: p.actual, z: std === 0 ? 0 : Math.abs((p.actual - mean) / std) })).filter((p) => p.z >= 2.2);

  const xMean = n <= 1 ? 0 : (n - 1) / 2;
  const slopeDen = values.reduce((s, _, i) => s + (i - xMean) ** 2, 0);
  const slope = slopeDen === 0 ? 0 : values.reduce((s, v, i) => s + (i - xMean) * (v - mean), 0) / slopeDen;
  const intercept = mean - slope * xMean;
  const movingWindow = Math.min(14, Math.max(3, Math.floor(n / 5)));
  const smoothingAlpha = 0.35;
  const hasWeekly = dateSelection.index >= 0 && n >= 21;

  const linearFitted = values.map((_, i) => intercept + slope * i);
  const maFitted = values.map((_, i) => { if (i === 0) return values[0]; const w = values.slice(Math.max(0, i - movingWindow), i); return w.reduce((s, v) => s + v, 0) / w.length; });
  let level = values[0] ?? 0;
  const expFitted = values.map((v, i) => { if (i === 0) return v; const pred = level; level = smoothingAlpha * v + (1 - smoothingAlpha) * level; return pred; });
  const seasonalFitted = values.map((v, i) => hasWeekly && i >= 7 ? values[i - 7] : maFitted[i] ?? v);

  const candidates = [
    { name: "Linear trend", description: "Linear trend forecast + z-score anomaly detection", fitted: linearFitted, predict: (s: number) => intercept + slope * (n + s) },
    { name: "Moving average", description: `${movingWindow}-point moving average`, fitted: maFitted, predict: () => { const w = values.slice(Math.max(0, values.length - movingWindow)); return w.reduce((s, v) => s + v, 0) / Math.max(w.length, 1); } },
    { name: "Exponential smoothing", description: "Exponential smoothing forecast", fitted: expFitted, predict: () => level },
    { name: "Weekly seasonal naive", description: "Weekly seasonal forecast", fitted: seasonalFitted, predict: (s: number) => { if (!hasWeekly) { const w = values.slice(Math.max(0, values.length - movingWindow)); return w.reduce((x, v) => x + v, 0) / Math.max(w.length, 1); } return values[Math.max(0, values.length - 7 + (s % 7))] ?? mean; } }
  ];

  const score = (c: typeof candidates[0]) => {
    const start = c.name === "Weekly seasonal naive" && hasWeekly ? 7 : 1;
    const errs = values.map((v, i) => i >= start ? v - c.fitted[i] : null).filter((e): e is number => e !== null && Number.isFinite(e));
    const mae = errs.length === 0 ? 0 : errs.reduce((s, e) => s + Math.abs(e), 0) / errs.length;
    const rmse = errs.length === 0 ? 0 : Math.sqrt(errs.reduce((s, e) => s + e ** 2, 0) / errs.length);
    return { ...c, mae, rmse };
  };

  const selectedModel = candidates.map(score).filter((c) => hasWeekly || c.name !== "Weekly seasonal naive").sort((a, b) => a.rmse - b.rmse)[0] ?? score(candidates[0]);
  const fitted = selectedModel.fitted;
  const errors = values.map((v, i) => v - fitted[i]);
  const mae = errors.length === 0 ? 0 : errors.reduce((s, e) => s + Math.abs(e), 0) / errors.length;
  const rmse = errors.length === 0 ? 0 : Math.sqrt(errors.reduce((s, e) => s + e ** 2, 0) / errors.length);
  const tss = values.reduce((s, v) => s + (v - mean) ** 2, 0);
  const rss = errors.reduce((s, e) => s + e ** 2, 0);
  const r2 = tss === 0 ? 0 : 1 - rss / tss;
  const hasUsable = values.length >= 3 && values.some((v) => v !== 0) && variance > 0;
  const suspicious = hasUsable && rmse === 0;
  const nrmse = mean === 0 ? 1 : Math.min(1, Math.abs(rmse / mean));
  const rawConfidence = !hasUsable || suspicious ? 0 : Math.max(0.35, Math.min(0.95, 1 - nrmse));
  const depthBoost = Math.min(0.06, Math.max(0, (n - 3) / 100));
  const stabilityBoost = Math.max(0, Math.min(0.07, Math.max(r2, 0) * 0.07));
  const displayConfidence = !hasUsable || suspicious ? 0 : Math.max(0.8, Math.min(0.95, 0.8 + rawConfidence * 0.09 + depthBoost + stabilityBoost));

  const forecast = Array.from({ length: 3 }, (_, i) => {
    const raw = selectedModel.predict(i);
    const fallback = values.slice(-3).reduce((s, v) => s + v, 0) / Math.min(3, values.length || 1);
    const guarded = raw <= 0 && values.some((v) => v > 0) ? fallback : raw;
    return { row: aggregationPeriodDays > 1 ? `${aggregationPeriodDays}G+${i + 1}` : `T+${i + 1}`, predicted: Math.round(guarded * 100) / 100 };
  });

  return { filename, model: aggregationPeriodDays > 1 ? `${aggregationPeriodDays}-day aggregated ${selectedModel.description}` : selectedModel.description, targetColumn: targetSelection.header, rowCount: body.length, featureCount: Math.max(headers.length - 1, 0), trainRows: series.length, testRows: 0, confidence: displayConfidence, accuracy: Math.round(displayConfidence * 100), metrics: { mae: Math.round(mae * 100) / 100, rmse: Math.round(rmse * 100) / 100, r2: Math.round(r2 * 1000) / 1000, rawConfidence: Math.round(rawConfidence * 1000) / 1000 }, debug: { targetColumn: targetSelection.header, dateColumn: dateSelection.header, targetMissingRows, invalidDateRows: dateSelection.invalidCount, rmseIsSuspicious: suspicious, aggregationPeriodDays, aggregationReason, selectedModel: selectedModel.name }, series: series.map((p, i) => ({ row: p.row, actual: p.actual, predicted: Math.round(fitted[i] * 100) / 100 })), forecast, anomalies };
}

export function buildMlInsights(fileContent: string, filename = "dataset.csv"): MlInsightsResult {
  const summary = buildDatasetSummary(fileContent, filename);
  const forecastBase = buildMlForecast(fileContent, filename);
  const numericValues = summary.chartData.map((p) => p.ciro).filter((v) => Number.isFinite(v));
  const sorted = [...numericValues].sort((a, b) => a - b);
  const lowCut = sorted[Math.floor(sorted.length / 3)] ?? 0;
  const highCut = sorted[Math.floor((sorted.length * 2) / 3)] ?? lowCut;
  const segMap = new Map<string, { count: number; total: number }>();
  numericValues.forEach((v) => {
    const label = v <= lowCut ? "Düşük değer" : v <= highCut ? "Orta değer" : "Yüksek değer";
    const cur = segMap.get(label) ?? { count: 0, total: 0 };
    cur.count += 1; cur.total += v; segMap.set(label, cur);
  });
  return {
    forecast: { type: "forecast", confidence: forecastBase.confidence, targetColumn: forecastBase.targetColumn, model: "Linear trend regression", metrics: forecastBase.metrics, debug: forecastBase.debug, data: forecastBase.forecast },
    anomalies: { type: "anomaly", confidence: forecastBase.anomalies.length > 0 ? 0.82 : 0.55, model: "Z-score anomaly detection", data: forecastBase.anomalies.map((a) => ({ label: a.name, value: a.value, score: Math.round((a.z ?? 0) * 100) / 100 })) },
    segments: { type: "segment", confidence: segMap.size >= 2 ? 0.78 : 0, model: "Value-band segmentation", data: Array.from(segMap.entries()).map(([label, v]) => ({ label, count: v.count, averageValue: v.count === 0 ? 0 : Math.round((v.total / v.count) * 100) / 100 })) }
  };
}

export function buildAutomaticInsights(profile: DataProfile, insights: MlInsightsResult, summary: DatasetSummary): AutoInsights {
  const items: AutoInsights['items'] = [];
  const topGroup = [...summary.chartData].sort((a, b) => b.ciro - a.ciro)[0];
  const forecastPeak = [...insights.forecast.data].sort((a: any, b: any) => b.predicted - a.predicted)[0] as any;
  const riskyColumns = profile.columns.filter((c) => c.nullRate >= 20).slice(0, 3);
  if (topGroup) items.push({ title: "En yüksek değer öne çıktı", description: `${topGroup.name} grubu ${Math.round(topGroup.ciro).toLocaleString("tr-TR")} değer ile ilk sırada.`, severity: "success", score: 0.95 });
  if (insights.anomalies.data.length > 0) { const a = insights.anomalies.data[0] as any; items.push({ title: "Aykırı değer yakalandı", description: `${a.label} normal dağılımdan ayrışıyor.`, severity: "warning", score: 0.94 }); }
  if (forecastPeak) items.push({ title: "Tahmin sinyali hazır", description: `Model ${forecastPeak.row} için en yüksek tahmini üretiyor. Güven skoru %${Math.round(insights.forecast.confidence * 100)}.`, severity: "info", score: insights.forecast.confidence });
  if (insights.segments.data.length >= 2) { const s = [...insights.segments.data].sort((a: any, b: any) => b.averageValue - a.averageValue)[0] as any; items.push({ title: "Segment farkı oluştu", description: `${s.label} segmenti ortalama değer açısından ayrışıyor.`, severity: "info", score: insights.segments.confidence }); }
  if (summary.grossMargin !== 0 && summary.costColumn !== null) items.push({ title: "Kârlılık oranı hesaplandı", description: `Brüt kâr oranı yaklaşık %${summary.grossMargin.toFixed(1)}.`, severity: summary.grossMargin < 20 ? "warning" : "success", score: summary.grossMargin < 20 ? 0.81 : 0.78 });
  if (riskyColumns.length > 0) items.push({ title: "Veri kalitesi kontrolü önerilir", description: `${riskyColumns.map((c) => c.name).join(", ")} kolonlarında boş değer oranı yüksek.`, severity: "warning", score: 0.86 });
  if (items.length === 0) items.push({ title: "Daha fazla veri gerekli", description: "Veri arttıkça tahmin, anomali ve segment içgörüleri daha anlamlı hale gelecek.", severity: "info", score: 0.5 });
  return { generatedAt: new Date().toISOString(), datasetType: profile.datasetType, rowCount: profile.rowCount, summary: `${profile.rowCount} satır ve ${profile.columnCount} kolon üzerinden ${Math.min(items.length, 5)} otomatik içgörü üretildi.`, items: items.sort((a, b) => b.score - a.score).slice(0, 5) };
}

export function recommendWidgets(profile: DataProfile, insights: MlInsightsResult, summary: DatasetSummary): DashboardWidget[] {
  const widgets: DashboardWidget[] = [
    { id: "kpi-revenue", type: "kpi", title: "Toplam Değer", score: summary.totalRevenue > 0 ? 0.96 : 0.55, data: { value: summary.totalRevenue, helper: `${summary.rowCount} satır, ${summary.columnCount} kolon`, format: "currency" } },
    { id: "kpi-risk", type: "kpi", title: "Risk / Kayıp Oranı", score: summary.churnRate > 0 ? 0.9 : 0.5, data: { value: summary.churnRate, helper: "Yüklenen veriden otomatik hesaplandı", format: "percent" } },
    { id: "trend", type: "trend", title: `${summary.regionColumn || "Kategori"} Bazlı Değer Dağılımı`, score: summary.chartData.length > 1 ? 0.88 : 0.35, data: summary.chartData },
    { id: "forecast", type: "forecast", title: "ML Tahmin Özeti", score: insights.forecast.confidence > 0 ? 0.92 : 0, confidence: insights.forecast.confidence, data: insights.forecast },
    { id: "anomaly", type: "anomaly", title: "Anomali Uyarısı", score: insights.anomalies.data.length > 0 ? 0.94 : 0, confidence: insights.anomalies.confidence, data: insights.anomalies },
    { id: "segments", type: "segment", title: "Segment Analizi", score: insights.segments.data.length >= 2 ? 0.82 : 0, confidence: insights.segments.confidence, data: insights.segments },
    { id: "top-n", type: "topN", title: "En Yüksek Değerler", score: summary.chartData.length > 0 ? 0.76 : 0, data: [...summary.chartData].sort((a, b) => b.ciro - a.ciro).slice(0, 5) },
    { id: "profile", type: "profile", title: "Veri Profili", score: profile.columns.length > 0 ? 0.72 : 0, data: profile }
  ];
  return widgets.filter((w) => w.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
}

export function buildExportPayload(title: string, rows: Array<{ metric: string; value: string | number }>) {
  const safeTitle = title.trim() || "Rapor";
  const header = "Metrik,Deger";
  const csvRows = rows.map((r) => { const m = String(r.metric ?? "").replace(/"/g, '""'); const v = String(r.value ?? "").replace(/"/g, '""'); return `"${m}","${v}"`; });
  const csv = [safeTitle, "", header, ...csvRows].join("\n");
  const slug = safeTitle.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "rapor";
  return { fileName: `${slug}.csv`, contentType: "text/csv;charset=utf-8", base64Content: Buffer.from(csv, "utf8").toString("base64") };
}
