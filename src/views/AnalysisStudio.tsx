import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  Download,
  FileSearch,
  LoaderCircle,
  Lightbulb,
  Minus,
  Play,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
} from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { authHeaders, getApiUrl, jsonHeaders } from '../lib/api';
import { cn } from '../lib/utils';
import MarkdownContent from '../components/MarkdownContent';

export interface AnalysisProfile {
  rowCount: number;
  columnCount: number;
  datasetType: string;
  columns: Array<{
    name: string;
    type: string;
    nullRate: number;
    uniqueCount: number;
    mean: number | null;
  }>;
}

interface AnalysisStudioProps {
  profile: AnalysisProfile | null;
  datasetFilename?: string;
  datasetCount?: number;
  isDark: boolean;
}

type JsonRecord = Record<string, unknown>;
type JobState = 'queued' | 'running' | 'completed' | 'failed';

interface ForecastPoint {
  row: string;
  predicted: number;
  lower?: number;
  upper?: number;
}

interface CandidateModelMetric {
  model: string;
  label?: string;
  mae?: number;
  rmse?: number;
  smape?: number;
  rank?: number;
  selected: boolean;
}

interface ClassificationUseCase {
  useCase: string;
  label: string;
  targetColumn: string;
  model: string;
  confidence: number;
  trainRows?: number;
  testRows?: number;
  accuracy?: number;
  precision?: number;
  recall?: number;
  f1?: number;
  risks: JsonRecord[];
  drivers: JsonRecord[];
}

interface AnalysisResult {
  analysisRunId?: string;
  datasetFilename?: string;
  datasetCount?: number;
  sourceFilenames: string[];
  datasetType?: string;
  targetColumn?: string;
  modelName?: string;
  selectedModel?: string;
  selectionMetric?: string;
  confidence?: number;
  trainRows?: number;
  testRows?: number;
  metrics: {
    mae?: number;
    rmse?: number;
    r2?: number;
    smape?: number;
  };
  forecast: ForecastPoint[];
  anomalies: JsonRecord[];
  anomalyModel?: string;
  segments: JsonRecord[];
  segmentModel?: string;
  warnings: string[];
  candidateModels: CandidateModelMetric[];
  classifications: ClassificationUseCase[];
}

interface InterpretationResult {
  text: string;
  provider?: string;
  model?: string;
  cached: boolean;
}

const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 2 * 60_000;

const isRecord = (value: unknown): value is JsonRecord => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const textValue = (...values: unknown[]): string | undefined => {
  const value = values.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
  return typeof value === 'string' ? value.trim() : undefined;
};

const numberValue = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const listOfRecords = (value: unknown): JsonRecord[] => (
  Array.isArray(value) ? value.filter(isRecord) : []
);

const listOfStrings = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : []
);

const responseError = (payload: unknown, fallback: string): string => {
  if (!isRecord(payload)) return fallback;
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  if (isRecord(payload.error)) {
    return textValue(payload.error.message, payload.error.code) || fallback;
  }
  return textValue(payload.message) || fallback;
};

const normalizeForecastPoint = (value: JsonRecord, index: number): ForecastPoint | null => {
  const predicted = numberValue(value.predicted, value.value, value.yhat);
  if (predicted === undefined) return null;
  return {
    row: textValue(value.date, value.row, value.period, value.label) || `T+${index + 1}`,
    predicted,
    lower: numberValue(value.lower, value.lowerBound, value.lower_bound),
    upper: numberValue(value.upper, value.upperBound, value.upper_bound),
  };
};

