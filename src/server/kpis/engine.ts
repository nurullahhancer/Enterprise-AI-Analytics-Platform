import {
  KpiAggregation,
  KpiDefinition,
  KpiEvaluationValues,
  KpiThresholdType
} from '../../lib/kpiDb';
import { inferColumnKind, normalizeLabel, parseCsv, toNumber } from '../ml/parser';

export interface PreparedKpiDataset {
  headers: string[];
  normalizedHeaders: string[];
  rows: string[][];
}

export interface KpiColumnInspection {
  allColumns: string[];
  numericColumns: Array<{ name: string; nonEmptyCount: number }>;
}

type EvaluatedDefinition = Pick<
  KpiDefinition,
  'name' | 'columnName' | 'aggregation' | 'thresholdType' | 'thresholdValue'
>;

function aggregationLabel(aggregation: KpiAggregation): string {
  return {
    sum: 'toplam',
    average: 'ortalama',
    min: 'minimum',
    max: 'maksimum',
    count: 'dolu kayıt sayısı'
  }[aggregation];
}

function thresholdMessage(type: KpiThresholdType, threshold: number | null, healthy: boolean): string {
  if (type === 'none' || threshold === null) return 'Eşik tanımlı değil.';
  if (type === 'minimum') return `asgari ${threshold} eşiği ${healthy ? 'karşılandı' : 'altında kaldı'}.`;
  return `azami ${threshold} eşiği ${healthy ? 'korundu' : 'aşıldı'}.`;
}

export function prepareKpiDataset(content: string): PreparedKpiDataset {
  const parsed = parseCsv(content);
  const headers = (parsed[0] || []).map((header, index) => header.trim() || `kolon_${index + 1}`);
  return {
    headers,
    normalizedHeaders: headers.map(normalizeLabel),
    rows: parsed.slice(1)
  };
}

export function inspectKpiColumns(dataset: PreparedKpiDataset): KpiColumnInspection {
  const numericColumns: KpiColumnInspection['numericColumns'] = [];
  dataset.headers.forEach((name, index) => {
    const nonEmpty = dataset.rows
      .map((row) => row[index] ?? '')
      .filter((value) => value.trim().length > 0);
    const numericValues = nonEmpty.map(toNumber).filter((value): value is number => value !== null);
    const type = inferColumnKind(name, nonEmpty, numericValues);
    if (type === 'numeric' || type === 'currency') {
      numericColumns.push({ name, nonEmptyCount: nonEmpty.length });
    }
  });
  return { allColumns: dataset.headers, numericColumns };
}

export function unavailableKpiEvaluation(message: string): KpiEvaluationValues {
  return { value: null, status: 'unavailable', rowCount: 0, message: message.slice(0, 1_000) };
}

export function evaluateKpiDefinition(
  definition: EvaluatedDefinition,
  dataset: PreparedKpiDataset
): KpiEvaluationValues {
  const normalizedColumn = normalizeLabel(definition.columnName);
  const matchingIndexes = dataset.normalizedHeaders
    .map((header, index) => header === normalizedColumn ? index : -1)
    .filter((index) => index >= 0);

  if (matchingIndexes.length === 0) {
    return unavailableKpiEvaluation(`"${definition.columnName}" kolonu analiz kapsamındaki veride bulunamadı.`);
  }
  if (matchingIndexes.length > 1) {
    return unavailableKpiEvaluation(`"${definition.columnName}" kolonu veri içinde birden fazla kez bulunduğu için KPI hesaplanamadı.`);
  }

  const columnIndex = matchingIndexes[0];
  const rawValues = dataset.rows.map((row) => row[columnIndex] ?? '');
  const nonEmptyValues = rawValues.filter((value) => value.trim().length > 0);
  let value: number;
  let rowCount: number;
  let ignoredCount = 0;

  if (definition.aggregation === 'count') {
    value = nonEmptyValues.length;
    rowCount = nonEmptyValues.length;
  } else {
    const numericValues = nonEmptyValues
      .map(toNumber)
      .filter((item): item is number => item !== null);
    const columnType = inferColumnKind(definition.columnName, nonEmptyValues, numericValues);
    if (columnType === 'id') {
      return unavailableKpiEvaluation(`"${definition.columnName}" bir kimlik/referans alanıdır; toplam veya ortalama hesabına katılamaz. Yalnız kayıt sayımı için kullanılabilir.`);
    }
    if (columnType === 'datetime') {
      return unavailableKpiEvaluation(`"${definition.columnName}" bir tarih alanıdır; toplam veya ortalama hesabına katılamaz.`);
    }
    rowCount = numericValues.length;
    ignoredCount = nonEmptyValues.length - numericValues.length;
    if (numericValues.length === 0) {
      return unavailableKpiEvaluation(`"${definition.columnName}" kolonunda ${aggregationLabel(definition.aggregation)} için sayısal değer bulunamadı.`);
    }
    switch (definition.aggregation) {
      case 'sum':
        value = numericValues.reduce((total, item) => total + item, 0);
        break;
      case 'average':
        value = numericValues.reduce((total, item) => total + item, 0) / numericValues.length;
        break;
      case 'min':
        value = numericValues.reduce((minimum, item) => item < minimum ? item : minimum);
        break;
      case 'max':
        value = numericValues.reduce((maximum, item) => item > maximum ? item : maximum);
        break;
    }
  }

  if (!Number.isFinite(value)) {
    return unavailableKpiEvaluation('Hesaplanan KPI değeri sonlu bir sayı değil. Kaynak veriyi kontrol edin.');
  }

  const threshold = definition.thresholdValue;
  let healthy = true;
  if (definition.thresholdType === 'minimum') healthy = threshold !== null && value >= threshold;
  if (definition.thresholdType === 'maximum') healthy = threshold !== null && value <= threshold;

  const ignored = ignoredCount > 0 ? ` ${ignoredCount} sayısal olmayan dolu değer yok sayıldı.` : '';
  const message = `${definition.name}: ${rowCount} kayıtla ${aggregationLabel(definition.aggregation)} hesaplandı.${ignored} ${thresholdMessage(definition.thresholdType, threshold, healthy)}`;
  return {
    value,
    status: healthy ? 'healthy' : 'breach',
    rowCount,
    message
  };
}
