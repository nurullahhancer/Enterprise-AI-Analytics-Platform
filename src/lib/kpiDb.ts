import { randomUUID } from 'node:crypto';
import { database } from './database';
import { databaseReady } from './db';

export type KpiAggregation = 'sum' | 'average' | 'min' | 'max' | 'count';
export type KpiDisplayFormat = 'number' | 'currency' | 'percent';
export type KpiThresholdType = 'none' | 'minimum' | 'maximum';
export type KpiEvaluationStatus = 'healthy' | 'breach' | 'unavailable';

interface KpiDefinitionRow {
  id: string;
  organization_id: string;
  email: string;
  name: string;
  description: string;
  column_name: string;
  aggregation: KpiAggregation;
  display_format: KpiDisplayFormat;
  threshold_type: KpiThresholdType;
  threshold_value: number | string | null;
  enabled: number | boolean;
  created_at: string;
  updated_at: string;
}

interface KpiEvaluationRow {
  id: string;
  organization_id: string;
  kpi_id: string;
  email: string;
  value: number | string | null;
  status: KpiEvaluationStatus;
  row_count: number | string;
  message: string;
  evaluated_at: string;
}

interface KpiDefinitionLatestRow extends KpiDefinitionRow {
  latest_id: string | null;
  latest_email: string | null;
  latest_value: number | string | null;
  latest_status: KpiEvaluationStatus | null;
  latest_row_count: number | string | null;
  latest_message: string | null;
  latest_evaluated_at: string | null;
}