const normalizeAnalysisResult = (payload: unknown): AnalysisResult => {
  if (!isRecord(payload)) throw new Error('ML servisi geçersiz bir analiz sonucu döndürdü.');

  const source = isRecord(payload.result) ? payload.result : payload;
  const dataset = isRecord(source.dataset) ? source.dataset : {};
  const forecastEnvelope = isRecord(source.forecast) ? source.forecast : {};
  const forecastMetrics = isRecord(forecastEnvelope.metrics) ? forecastEnvelope.metrics : {};
  const topMetrics = isRecord(source.metrics) ? source.metrics : {};
  const validation = isRecord(source.validation) ? source.validation : {};
  const validationMetrics = isRecord(validation.metrics) ? validation.metrics : {};
  const anomaliesEnvelope = isRecord(source.anomalies) ? source.anomalies : {};
  const segmentsEnvelope = isRecord(source.segments) ? source.segments : {};
  const classifications = (Array.isArray(source.classifications) ? source.classifications : [])
    .filter(isRecord)
    .flatMap((envelope): ClassificationUseCase[] => {
      const metrics = isRecord(envelope.metrics) ? envelope.metrics : {};
      const useCase = textValue(metrics.use_case, metrics.useCase);
      const target = textValue(metrics.target_column, metrics.targetColumn);
      if (!useCase || !target) return [];
      return [{
        useCase,
        label: textValue(metrics.label) || useCase,
        targetColumn: target,
        model: textValue(envelope.model) || 'Sınıflandırma modeli',
        confidence: numberValue(envelope.confidence, metrics.roc_auc) || 0,
        trainRows: numberValue(metrics.train_rows, metrics.trainRows),
        testRows: numberValue(metrics.test_rows, metrics.testRows),
        accuracy: numberValue(metrics.accuracy),
        precision: numberValue(metrics.precision),
        recall: numberValue(metrics.recall),
        f1: numberValue(metrics.f1),
        risks: listOfRecords(envelope.data),
        drivers: listOfRecords(metrics.drivers),
      }];
    });

  const forecastRows = Array.isArray(forecastEnvelope.data)
    ? forecastEnvelope.data
    : Array.isArray(source.forecastData)
      ? source.forecastData
      : [];
  const forecast = forecastRows
    .filter(isRecord)
    .map(normalizeForecastPoint)
    .filter((point): point is ForecastPoint => point !== null);

  const warnings = [
    ...listOfStrings(source.warnings),
    ...listOfStrings(forecastEnvelope.warnings),
  ].filter((warning, index, all) => all.indexOf(warning) === index);
  const candidateModels = listOfRecords(forecastMetrics.candidate_metrics ?? forecastMetrics.candidateMetrics)
    .map((candidate): CandidateModelMetric | null => {
      const model = textValue(candidate.model);
      if (!model) return null;
      return {
        model,
        label: textValue(candidate.label),
        mae: numberValue(candidate.mae),
        rmse: numberValue(candidate.rmse),
        smape: numberValue(candidate.smape),
        rank: numberValue(candidate.rank),
        selected: candidate.selected === true,
      };
    })
    .filter((candidate): candidate is CandidateModelMetric => candidate !== null)
    .sort((left, right) => (left.rank ?? 999) - (right.rank ?? 999));

  return {
    analysisRunId: textValue(source.analysisRunId, source.analysis_run_id),
    datasetFilename: textValue(source.datasetFilename, source.dataset_filename, dataset.filename, dataset.name),
    datasetCount: numberValue(source.datasetCount, source.dataset_count, dataset.count),
    sourceFilenames: listOfStrings(source.sourceFilenames ?? source.source_filenames),
    datasetType: textValue(source.datasetType, source.dataset_type, dataset.type),
    targetColumn: textValue(source.targetColumn, source.target_column, forecastEnvelope.targetColumn, forecastEnvelope.target_column),
    modelName: textValue(source.modelName, source.model_name, forecastEnvelope.model),
    selectedModel: textValue(forecastMetrics.selected_model, forecastMetrics.selectedModel),
    selectionMetric: textValue(forecastMetrics.selection_metric, forecastMetrics.selectionMetric),
    confidence: numberValue(source.confidence, source.validationScore, source.validation_score, forecastEnvelope.confidence, validation.confidence),
    trainRows: numberValue(
      source.trainRows,
      source.train_rows,
      forecastEnvelope.trainRows,
      forecastEnvelope.train_rows,
      forecastMetrics.trainRows,
      forecastMetrics.train_rows,
      validation.trainRows,
      validation.train_rows,
    ),
    testRows: numberValue(
      source.testRows,
      source.test_rows,
      forecastEnvelope.testRows,
      forecastEnvelope.test_rows,
      forecastMetrics.testRows,
      forecastMetrics.test_rows,
      validation.testRows,
      validation.test_rows,
    ),
    metrics: {
      mae: numberValue(forecastMetrics.mae, validationMetrics.mae, topMetrics.mae),
      rmse: numberValue(forecastMetrics.rmse, validationMetrics.rmse, topMetrics.rmse),
      r2: numberValue(forecastMetrics.r2, validationMetrics.r2, topMetrics.r2),
      smape: numberValue(forecastMetrics.smape, validationMetrics.smape, topMetrics.smape),
    },
    forecast,
    anomalies: listOfRecords(anomaliesEnvelope.data ?? source.anomalyData ?? source.anomaly_data),
    anomalyModel: textValue(anomaliesEnvelope.model),
    segments: listOfRecords(segmentsEnvelope.data ?? source.segmentData ?? source.segment_data),
    segmentModel: textValue(segmentsEnvelope.model),
    warnings,
    candidateModels,
    classifications,
  };
};

const formatNumber = (value: number | undefined, maximumFractionDigits = 2): string => (
  value === undefined
    ? '—'
    : new Intl.NumberFormat('tr-TR', { maximumFractionDigits }).format(value)
);

const formatPercent = (value: number | undefined): string => {
  if (value === undefined) return '—';
  const percent = Math.abs(value) <= 1 ? value * 100 : value;
  return `%${new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format(percent)}`;
};

const normalizedColumnName = (value: string): string => (
  value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
);

const friendlyTargetLabel = (target: string): string => {
  const normalized = normalizedColumnName(target);
  const isCount = /adet|quantity|qty|miktar|count/.test(normalized);
  const isMoney = /tutar|amount|ciro|revenue|gelir|kazanc|kar|profit/.test(normalized);

  if (/satis|sales/.test(normalized)) {
    if (isCount) return 'satış adedi';
    if (isMoney) return 'satış tutarı';
    return 'satış';
  }
  if (/siparis|order/.test(normalized)) return isMoney ? 'sipariş tutarı' : 'sipariş adedi';
  if (/talep|demand/.test(normalized)) return 'talep';
  if (/ciro|revenue/.test(normalized)) return 'ciro';
  if (/gelir|income/.test(normalized)) return 'gelir';
  if (/kar|profit/.test(normalized)) return 'kâr';

  return target.replace(/[_-]+/g, ' ').trim().toLocaleLowerCase('tr-TR') || 'seçilen değer';
};

const isAdditiveTarget = (target: string): boolean => (
  /satis|sales|siparis|order|talep|demand|adet|quantity|qty|miktar|count|tutar|amount|ciro|revenue|gelir|income|kazanc|kar|profit|maliyet|cost/.test(normalizedColumnName(target))
);

interface BusinessForecastSummary {
  headline: string;
  windowLabel: string;
  valueLabel: string;
  value: string;
  trendLabel: string;
  trendDetail: string;
  trend: 'up' | 'down' | 'flat';
  range: string;
  action: string;
}

const isMoneyTarget = (target: string): boolean => (
  /tutar|amount|ciro|revenue|gelir|income|kazanc|kar|profit|maliyet|cost|fiyat|price|bakiye|balance|nakit|cash/.test(normalizedColumnName(target))
);

const isCountTarget = (target: string): boolean => (
  /adet|quantity|qty|miktar|count|satis|sales|siparis|order|talep|demand/.test(normalizedColumnName(target)) && !isMoneyTarget(target)
);

const formatBusinessValue = (value: number, target: string): string => {
  if (isMoneyTarget(target)) {
    return new Intl.NumberFormat('tr-TR', {
      style: 'currency',
      currency: 'TRY',
      maximumFractionDigits: 2,
    }).format(value);
  }
  return `${formatNumber(value)}${isCountTarget(target) ? ' adet' : ''}`;
};

const forecastDate = (value: string): Date | null => {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatForecastPeriod = (value: string): string => {
  const date = forecastDate(value);
  return date
    ? new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)
    : value.replace(/^row\s*/i, 'Kayıt ').replace(/^dönem\s*/i, 'Dönem ');
};

