import {
  formatDateOnly,
  inferColumnKind,
  parseCsv,
  parseFlexibleDate,
  toNumber
} from '../ml/parser';

export const ETL_OPERATIONS = ['imputation', 'type_sync', 'anomaly_clean', 'dataset_merge'] as const;
export type EtlOperation = typeof ETL_OPERATIONS[number];

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function quantile(values: number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export interface EtlResult {
  csv: string;
  rowCount: number;
  columnCount: number;
  filledCells: number;
  removedRows: number;
  operations: EtlOperation[];
}

export function transformCsv(content: string, requestedOperations: string[]): EtlResult {
  const operations = [...new Set(requestedOperations)] as EtlOperation[];
  if (operations.length === 0 || operations.some((value) => !ETL_OPERATIONS.includes(value))) {
    throw new Error('Geçerli en az bir ETL adımı seçin.');
  }

  const parsed = parseCsv(content);
  const rawHeaders = parsed[0] ?? [];
  if (rawHeaders.length === 0) throw new Error('Veri kümesinde başlık satırı bulunamadı.');
  const headers = rawHeaders.map((header, index) => header.trim() || `kolon_${index + 1}`);
  if (new Set(headers).size !== headers.length) throw new Error('Aynı isimde birden fazla kolon bulunuyor.');

  let rows = parsed.slice(1).map((row) => headers.map((_, index) => (row[index] ?? '').trim()));
  if (rows.length === 0) throw new Error('Dönüştürülecek veri satırı bulunamadı.');

  const kinds = headers.map((header, index) => {
    const values = rows.map((row) => row[index]);
    return inferColumnKind(header, values, values.map(toNumber).filter((value): value is number => value !== null));
  });

  let filledCells = 0;
  if (operations.includes('imputation')) {
    kinds.forEach((kind, columnIndex) => {
      if (kind !== 'numeric' && kind !== 'currency') return;
      const values = rows.map((row) => toNumber(row[columnIndex])).filter((value): value is number => value !== null);
      if (values.length === 0) return;
      const median = quantile(values, 0.5);
      rows.forEach((row) => {
        if (row[columnIndex].trim() === '') {
          row[columnIndex] = String(Number(median.toFixed(6)));
          filledCells += 1;
        }
      });
    });
  }

  if (operations.includes('type_sync')) {
    rows = rows.map((row) => row.map((value, columnIndex) => {
      const kind = kinds[columnIndex];
      if (kind === 'numeric' || kind === 'currency') {
        const number = toNumber(value);
        return number === null ? value.trim() : String(number);
      }
      if (kind === 'datetime') {
        const date = parseFlexibleDate(value);
        return date ? formatDateOnly(date) : value.trim();
      }
      return value.trim();
    }));
  }

  const beforeAnomalyCleanup = rows.length;
  if (operations.includes('anomaly_clean') && rows.length >= 4) {
    const bounds = kinds.map((kind, columnIndex) => {
      if (kind !== 'numeric' && kind !== 'currency') return null;
      const values = rows.map((row) => toNumber(row[columnIndex])).filter((value): value is number => value !== null);
      if (values.length < 4) return null;
      const q1 = quantile(values, 0.25);
      const q3 = quantile(values, 0.75);
      const iqr = q3 - q1;
      return iqr === 0 ? null : { min: q1 - 1.5 * iqr, max: q3 + 1.5 * iqr };
    });
    rows = rows.filter((row) => bounds.every((bound, index) => {
      if (!bound) return true;
      const value = toNumber(row[index]);
      return value === null || (value >= bound.min && value <= bound.max);
    }));
  }

  const csv = [
    headers.map(csvCell).join(','),
    ...rows.map((row) => row.map(csvCell).join(','))
  ].join('\n');

  return {
    csv,
    rowCount: rows.length,
    columnCount: headers.length,
    filledCells,
    removedRows: beforeAnomalyCleanup - rows.length,
    operations
  };
}