export interface KpiDefinition {
  id: string;
  organizationId: string;
  createdBy: string;
  name: string;
  description: string;
  columnName: string;
  aggregation: KpiAggregation;
  displayFormat: KpiDisplayFormat;
  thresholdType: KpiThresholdType;
  thresholdValue: number | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KpiEvaluation {
  id: string;
  organizationId: string;
  kpiId: string;
  evaluatedBy: string;
  value: number | null;
  status: KpiEvaluationStatus;
  rowCount: number;
  message: string;
  evaluatedAt: string;
}

export interface KpiDefinitionWithLatest extends KpiDefinition {
  latest: KpiEvaluation | null;
}

export interface KpiDefinitionValues {
  name: string;
  description: string;
  columnName: string;
  aggregation: KpiAggregation;
  displayFormat: KpiDisplayFormat;
  thresholdType: KpiThresholdType;
  thresholdValue: number | null;
  enabled: boolean;
}

export interface KpiEvaluationValues {
  value: number | null;
  status: KpiEvaluationStatus;
  rowCount: number;
  message: string;
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

function nullableNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDefinition(row: KpiDefinitionRow): KpiDefinition {
  return {
    id: row.id,
    organizationId: row.organization_id,
    createdBy: row.email,
    name: row.name,
    description: row.description,
    columnName: row.column_name,
    aggregation: row.aggregation,
    displayFormat: row.display_format,
    thresholdType: row.threshold_type,
    thresholdValue: nullableNumber(row.threshold_value),
    enabled: row.enabled === true || Number(row.enabled) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseEvaluation(row: KpiEvaluationRow): KpiEvaluation {
  return {
    id: row.id,
    organizationId: row.organization_id,
    kpiId: row.kpi_id,
    evaluatedBy: row.email,
    value: nullableNumber(row.value),
    status: row.status,
    rowCount: Number(row.row_count) || 0,
    message: row.message,
    evaluatedAt: row.evaluated_at
  };
}

function parseLatest(row: KpiDefinitionLatestRow): KpiEvaluation | null {
  if (!row.latest_id || !row.latest_status || !row.latest_evaluated_at) return null;
  return parseEvaluation({
    id: row.latest_id,
    organization_id: row.organization_id,
    kpi_id: row.id,
    email: row.latest_email || 'system@local',
    value: row.latest_value,
    status: row.latest_status,
    row_count: row.latest_row_count || 0,
    message: row.latest_message || '',
    evaluated_at: row.latest_evaluated_at
  });
}

export async function createKpiDefinition(
  organizationId: string,
  actorEmail: string,
  values: KpiDefinitionValues
): Promise<KpiDefinition> {
  await databaseReady;
  const id = `kpi_${randomUUID()}`;
  const maximum = boundedInteger('KPI_MAX_PER_ORG', 100, 1, 1_000);
  const created = await database.tenantTransaction(organizationId, async (transaction) => {
    const current = await transaction.get<{ count: number | string }>(
      'SELECT COUNT(*) AS count FROM kpi_definitions WHERE organization_id = ?',
      [organizationId]
    );
    if (Number(current?.count || 0) >= maximum) {
      throw Object.assign(
        new Error(`Organizasyon başına en fazla ${maximum} KPI tanımlanabilir.`),
        { status: 409, code: 'KPI_LIMIT_REACHED' }
      );
    }
    await transaction.run(
      `INSERT INTO kpi_definitions
       (id, organization_id, email, name, description, column_name, aggregation,
        display_format, threshold_type, threshold_value, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        organizationId,
        actorEmail,
        values.name,
        values.description,
        values.columnName,
        values.aggregation,
        values.displayFormat,
        values.thresholdType,
        values.thresholdValue,
        values.enabled ? 1 : 0
      ]
    );
    return transaction.get<KpiDefinitionRow>(
      'SELECT * FROM kpi_definitions WHERE id = ? AND organization_id = ?',
      [id, organizationId]
    );
  });
  if (!created) throw new Error('KPI tanımı oluşturulamadı.');
  return parseDefinition(created);
}

export async function getKpiDefinition(organizationId: string, id: string): Promise<KpiDefinition | null> {
  await databaseReady;
  const row = await database.tenantTransaction(organizationId, (transaction) => transaction.get<KpiDefinitionRow>(
    'SELECT * FROM kpi_definitions WHERE id = ? AND organization_id = ?',
    [id, organizationId]
  ));
  return row ? parseDefinition(row) : null;
}

export async function listKpiDefinitions(
  organizationId: string,
  options: { enabledOnly?: boolean; id?: string } = {}
): Promise<KpiDefinition[]> {
  await databaseReady;
  const parameters: unknown[] = [organizationId];
  let filters = '';
  if (options.enabledOnly) filters += ' AND enabled = 1';
  if (options.id) {
    filters += ' AND id = ?';
    parameters.push(options.id);
  }
  const rows = await database.tenantTransaction(organizationId, (transaction) => transaction.all<KpiDefinitionRow>(
    `SELECT * FROM kpi_definitions
     WHERE organization_id = ?${filters}
     ORDER BY created_at DESC, id DESC`,
    parameters
  ));
  return rows.map(parseDefinition);
}

export async function listKpiDefinitionsWithLatest(organizationId: string): Promise<KpiDefinitionWithLatest[]> {
  await databaseReady;
  const rows = await database.tenantTransaction(organizationId, (transaction) => transaction.all<KpiDefinitionLatestRow>(
    `SELECT d.*,
            e.id AS latest_id, e.email AS latest_email, e.value AS latest_value,
            e.status AS latest_status, e.row_count AS latest_row_count,
            e.message AS latest_message, e.evaluated_at AS latest_evaluated_at
     FROM kpi_definitions d
     LEFT JOIN kpi_evaluations e ON e.id = (
       SELECT e2.id FROM kpi_evaluations e2
       WHERE e2.organization_id = d.organization_id AND e2.kpi_id = d.id
       ORDER BY e2.evaluated_at DESC, e2.id DESC LIMIT 1
     )
     WHERE d.organization_id = ?
     ORDER BY d.created_at DESC, d.id DESC`,
    [organizationId]
  ));
  return rows.map((row) => ({ ...parseDefinition(row), latest: parseLatest(row) }));
}

export async function updateKpiDefinition(
  organizationId: string,
  id: string,
  values: KpiDefinitionValues
): Promise<KpiDefinition | null> {
  await databaseReady;
  const updated = await database.tenantTransaction(organizationId, async (transaction) => (
    await transaction.run(
      `UPDATE kpi_definitions
       SET name = ?, description = ?, column_name = ?, aggregation = ?, display_format = ?,
           threshold_type = ?, threshold_value = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`,
      [
        values.name,
        values.description,
        values.columnName,
        values.aggregation,
        values.displayFormat,
        values.thresholdType,
        values.thresholdValue,
        values.enabled ? 1 : 0,
        id,
        organizationId
      ]
    )
  ).changes > 0);
  return updated ? getKpiDefinition(organizationId, id) : null;
}

export async function deleteKpiDefinition(organizationId: string, id: string): Promise<boolean> {
  await databaseReady;
  return database.tenantTransaction(organizationId, async (transaction) => (
    await transaction.run('DELETE FROM kpi_definitions WHERE id = ? AND organization_id = ?', [id, organizationId])
  ).changes > 0);
}

export async function getLatestKpiEvaluation(organizationId: string, kpiId: string): Promise<KpiEvaluation | null> {
  await databaseReady;
  const row = await database.tenantTransaction(organizationId, (transaction) => transaction.get<KpiEvaluationRow>(
    `SELECT * FROM kpi_evaluations
     WHERE organization_id = ? AND kpi_id = ?
     ORDER BY evaluated_at DESC, id DESC LIMIT 1`,
    [organizationId, kpiId]
  ));
  return row ? parseEvaluation(row) : null;
}

export async function recordKpiEvaluation(
  organizationId: string,
  kpiId: string,
  actorEmail: string,
  values: KpiEvaluationValues
): Promise<{ evaluation: KpiEvaluation; previous: KpiEvaluation | null }> {
  await databaseReady;
  const id = `kpie_${randomUUID()}`;
  const maximum = boundedInteger('KPI_EVALUATION_MAX_PER_KPI', 180, 1, 2_000);
  const recorded = await database.tenantTransaction(organizationId, async (transaction) => {
    const previous = await transaction.get<KpiEvaluationRow>(
      `SELECT * FROM kpi_evaluations
       WHERE organization_id = ? AND kpi_id = ?
       ORDER BY evaluated_at DESC, id DESC LIMIT 1`,
      [organizationId, kpiId]
    );
    const now = Date.now();
    const previousTime = previous ? Date.parse(previous.evaluated_at) : Number.NaN;
    const evaluatedAt = new Date(Number.isFinite(previousTime) && previousTime >= now ? previousTime + 1 : now).toISOString();
    await transaction.run(
      `INSERT INTO kpi_evaluations
       (id, organization_id, kpi_id, email, value, status, row_count, message, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        organizationId,
        kpiId,
        actorEmail,
        values.value,
        values.status,
        values.rowCount,
        values.message.slice(0, 1_000),
        evaluatedAt
      ]
    );
    const evaluation = await transaction.get<KpiEvaluationRow>(
      `SELECT * FROM kpi_evaluations
       WHERE id = ? AND organization_id = ? AND kpi_id = ?`,
      [id, organizationId, kpiId]
    );
    if (!evaluation) throw new Error('KPI değerlendirmesi kaydedilemedi.');
    const stale = await transaction.all<{ id: string }>(
      `SELECT id FROM kpi_evaluations
       WHERE organization_id = ? AND kpi_id = ?
       ORDER BY evaluated_at DESC, id DESC LIMIT 10000 OFFSET ?`,
      [organizationId, kpiId, maximum]
    );
    for (const row of stale) {
      await transaction.run(
        'DELETE FROM kpi_evaluations WHERE id = ? AND organization_id = ? AND kpi_id = ?',
        [row.id, organizationId, kpiId]
      );
    }
    return { evaluation, previous };
  });
  return {
    evaluation: parseEvaluation(recorded.evaluation),
    previous: recorded.previous ? parseEvaluation(recorded.previous) : null
  };
}

export async function listKpiEvaluationHistory(
  organizationId: string,
  kpiId: string,
  limit = 30
): Promise<KpiEvaluation[]> {
  await databaseReady;
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 180));
  const rows = await database.tenantTransaction(organizationId, (transaction) => transaction.all<KpiEvaluationRow>(
    `SELECT * FROM kpi_evaluations
     WHERE organization_id = ? AND kpi_id = ?
     ORDER BY evaluated_at DESC, id DESC LIMIT ?`,
    [organizationId, kpiId, safeLimit]
  ));
  return rows.map(parseEvaluation);
}