const forecastWindowLabel = (forecast: ForecastPoint[]): string => {
  const first = forecastDate(forecast[0]?.row || '');
  const last = forecastDate(forecast.at(-1)?.row || '');
  if (!first || !last) return `Önümüzdeki ${forecast.length} dönem`;
  const formatter = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  if (first.getTime() === last.getTime()) return formatter.format(first);
  return `${formatter.format(first)} – ${formatter.format(last)}`;
};

const buildBusinessForecastSummary = (result: AnalysisResult, fallbackTarget: string): BusinessForecastSummary | null => {
  if (result.forecast.length === 0) return null;

  const target = result.targetColumn || fallbackTarget;
  const targetLabel = friendlyTargetLabel(target);
  const additive = isAdditiveTarget(target);
  const predicted = result.forecast.map((point) => point.predicted);
  const total = predicted.reduce((sum, value) => sum + value, 0);
  const centralValue = additive ? total : total / predicted.length;
  const first = predicted[0];
  const last = predicted[predicted.length - 1];
  const change = first === 0 ? undefined : ((last - first) / Math.abs(first)) * 100;
  const trend: BusinessForecastSummary['trend'] = change === undefined || Math.abs(change) < 2 ? 'flat' : change > 0 ? 'up' : 'down';
  const lowerValues = result.forecast.map((point) => point.lower).filter((value): value is number => value !== undefined);
  const upperValues = result.forecast.map((point) => point.upper).filter((value): value is number => value !== undefined);
  const hasCompleteRange = lowerValues.length === predicted.length && upperValues.length === predicted.length;
  const lower = hasCompleteRange
    ? lowerValues.reduce((sum, value) => sum + value, 0) / (additive ? 1 : lowerValues.length)
    : undefined;
  const upper = hasCompleteRange
    ? upperValues.reduce((sum, value) => sum + value, 0) / (additive ? 1 : upperValues.length)
    : undefined;
  const formattedValue = formatBusinessValue(centralValue, target);
  const periodCount = result.forecast.length;
  const windowLabel = forecastWindowLabel(result.forecast);
  const firstDate = forecastDate(result.forecast[0]?.row || '');
  const lastDate = forecastDate(result.forecast.at(-1)?.row || '');
  const windowPhrase = firstDate && lastDate
    ? firstDate.getTime() === lastDate.getTime() ? `${windowLabel} tarihinde` : `${windowLabel} arasında`
    : `Önümüzdeki ${periodCount} dönemde`;

  const headline = targetLabel === 'satış adedi' || targetLabel === 'satış'
    ? `${windowPhrase} yaklaşık ${formattedValue} satış bekleniyor.`
    : additive
      ? `${windowPhrase} toplam ${targetLabel} için yaklaşık ${formattedValue} bekleniyor.`
      : `${windowPhrase} dönem başına ortalama ${formattedValue} ${targetLabel} bekleniyor.`;

  const trendDetail = change === undefined
    ? 'Başlangıç değeri sıfır olduğu için değişim oranı hesaplanamadı.'
    : trend === 'flat'
      ? `İlk ve son dönem arasında belirgin bir değişim beklenmiyor (%${formatNumber(Math.abs(change), 1)}).`
      : `İlk dönemden son döneme %${formatNumber(Math.abs(change), 1)} ${trend === 'up' ? 'artış' : 'azalış'} bekleniyor.`;

  const action = trend === 'up'
    ? `${targetLabel.charAt(0).toLocaleUpperCase('tr-TR') + targetLabel.slice(1)} artışına hazırlanmak için stok, ekip ve hizmet kapasitenizi gözden geçirin.`
    : trend === 'down'
      ? `${targetLabel.charAt(0).toLocaleUpperCase('tr-TR') + targetLabel.slice(1)} düşüşüne karşı fiyat, kampanya ve müşteri kaybı nedenlerini erkenden inceleyin.`
      : 'Görünüm dengeli. Mevcut planı koruyun ve gerçekleşen sonuçları her dönem tahminle karşılaştırın.';

  return {
    headline,
    windowLabel,
    valueLabel: additive ? `Beklenen toplam ${targetLabel}` : `Ortalama ${targetLabel}`,
    value: formattedValue,
    trendLabel: trend === 'up' ? 'Yükseliş bekleniyor' : trend === 'down' ? 'Düşüş bekleniyor' : 'Dengeli görünüm',
    trendDetail,
    trend,
    range: lower !== undefined && upper !== undefined
      ? `${formatBusinessValue(lower, target)} – ${formatBusinessValue(upper, target)}`
      : 'Yeterli aralık bilgisi yok',
    action,
  };
};

const candidateModelLabel = (candidate: CandidateModelMetric): string => ({
  linear_trend: 'Doğrusal trend',
  naive_last_value: 'Son değer yaklaşımı',
  moving_average_3: '3 dönemli hareketli ortalama',
  seasonal_naive: 'Mevsimsel tekrar modeli',
}[candidate.model] || candidate.label || candidate.model);

const waitForNextPoll = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) {
    reject(new DOMException('İstek iptal edildi.', 'AbortError'));
    return;
  }
  const handleAbort = () => {
    clearTimeout(timer);
    reject(new DOMException('İstek iptal edildi.', 'AbortError'));
  };
  const timer = window.setTimeout(() => {
    signal.removeEventListener('abort', handleAbort);
    resolve();
  }, POLL_INTERVAL_MS);
  signal.addEventListener('abort', handleAbort, { once: true });
});

const resolveStatusUrl = (statusUrl: string): string => {
  const apiRoot = new URL(getApiUrl('/'));
  const resolved = new URL(statusUrl, apiRoot);
  if (resolved.origin !== apiRoot.origin) {
    throw new Error('ML işi için geçersiz durum adresi döndürüldü.');
  }
  return resolved.toString();
};

