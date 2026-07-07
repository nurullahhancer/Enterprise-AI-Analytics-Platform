import { Dataset, getUserDatasets } from '../../lib/db';
import { parseCsv } from '../ml/parser';

const SOURCE_COLUMN = 'kaynak_dosya';

export interface CombinedDataset {
  id: null;
  datasetIds: number[];
  filename: string;
  filenames: string[];
  file_content: string;
  row_count: number;
  column_count: number;
  dataset_count: number;
}

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function combineDatasets(datasets: Dataset[]): CombinedDataset | null {
  if (datasets.length === 0) return null;

  const headers: string[] = [];
  const seenHeaders = new Set<string>();
  const rows: Record<string, string>[] = [];
  const filenames: string[] = [];

  for (const dataset of datasets) {
    const parsed = parseCsv(dataset.file_content);
    const datasetHeaders = parsed[0] ?? [];
    const body = parsed.slice(1);

    filenames.push(dataset.filename);

    for (const header of datasetHeaders) {
      const normalized = header.trim() || `kolon_${headers.length + 1}`;
      if (!seenHeaders.has(normalized)) {
        seenHeaders.add(normalized);
        headers.push(normalized);
      }
    }

    for (const row of body) {
      const record: Record<string, string> = {};
      datasetHeaders.forEach((header, index) => {
        record[header.trim() || `kolon_${index + 1}`] = row[index] ?? '';
      });
      record[SOURCE_COLUMN] = dataset.filename;
      rows.push(record);
    }
  }

  if (!seenHeaders.has(SOURCE_COLUMN)) {
    headers.push(SOURCE_COLUMN);
  }

  const csvRows = [
    headers.map(escapeCsv).join(','),
    ...rows.map((row) => headers.map((header) => escapeCsv(row[header] ?? '')).join(','))
  ];

  return {
    id: null,
    datasetIds: datasets.map((dataset) => dataset.id),
    filename: datasets.length === 1 ? datasets[0].filename : `${datasets.length}-dosya-birlesik.csv`,
    filenames,
    file_content: csvRows.join('\n'),
    row_count: rows.length,
    column_count: headers.length,
    dataset_count: datasets.length
  };
}

export async function getCombinedUserDataset(email: string): Promise<CombinedDataset | null> {
  return combineDatasets(await getUserDatasets(email));
}
