import { randomUUID } from 'node:crypto';
import { database } from './database';
import { databaseReady } from './db';

interface AnalysisRunRow {
  id: string;
  organization_id: string;
  email: string;
  dataset_ids_json: string;
  dataset_filename: string;
  target_column: string | null;
  periods: number;
  result_json: string;
  interpretation: string | null;
  ai_provider: string | null;
  ai_model: string | null;
  created_at: string;
  updated_at: string;
}

export interface AnalysisRun {
  id: string;
  organizationId: string;
  createdBy: string;
  datasetIds: number[];
  datasetFilename: string;
  targetColumn: string | null;
  periods: number;
  result: Record<string, unknown>;
  interpretation: string | null;
  aiProvider: string | null;
  aiModel: string | null;
  createdAt: string;
  updatedAt: string;
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name] || fallback);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function parseRun(row: AnalysisRunRow): AnalysisRun {
  let datasetIds: number[] = [];
  let result: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.dataset_ids_json);
    if (Array.isArray(parsed)) datasetIds = parsed.map(Number).filter(Number.isInteger);
  } catch {
    datasetIds = [];
  }
  try {
    const parsed = JSON.parse(row.result_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result = parsed;
  } catch {
    result = {};
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    createdBy: row.email,
    datasetIds,
    datasetFilename: row.dataset_filename,
    targetColumn: row.target_column,
    periods: Number(row.periods),
    result,
    interpretation: row.interpretation,
    aiProvider: row.ai_provider,
    aiModel: row.ai_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createAnalysisRun(input: {
  organizationId: string;
  createdBy: string;
  datasetIds: number[];
  datasetFilename: string;
  targetColumn: string | null;
  periods: number;
  result: Record<string, unknown>;
}): Promise<AnalysisRun> {
  await databaseReady;
  const resultJson = JSON.stringify(input.result);
  const maxResultChars = boundedInteger('ANALYSIS_RUN_MAX_RESULT_CHARS', 2_000_000, 100_000, 5_000_000);
  if (resultJson.length > maxResultChars) {
    throw Object.assign(new Error('Analiz sonucu kalıcı kayıt sınırını aşıyor.'), {
      status: 413,
      code: 'ANALYSIS_RESULT_TOO_LARGE'
    });
  }
  const id = `analysis_${randomUUID()}`;
  const maxRuns = boundedInteger('ANALYSIS_RUN_MAX_PER_ORG', 50, 5, 500);
  await database.tenantTransaction(input.organizationId, async (transaction) => {
    await transaction.run(
      `INSERT INTO analysis_runs
       (id, organization_id, email, dataset_ids_json, dataset_filename, target_column, periods, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.organizationId,
        input.createdBy,
        JSON.stringify(input.datasetIds),
        input.datasetFilename.slice(0, 240),
        input.targetColumn?.slice(0, 128) || null,
        input.periods,
        resultJson
      ]
    );
    const stale = await transaction.all<{ id: string }>(
      `SELECT id FROM analysis_runs WHERE organization_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 10000 OFFSET ?`,
      [input.organizationId, maxRuns]
    );
    for (const row of stale) {
      await transaction.run('DELETE FROM analysis_runs WHERE id = ? AND organization_id = ?', [row.id, input.organizationId]);
    }
  });
  const created = await getAnalysisRun(input.organizationId, id);
  if (!created) throw new Error('Analiz kaydı oluşturulamadı.');
  return created;
}

export async function getAnalysisRun(organizationId: string, id: string): Promise<AnalysisRun | null> {
  await databaseReady;
  const row = await database.tenantTransaction(organizationId, (transaction) => transaction.get<AnalysisRunRow>(
    'SELECT * FROM analysis_runs WHERE id = ? AND organization_id = ?',
    [id, organizationId]
  ));
  return row ? parseRun(row) : null;
}

export async function getLatestAnalysisRun(organizationId: string): Promise<AnalysisRun | null> {
  await databaseReady;
  const row = await database.tenantTransaction(organizationId, (transaction) => transaction.get<AnalysisRunRow>(
    'SELECT * FROM analysis_runs WHERE organization_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [organizationId]
  ));
  return row ? parseRun(row) : null;
}

export async function listAnalysisRuns(organizationId: string, limit = 20): Promise<AnalysisRun[]> {
  await databaseReady;
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  const rows = await database.tenantTransaction(organizationId, (transaction) => transaction.all<AnalysisRunRow>(
    `SELECT * FROM analysis_runs WHERE organization_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    [organizationId, safeLimit]
  ));
  return rows.map(parseRun);
}

export async function saveAnalysisInterpretation(
  organizationId: string,
  id: string,
  interpretation: string,
  provider: string,
  model: string
): Promise<boolean> {
  await databaseReady;
  return database.tenantTransaction(organizationId, async (transaction) => (
    await transaction.run(
      `UPDATE analysis_runs
       SET interpretation = ?, ai_provider = ?, ai_model = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`,
      [interpretation.slice(0, 50_000), provider.slice(0, 50), model.slice(0, 140), id, organizationId]
    )
  ).changes > 0);
}

export async function deleteAnalysisRun(organizationId: string, id: string): Promise<boolean> {
  await databaseReady;
  return database.tenantTransaction(organizationId, async (transaction) => (
    await transaction.run('DELETE FROM analysis_runs WHERE id = ? AND organization_id = ?', [id, organizationId])
  ).changes > 0);
}
