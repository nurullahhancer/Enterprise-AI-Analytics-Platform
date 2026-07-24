import { Dataset, getUserDatasets } from '../../lib/db';
import { normalizeLabel, parseCsv } from '../ml/parser';

const SOURCE_COLUMN = 'kaynak_dosya';
const SOURCE_KEY = '__reai_source_file';

export class DatasetCompatibilityError extends Error {
  status = 422;
  code = 'INCOMPATIBLE_ANALYSIS_SCOPE';

  constructor(public readonly incompatibleFiles: string[]) {
    super(`Bu dosyalar farklı türde bilgiler içerdiği için birlikte incelenemedi: ${incompatibleFiles.join(', ')}. Verilerim ekranından ana dosyayı değiştirebilir veya dosyaları ayrı ayrı inceleyebilirsiniz.`);
    this.name = 'DatasetCompatibilityError';
  }
}

export interface CombinedDataset {
  id: null;
  datasetIds: number[];
  filename: string;
  filenames: string[];
  excluded_filenames: string[];
  file_content: string;
  row_count: number;
  column_count: number;
  dataset_count: number;
  selected_dataset_count: number;
}

interface PreparedDataset {
  dataset: Dataset;
  body: string[][];
  keys: string[];
  labels: Map<string, string>;
}

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function prepareDataset(dataset: Dataset): PreparedDataset {
  const sourceLabelKey = normalizeLabel(SOURCE_COLUMN);
  const parsed = parseCsv(dataset.file_content);
  const rawHeaders = parsed[0] ?? [];
  const keys: string[] = [];
  const labels = new Map<string, string>();
  const seen = new Set<string>();
  rawHeaders.forEach((rawHeader, index) => {
    const label = rawHeader.trim() || `kolon_${index + 1}`;
    const normalized = normalizeLabel(label) || `kolon_${index + 1}`;
    const key = normalized === sourceLabelKey ? `__input_${sourceLabelKey}` : normalized;
    if (seen.has(key)) {
      throw Object.assign(new Error(`${dataset.filename} içinde aynı anlama gelen birden fazla kolon var: ${label}.`), {
        status: 422,
        code: 'DUPLICATE_DATASET_COLUMN'
      });
    }
    seen.add(key);
    keys.push(key);
    labels.set(key, normalized === sourceLabelKey ? `${label}_veri` : label);
  });
  return { dataset, body: parsed.slice(1), keys, labels };
}

function minimumSchemaOverlap(): number {
  const configuredOverlap = Number(process.env.DATASET_SCHEMA_MIN_OVERLAP || 0.4);
  return Number.isFinite(configuredOverlap) ? Math.max(0.3, Math.min(configuredOverlap, 1)) : 0.4;
}

function schemaOverlap(reference: PreparedDataset, candidate: PreparedDataset): number {
  const referenceKeys = new Set(reference.keys);
  const current = new Set(candidate.keys);
  const shared = [...current].filter((key) => referenceKeys.has(key)).length;
  return shared / Math.max(1, Math.min(referenceKeys.size, current.size));
}

export function areDatasetSchemasCompatible(reference: Dataset, candidate: Dataset): boolean {
  return schemaOverlap(prepareDataset(reference), prepareDataset(candidate)) >= minimumSchemaOverlap();
}

function combinePreparedDatasets(prepared: PreparedDataset[], referenceDatasetId?: number): CombinedDataset | null {
  if (prepared.length === 0) return null;
  const datasets = prepared.map((item) => item.dataset);

  const reference = prepared.find((item) => item.dataset.id === referenceDatasetId) ?? prepared[0];
  const incompatibleFiles = prepared
    .filter((item) => item.dataset.id !== reference.dataset.id && schemaOverlap(reference, item) < minimumSchemaOverlap())
    .map((item) => item.dataset.filename);
  if (incompatibleFiles.length > 0) throw new DatasetCompatibilityError(incompatibleFiles);

  const headerKeys: string[] = [];
  const labels = new Map<string, string>();
  const seenHeaders = new Set<string>();
  const rows: Record<string, string>[] = [];
  const filenames: string[] = [];

  for (const item of prepared) {
    filenames.push(item.dataset.filename);

    for (const key of item.keys) {
      if (!seenHeaders.has(key)) {
        seenHeaders.add(key);
        headerKeys.push(key);
        labels.set(key, item.labels.get(key) || key);
      }
    }

    for (const row of item.body) {
      const record: Record<string, string> = {};
      item.keys.forEach((key, index) => {
        record[key] = row[index] ?? '';
      });
      record[SOURCE_KEY] = item.dataset.filename;
      rows.push(record);
    }
  }

  headerKeys.push(SOURCE_KEY);
  labels.set(SOURCE_KEY, SOURCE_COLUMN);

  const csvRows = [
    headerKeys.map((key) => escapeCsv(labels.get(key) || key)).join(','),
    ...rows.map((row) => headerKeys.map((key) => escapeCsv(row[key] ?? '')).join(','))
  ];

  return {
    id: null,
    datasetIds: datasets.map((dataset) => dataset.id),
    filename: datasets.length === 1 ? datasets[0].filename : `${datasets.length}-dosya-birlesik.csv`,
    filenames,
    excluded_filenames: [],
    file_content: csvRows.join('\n'),
    row_count: rows.length,
    column_count: headerKeys.length,
    dataset_count: datasets.length,
    selected_dataset_count: datasets.length
  };
}

export function combineDatasets(datasets: Dataset[], referenceDatasetId?: number): CombinedDataset | null {
  return combinePreparedDatasets(datasets.map(prepareDataset), referenceDatasetId);
}

export async function getCombinedUserDataset(organizationScope: string): Promise<CombinedDataset | null> {
  const selected = await getUserDatasets(organizationScope, true);
  if (selected.length === 0) return null;

  // The active (normally most recently uploaded) source anchors an analysis group.
  // Compatible sources are merged; unrelated sources remain stored and selectable
  // without making every dashboard, KPI and ML endpoint fail.
  const prepared = selected.map(prepareDataset);
  const reference = prepared.find((item) => item.dataset.is_active === 1) ?? prepared[prepared.length - 1];
  const compatible = prepared.filter((item) => (
    item.dataset.id === reference.dataset.id || schemaOverlap(reference, item) >= minimumSchemaOverlap()
  ));
  const compatibleIds = new Set(compatible.map((item) => item.dataset.id));
  const excluded = selected.filter((dataset) => !compatibleIds.has(dataset.id));
  const combined = combinePreparedDatasets(compatible, reference.dataset.id)!;
  return {
    ...combined,
    excluded_filenames: excluded.map((dataset) => dataset.filename),
    selected_dataset_count: selected.length
  };
}