export default function AnalysisStudio({
  profile,
  datasetFilename,
  datasetCount,
  isDark,
}: AnalysisStudioProps) {
  const numericColumns = useMemo(() => (
    profile?.columns.filter((column) => column.type === 'numeric' || column.type === 'currency') || []
  ), [profile]);
  const useCasePresets = useMemo(() => {
    const normalized = (value: string) => value.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i');
    const find = (pattern: RegExp) => numericColumns.find((column) => pattern.test(normalized(column.name)));
    return [
      { key: 'demand', label: 'Talep / Satış Tahmini', column: find(/talep|demand|adet|quantity|qty|satis|sales/) },
      { key: 'cash', label: 'Nakit Akışı', column: find(/nakit|cash|bakiye|balance|net|ciro|gelir|revenue|amount|tutar/) },
      { key: 'churn', label: 'Churn Riski', column: find(/churn|kayip|terk|iptal|turnover|attrition/) },
    ].filter((preset): preset is { key: string; label: string; column: AnalysisProfile['columns'][number] } => Boolean(preset.column));
  }, [numericColumns]);
  const [targetColumn, setTargetColumn] = useState('');
  const [periods, setPeriods] = useState(3);
  const [isRunning, setIsRunning] = useState(false);
  const [jobState, setJobState] = useState<JobState | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [interpretation, setInterpretation] = useState<InterpretationResult | null>(null);
  const [isInterpreting, setIsInterpreting] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [actionNotice, setActionNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    setTargetColumn((current) => (
      numericColumns.some((column) => column.name === current) ? current : numericColumns[0]?.name || ''
    ));
  }, [numericColumns]);

  useEffect(() => () => activeRequest.current?.abort(), []);

  const pollJob = async (statusUrl: string, signal: AbortSignal): Promise<unknown> => {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    const url = resolveStatusUrl(statusUrl);

    while (Date.now() < deadline) {
      const response = await fetch(url, { headers: authHeaders(), signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(payload, 'ML işinin durumu alınamadı.'));
      if (!isRecord(payload)) throw new Error('ML işi geçersiz bir durum yanıtı döndürdü.');

      const status = textValue(payload.status)?.toLowerCase() as JobState | undefined;
      if (status === 'completed') {
        setJobState('completed');
        if (!payload.result) throw new Error('ML işi tamamlandı ancak analiz sonucu bulunamadı.');
        return payload.result;
      }
      if (status === 'failed') {
        setJobState('failed');
        throw new Error(responseError(payload, 'ML analizi tamamlanamadı.'));
      }
      if (status !== 'queued' && status !== 'running') {
        throw new Error('ML işi bilinmeyen bir durumda döndü.');
      }

      setJobState(status);
      await waitForNextPoll(signal);
    }

    throw new Error('ML analizi beklenen sürede tamamlanmadı. Lütfen yeniden deneyin.');
  };

  const runAnalysis = async () => {
    if (!targetColumn || periods < 1 || periods > 12 || isRunning) return;

    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setIsRunning(true);
    setJobState(null);
    setError('');
    setResult(null);
    setInterpretation(null);
    setActionNotice(null);

    try {
      const response = await fetch(getApiUrl('/api/ml/analyze'), {
        method: 'POST',
        headers: { ...jsonHeaders(), ...authHeaders() },
        body: JSON.stringify({ target_column: targetColumn, periods }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(payload, 'ML analizi başlatılamadı.'));

      let completedPayload: unknown = payload;
      if (response.status === 202) {
        if (!isRecord(payload)) throw new Error('ML kuyruğu geçersiz bir yanıt döndürdü.');
        const statusUrl = textValue(payload.statusUrl, payload.status_url);
        if (!statusUrl) throw new Error('ML işi için durum adresi döndürülmedi.');
        setJobState(textValue(payload.status)?.toLowerCase() === 'running' ? 'running' : 'queued');
        completedPayload = await pollJob(statusUrl, controller.signal);
      }

      const normalized = normalizeAnalysisResult(completedPayload);
      setResult(normalized);
      setJobState('completed');
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
      setJobState('failed');
      setError(requestError instanceof Error ? requestError.message : 'ML analizi tamamlanamadı.');
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setIsRunning(false);
      }
    }
  };

  const interpretAnalysis = async () => {
    if (!result?.analysisRunId || isInterpreting) return;
    setIsInterpreting(true);
    setActionNotice(null);
    try {
      const response = await fetch(getApiUrl(`/api/ml/analyses/${encodeURIComponent(result.analysisRunId)}/interpret`), {
        method: 'POST',
        headers: { ...jsonHeaders(), ...authHeaders() },
        body: JSON.stringify({ refresh: true }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(payload, 'Sonuç açıklanamadı.'));
      if (!isRecord(payload)) throw new Error('Sonuç açıklaması alınamadı.');
      const text = textValue(payload.interpretation);
      if (!text) throw new Error('Sonuç açıklaması boş geldi.');
      setInterpretation({
        text,
        provider: textValue(payload.provider),
        model: textValue(payload.model),
        cached: payload.cached === true,
      });
    } catch (interpretError) {
      setActionNotice({ type: 'error', text: interpretError instanceof Error ? interpretError.message : 'Sonuç açıklanamadı.' });
    } finally {
      setIsInterpreting(false);
    }
  };

  const downloadAnalysisReport = async () => {
    if (!result?.analysisRunId || isDownloading) return;
    setIsDownloading(true);
    setActionNotice(null);
    try {
      const response = await fetch(
        getApiUrl(`/reports/download?type=analysis&analysisId=${encodeURIComponent(result.analysisRunId)}`),
        { headers: authHeaders() },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(responseError(payload, 'Analiz raporu indirilemedi.'));
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const disposition = response.headers.get('content-disposition') || '';
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `analiz-${result.analysisRunId}.csv`;
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      setActionNotice({ type: 'success', text: 'Analiz raporu indirildi.' });
    } catch (downloadError) {
      setActionNotice({ type: 'error', text: downloadError instanceof Error ? downloadError.message : 'Analiz raporu indirilemedi.' });
    } finally {
      setIsDownloading(false);
    }
  };

  const chartTooltipStyle = isDark
    ? { backgroundColor: '#111', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '10px', color: '#fff', fontSize: '12px' }
    : { backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '10px', color: '#0f172a', fontSize: '12px' };

  const businessForecast = useMemo(
    () => result ? buildBusinessForecastSummary(result, targetColumn) : null,
    [result, targetColumn],
  );

  const metricCards = result ? [
    { label: 'MAE', value: formatNumber(result.metrics.mae), helper: 'Ortalama mutlak hata' },
    { label: 'RMSE', value: formatNumber(result.metrics.rmse), helper: 'Büyük hataları daha fazla ağırlıklandırır' },
    { label: 'R²', value: formatNumber(result.metrics.r2, 3), helper: 'Test verisinde açıklanan varyans' },
    { label: 'SMAPE', value: result.metrics.smape === undefined ? '—' : `%${formatNumber(result.metrics.smape)}`, helper: 'Simetrik yüzde hata' },
  ] : [];

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5 md:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-indigo-600 dark:text-[#FFD700]">
              <Sparkles className="h-4 w-4" />
              Geleceğe daha hazırlıklı olun
            </div>
            <h3 className="mt-2 text-xl font-bold text-slate-900 dark:text-white md:text-2xl">Gelecek Tahmini</h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-white/50">
              Neyi merak ettiğinizi seçin. Beklenen sonucu, hangi tarihler için geçerli olduğunu ve ne yapabileceğinizi açıkça gösterelim.
            </p>
            {profile && (
              <p className="mt-3 text-xs text-slate-400 dark:text-white/35">
                {datasetFilename || 'Birlikte incelenen veriler'} · {datasetCount === undefined ? 'Kaynak sayısı bilinmiyor' : `${datasetCount} veri kaynağı`} · {profile.rowCount.toLocaleString('tr-TR')} kayıt · Tahmin edilebilecek {numericColumns.length} bilgi
              </p>
            )}
            {useCasePresets.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2" aria-label="Hazır analiz şablonları">
                {useCasePresets.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    disabled={isRunning}
                    onClick={() => setTargetColumn(preset.column.name)}
                    className={cn(
                      'rounded-full border px-3 py-1.5 text-[10px] font-bold transition-colors',
                      targetColumn === preset.column.name
                        ? 'border-indigo-600 bg-indigo-600 text-white dark:border-[#FFD700] dark:bg-[#FFD700] dark:text-black'
                        : 'border-slate-200 text-slate-600 hover:border-indigo-300 dark:border-white/10 dark:text-white/55 dark:hover:border-[#FFD700]/40',
                    )}
                  >
                  {preset.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_150px_auto] lg:max-w-3xl">
            <label className="block min-w-0">
              <span className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-white/45">Neyi tahmin edelim?</span>
              <select
                value={targetColumn}
                onChange={(event) => setTargetColumn(event.target.value)}
                disabled={isRunning || numericColumns.length === 0}
                className="min-h-11 w-full rounded-xl border border-slate-300 bg-slate-50 px-3 text-sm font-semibold text-slate-900 outline-none focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/10 dark:bg-[#171717] dark:text-white dark:focus:border-[#FFD700]"
              >
                {numericColumns.length === 0 && <option value="">Tahmin edilebilecek bilgi yok</option>}
                {numericColumns.map((column) => <option key={column.name} value={column.name}>{friendlyTargetLabel(column.name)}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-white/45">Ne kadar ileri bakalım?</span>
              <select
                value={periods}
                onChange={(event) => setPeriods(Number(event.target.value))}
                disabled={isRunning}
                className="min-h-11 w-full rounded-xl border border-slate-300 bg-slate-50 px-3 text-sm font-semibold text-slate-900 outline-none focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/10 dark:bg-[#171717] dark:text-white dark:focus:border-[#FFD700]"
              >
                {Array.from({ length: 12 }, (_, index) => index + 1).map((period) => (
                  <option key={period} value={period}>{period} adım</option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={() => void runAnalysis()}
              disabled={!profile || !targetColumn || isRunning}
              className="inline-flex min-h-11 items-center justify-center gap-2 self-end rounded-xl bg-indigo-600 px-5 text-xs font-bold uppercase tracking-wider text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-[#FFD700] dark:text-black dark:hover:bg-[#ffe24d]"
            >
              {isRunning ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {isRunning ? 'Hazırlanıyor' : 'Tahmini Hesapla'}
            </button>
          </div>
        </div>
        <p className="mt-3 text-[11px] leading-5 text-slate-400 dark:text-white/35">Bir adım, dosyanızdaki tarih düzenine göre bir gün, hafta veya ayı ifade eder. Sonuç ekranında gerçek tarih aralığı gösterilir.</p>
      </section>

      {!profile && (
        <div className="flex min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white px-6 text-center dark:border-white/10 dark:bg-white/5">
          <FileSearch className="h-9 w-9 text-slate-300 dark:text-white/20" />
          <p className="mt-4 text-sm font-bold text-slate-800 dark:text-white">Tahmin için veri bulunamadı</p>
          <p className="mt-1 text-xs text-slate-500 dark:text-white/40">Önce Verilerim bölümünden bir dosya yükleyin.</p>
        </div>
      )}

      {profile && numericColumns.length === 0 && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          Bu dosyada tahmin edilebilecek sayısal bir bilgi bulunamadı. Satış adedi, satış tutarı veya ciro gibi bir sütun içeren dosya yükleyin.
        </div>
      )}

      {isRunning && (
        <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm font-semibold text-indigo-700 dark:border-[#FFD700]/20 dark:bg-[#FFD700]/10 dark:text-[#FFD700]">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          {jobState === 'running' ? 'Veriler inceleniyor ve gelecek tahmini hazırlanıyor…' : jobState === 'queued' ? 'Tahmininiz sıraya alındı…' : 'Sonuçlar hazırlanıyor…'}
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {actionNotice && (
        <div role={actionNotice.type === 'error' ? 'alert' : 'status'} className={cn(
          'flex items-start gap-3 rounded-xl border px-4 py-3 text-sm',
          actionNotice.type === 'error'
            ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300'
            : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300',
        )}>
          {actionNotice.type === 'error' ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{actionNotice.text}</span>
        </div>
      )}

      {result && (
        <>
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5 md:p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-bold text-slate-900 dark:text-white">Tahmin Sonucunuz</h3>
                  <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">Hazır</span>
                </div>
                <p className="mt-2 text-sm text-slate-500 dark:text-white/50">
                  {result.datasetFilename || 'İncelenen veriler'} · {result.datasetCount === undefined ? 'Tek veri kaynağı' : `${result.datasetCount} veri kaynağı`} · Tahmin edilen: <strong className="text-slate-800 dark:text-white">{friendlyTargetLabel(result.targetColumn || targetColumn)}</strong>
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void interpretAnalysis()}
                  disabled={!result.analysisRunId || isInterpreting}
                  title={!result.analysisRunId ? 'Bu sonuç için açıklama oluşturulamıyor' : undefined}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-[#FFD700] dark:text-black dark:hover:bg-[#ffe24d]"
                >
                  {isInterpreting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {isInterpreting ? 'Hazırlanıyor' : interpretation ? 'İş Önerisini Yenile' : 'İş İçin Öneri Al'}
                </button>
                <button
                  type="button"
                  onClick={() => void downloadAnalysisReport()}
                  disabled={!result.analysisRunId || isDownloading}
                  title={!result.analysisRunId ? 'Bu sonuç için rapor oluşturulamıyor' : undefined}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-300 px-4 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/15 dark:text-white/75 dark:hover:bg-white/10"
                >
                  {isDownloading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  {isDownloading ? 'Hazırlanıyor' : 'Raporu İndir'}
                </button>
              </div>
            </div>

            {businessForecast ? (
              <div className="mt-6 overflow-hidden rounded-2xl border border-indigo-100 bg-gradient-to-br from-indigo-50 via-white to-emerald-50 p-5 dark:border-[#FFD700]/20 dark:from-[#FFD700]/10 dark:via-white/[0.03] dark:to-emerald-500/10 md:p-6">
                <div className="flex items-start gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-200 dark:bg-[#FFD700] dark:text-black dark:shadow-none">
                    {businessForecast.trend === 'up' ? <TrendingUp className="h-5 w-5" /> : businessForecast.trend === 'down' ? <TrendingDown className="h-5 w-5" /> : <Minus className="h-5 w-5" />}
                  </span>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-indigo-600 dark:text-[#FFD700]">Kısa cevap</p>
                    <h2 className="mt-1 max-w-4xl text-xl font-black leading-snug text-slate-900 dark:text-white md:text-2xl">{businessForecast.headline}</h2>
                  </div>
                </div>

                <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-white bg-white/80 p-4 shadow-sm dark:border-white/10 dark:bg-black/20">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{businessForecast.valueLabel}</p>
                    <p className="mt-2 text-2xl font-black text-slate-900 dark:text-white">{businessForecast.value}</p>
                  </div>
                  <div className="rounded-xl border border-white bg-white/80 p-4 shadow-sm dark:border-white/10 dark:bg-black/20">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Değişimin yönü</p>
                    <p className={cn('mt-2 text-base font-black', businessForecast.trend === 'up' ? 'text-emerald-600 dark:text-emerald-400' : businessForecast.trend === 'down' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-white')}>{businessForecast.trendLabel}</p>
                    <p className="mt-1 text-[10px] leading-4 text-slate-500 dark:text-white/45">{businessForecast.trendDetail}</p>
                  </div>
                  <div className="rounded-xl border border-white bg-white/80 p-4 shadow-sm dark:border-white/10 dark:bg-black/20">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Olası sonuç aralığı</p>
                    <p className="mt-2 text-lg font-black text-slate-900 dark:text-white">{businessForecast.range}</p>
                    <p className="mt-1 text-[10px] leading-4 text-slate-500 dark:text-white/45">Gerçek sonuçlar kampanya, fiyat ve stok gibi değişikliklerden etkilenebilir.</p>
                  </div>
                </div>

                <div className="mt-4 flex items-start gap-3 rounded-xl bg-indigo-600 px-4 py-3 text-white dark:bg-[#FFD700] dark:text-black">
                  <Lightbulb className="mt-0.5 h-5 w-5 shrink-0" />
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-wider opacity-70">Önerilen adım</p>
                    <p className="mt-1 text-sm font-semibold leading-5">{businessForecast.action}</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-6 rounded-xl border border-dashed border-slate-300 px-5 py-8 text-center text-sm text-slate-500 dark:border-white/10 dark:text-white/40">Gelecek dönemlere ait yeterli sonuç üretilemedi.</div>
            )}

            <details className="group mt-5 rounded-xl border border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-black/20">
              <summary className="cursor-pointer list-none px-4 py-3 text-xs font-bold text-slate-600 marker:hidden dark:text-white/60">
                <span className="flex items-center justify-between gap-3">
                  Nasıl hesaplandığını göster
                  <span className="text-[10px] font-medium text-slate-400 group-open:hidden">İsteğe bağlı</span>
                  <span className="hidden text-[10px] font-medium text-slate-400 group-open:inline">Gizle</span>
                </span>
              </summary>
              <div className="border-t border-slate-200 p-4 dark:border-white/10">
                <p className="text-xs text-slate-500 dark:text-white/45">
                  Kullanılan yöntem: <strong>{result.selectedModel ? candidateModelLabel({ model: result.selectedModel, selected: true }) : result.modelName || 'Bilgi yok'}</strong>
                </p>
                <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                  {metricCards.map((metric) => (
                    <div key={metric.label} className="rounded-xl border border-slate-200 bg-white p-4 dark:border-white/5 dark:bg-white/5">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-white/35">{metric.label}</p>
                      <p className="mt-2 text-xl font-black text-slate-900 dark:text-white">{metric.value}</p>
                      <p className="mt-1 text-[10px] leading-4 text-slate-400 dark:text-white/35">{metric.helper}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-white/5"><p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Öğrenme verisi</p><p className="mt-1 text-lg font-bold text-slate-900 dark:text-white">{result.trainRows === undefined ? '—' : `${result.trainRows.toLocaleString('tr-TR')} kayıt`}</p></div>
                  <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-white/5"><p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Kontrol verisi</p><p className="mt-1 text-lg font-bold text-slate-900 dark:text-white">{result.testRows === undefined ? '—' : `${result.testRows.toLocaleString('tr-TR')} kayıt`}</p></div>
                  <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-white/5"><p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Tahmin güveni</p><p className="mt-1 text-lg font-bold text-indigo-600 dark:text-[#FFD700]">{formatPercent(result.confidence)}</p></div>
                </div>
                {result.candidateModels.length > 0 && (
                  <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-white/10 dark:bg-white/5">
                    <table className="w-full min-w-[560px] text-left text-xs">
                      <thead className="text-[9px] uppercase tracking-wider text-slate-400 dark:text-white/30"><tr><th className="px-4 py-2.5 font-bold">Yöntem</th><th className="px-3 py-2.5 font-bold">MAE</th><th className="px-3 py-2.5 font-bold">RMSE</th><th className="px-3 py-2.5 font-bold">SMAPE</th><th className="px-4 py-2.5 text-right font-bold">Durum</th></tr></thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                        {result.candidateModels.map((candidate) => (
                          <tr key={candidate.model} className={candidate.selected ? 'bg-emerald-50/60 dark:bg-emerald-500/5' : undefined}>
                            <td className="px-4 py-3 font-semibold text-slate-700 dark:text-white/70">{candidateModelLabel(candidate)}</td><td className="px-3 py-3 text-slate-500 dark:text-white/45">{formatNumber(candidate.mae)}</td><td className="px-3 py-3 text-slate-500 dark:text-white/45">{formatNumber(candidate.rmse)}</td><td className="px-3 py-3 text-slate-500 dark:text-white/45">{candidate.smape === undefined ? '—' : `%${formatNumber(candidate.smape)}`}</td><td className="px-4 py-3 text-right text-[9px] font-bold text-slate-400">{candidate.selected ? 'Kullanıldı' : 'Karşılaştırıldı'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </details>
          </section>

          {interpretation && (
            <section className="rounded-2xl border border-indigo-200 bg-indigo-50/70 p-5 shadow-sm dark:border-[#FFD700]/20 dark:bg-[#FFD700]/10 md:p-6">
              <h3 className="flex items-center gap-2 text-base font-bold text-indigo-900 dark:text-[#FFD700]"><Sparkles className="h-5 w-5" /> Bunun işiniz için anlamı</h3>
              <p className="mt-1 text-xs text-indigo-700/65 dark:text-white/45">Beklenen sonuç, önemli değişimler ve atabileceğiniz adımlar sade bir dille özetlendi.</p>
              <MarkdownContent content={interpretation.text} className="mt-4 text-sm text-slate-700 dark:text-white/75" />
            </section>
          )}

          {result.warnings.length > 0 && (
            <section aria-label="Analiz uyarıları" className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
              <h3 className="flex items-center gap-2 text-sm font-bold"><AlertCircle className="h-4 w-4" /> Dikkat edilmesi gerekenler</h3>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-5">
                {result.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
              </ul>
            </section>
          )}

          {result.classifications.map((classification) => (
            <section key={classification.useCase} className="rounded-2xl border border-violet-200 bg-violet-50/60 p-5 shadow-sm dark:border-violet-500/20 dark:bg-violet-500/10 md:p-6">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="flex items-center gap-2 text-base font-bold text-violet-950 dark:text-violet-200"><Users className="h-5 w-5" /> {classification.label}</h3>
                  <p className="mt-1 text-xs text-violet-700/70 dark:text-violet-200/60">Hangi kayıtların daha fazla dikkat istediğini gösterir · İncelenen bilgi: {classification.targetColumn}</p>
                </div>
                <span className="rounded-full bg-violet-100 px-3 py-1 text-[10px] font-black uppercase text-violet-700 dark:bg-violet-500/20 dark:text-violet-200">Tahmin gücü {formatPercent(classification.confidence)}</span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  ['Doğruluk', classification.accuracy],
                  ['Bulunan risklerin doğruluğu', classification.precision],
                  ['Riskleri yakalama oranı', classification.recall],
                  ['Genel başarı', classification.f1],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-xl border border-violet-200/70 bg-white/70 p-3 dark:border-violet-500/15 dark:bg-black/15">
                    <p className="text-[9px] font-bold uppercase tracking-wider opacity-55">{String(label)}</p>
                    <p className="mt-1 text-xl font-black">{formatPercent(value as number | undefined)}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest opacity-55">Öncelikle kontrol edilecek kayıtlar</p>
                  <div className="mt-2 space-y-1.5">
                    {classification.risks.slice(0, 5).map((risk, index) => (
                      <div key={`${String(risk.row)}-${index}`} className="flex justify-between rounded-lg bg-white/70 px-3 py-2 text-xs dark:bg-black/15">
                        <span>Satır {Number(risk.row) + 1}</span><strong>{formatPercent(numberValue(risk.risk_score))}</strong>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest opacity-55">Sonucu en çok etkileyen bilgiler</p>
                  <div className="mt-2 space-y-1.5">
                    {classification.drivers.slice(0, 5).map((driver, index) => (
                      <div key={`${String(driver.feature)}-${index}`} className="flex justify-between gap-3 rounded-lg bg-white/70 px-3 py-2 text-xs dark:bg-black/15">
                        <span className="truncate">{textValue(driver.feature) || `Etken ${index + 1}`}</span><strong>{formatNumber(numberValue(driver.coefficient), 3)}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <p className="mt-4 text-[10px] opacity-55">Bu bölüm yalnız önceliklendirme içindir. Kişisel bilgiler sonuç ekranında gösterilmez.</p>
            </section>
          ))}

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5 md:p-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h3 className="flex items-center gap-2 text-base font-bold text-slate-900 dark:text-white"><BarChart3 className="h-5 w-5 text-indigo-500 dark:text-[#FFD700]" /> Beklenen Sonucun Zaman İçindeki Değişimi</h3>
                <p className="mt-1 text-xs text-slate-500 dark:text-white/40">{businessForecast?.windowLabel || `Önümüzdeki ${result.forecast.length} dönem`} için beklenen sonuç ve oluşabilecek düşük–yüksek aralık.</p>
              </div>
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{friendlyTargetLabel(result.targetColumn || targetColumn)}</span>
            </div>
            {result.forecast.length > 0 ? (
              <div className="mt-6 h-[300px] w-full md:h-[380px]" role="img" aria-label={`${result.targetColumn || targetColumn} için tahmin grafiği`}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={result.forecast} margin={{ top: 10, right: 12, left: -18, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDark ? '#27272a' : '#e2e8f0'} />
                    <XAxis dataKey="row" axisLine={false} tickLine={false} tick={{ fill: isDark ? '#a1a1aa' : '#64748b', fontSize: 11 }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fill: isDark ? '#a1a1aa' : '#64748b', fontSize: 10 }} />
                    <Tooltip contentStyle={chartTooltipStyle} formatter={(value: any, name: string) => [formatBusinessValue(numberValue(value) || 0, result.targetColumn || targetColumn), name]} />
                    <Legend wrapperStyle={{ fontSize: '11px' }} />
                    <Line type="monotone" dataKey="predicted" name="Beklenen sonuç" stroke={isDark ? '#FFD700' : '#4F46E5'} strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                    <Line type="monotone" dataKey="lower" name="Olası en düşük" stroke={isDark ? '#38bdf8' : '#0284c7'} strokeWidth={2} strokeDasharray="5 5" connectNulls={false} dot={false} />
                    <Line type="monotone" dataKey="upper" name="Olası en yüksek" stroke={isDark ? '#f472b6' : '#db2777'} strokeWidth={2} strokeDasharray="5 5" connectNulls={false} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="mt-5 rounded-xl border border-dashed border-slate-300 px-5 py-10 text-center text-sm text-slate-500 dark:border-white/10 dark:text-white/40">Sunucu tahmin noktası döndürmedi.</div>
            )}
            {result.forecast.length > 0 && (
              <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200 dark:border-white/10">
                <table className="w-full min-w-[560px] text-left text-xs">
                  <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 dark:bg-white/5 dark:text-white/40">
                    <tr><th className="px-4 py-3 font-bold">Tarih / dönem</th><th className="px-4 py-3 text-right font-bold">Beklenen</th><th className="px-4 py-3 text-right font-bold">Olası en düşük</th><th className="px-4 py-3 text-right font-bold">Olası en yüksek</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-white/10">
                    {result.forecast.map((point, index) => (
                      <tr key={`${point.row}-${index}`} className="bg-white even:bg-slate-50/60 dark:bg-transparent dark:even:bg-white/[0.025]">
                        <td className="px-4 py-3 font-semibold text-slate-700 dark:text-white/70">{formatForecastPeriod(point.row)}</td>
                        <td className="px-4 py-3 text-right font-black text-indigo-600 dark:text-[#FFD700]">{formatBusinessValue(point.predicted, result.targetColumn || targetColumn)}</td>
                        <td className="px-4 py-3 text-right text-slate-500 dark:text-white/45">{point.lower === undefined ? '—' : formatBusinessValue(point.lower, result.targetColumn || targetColumn)}</td>
                        <td className="px-4 py-3 text-right text-slate-500 dark:text-white/45">{point.upper === undefined ? '—' : formatBusinessValue(point.upper, result.targetColumn || targetColumn)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5">
              <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white"><Target className="h-4 w-4 text-pink-500" /> Dikkat Çeken Kayıtlar</h3>
              <p className="mt-1 text-[10px] text-slate-400 dark:text-white/35">Normalden farklı görünen {result.anomalies.length} sonuç bulundu</p>
              <div className="mt-4 space-y-2">
                {result.anomalies.slice(0, 6).map((anomaly, index) => (
                  <div key={`${textValue(anomaly.row, anomaly.label) || 'anomali'}-${index}`} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs dark:border-white/5 dark:bg-black/20">
                    <span className="truncate text-slate-700 dark:text-white/70">{textValue(anomaly.label, anomaly.row, anomaly.name) || `Bulgu ${index + 1}`}</span>
                    <strong className="text-pink-600 dark:text-pink-400">{formatNumber(numberValue(anomaly.score, anomaly.value), 4)}</strong>
                  </div>
                ))}
                {result.anomalies.length === 0 && <p className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-xs text-slate-400 dark:border-white/10 dark:text-white/35">Normalden farklı görünen bir kayıt bulunmadı.</p>}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5">
              <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white"><Users className="h-4 w-4 text-cyan-500" /> Benzer Kayıt Grupları</h3>
              <p className="mt-1 text-[10px] text-slate-400 dark:text-white/35">Birbirine benzeyen {result.segments.length} grup bulundu</p>
              <div className="mt-4 space-y-2">
                {result.segments.slice(0, 6).map((segment, index) => {
                  const averages = isRecord(segment.averages) ? segment.averages : {};
                  const averageSummary = Object.entries(averages).slice(0, 2).map(([key, value]) => `${key}: ${formatNumber(numberValue(value))}`).join(' · ');
                  return (
                    <div key={`${textValue(segment.label) || String(segment.segment ?? index)}-${index}`} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs dark:border-white/5 dark:bg-black/20">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-bold text-slate-700 dark:text-white/75">{textValue(segment.label, segment.name) || `Grup ${String(segment.segment ?? index + 1)}`}</span>
                        <strong className="text-cyan-600 dark:text-cyan-400">{numberValue(segment.count)?.toLocaleString('tr-TR') || '—'} kayıt</strong>
                      </div>
                      {averageSummary && <p className="mt-1 truncate text-[10px] text-slate-400 dark:text-white/35">{averageSummary}</p>}
                    </div>
                  );
                })}
                {result.segments.length === 0 && <p className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-xs text-slate-400 dark:border-white/10 dark:text-white/35">Benzer özelliklere sahip bir kayıt grubu oluşturulamadı.</p>}
              </div>
            </section>
          </div>

        </>
      )}
    </div>
  );
}
