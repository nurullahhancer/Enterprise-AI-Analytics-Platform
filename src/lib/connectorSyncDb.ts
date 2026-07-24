import crypto from 'node:crypto';
import { database, QueryExecutor } from './database';
import {
  databaseReady,
  DatasetTransactionInput,
  resolveOrganizationScope,
  saveUserDatasetInTransaction
} from './db';

export interface ScheduledConnection {
  id: number;
  organization_id: string;
  email: string;
  type: string;
  name: string;
  config: string;
  schedule_enabled: number;
  schedule_interval_minutes: number;
  next_sync_at: string | null;
  last_synced_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  sync_lease_id: string | null;
  sync_lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectorSyncRun {
  id: string;
  connection_id: number;
  status: 'success' | 'failure';
  dataset_id: number | null;
  row_count: number;
  column_count: number;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string;
}

export interface ConnectorSyncResultRecord {
  datasetId?: number;
  rowCount?: number;
  columnCount?: number;
  errorCode?: string;
  errorMessage?: string;
  startedAt: string;
  finishedAt?: string;
}

const clampInterval = (value: number): number => Math.max(15, Math.min(Math.round(value), 24 * 60));

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && Number.isInteger(parsed)
    ? Math.max(minimum, Math.min(parsed, maximum))
    : fallback;
}

function connectorLeaseMs(): number {
  return boundedInteger(process.env.CONNECTOR_SYNC_LEASE_MS, 120_000, 30_000, 10 * 60_000);
}

function connectorHistoryLimit(): number {
  return boundedInteger(process.env.CONNECTOR_SYNC_RUN_MAX, 180, 20, 2_000);
}

function nextSyncAt(intervalMinutes: number, from = new Date()): string {
  return new Date(from.getTime() + clampInterval(intervalMinutes) * 60_000).toISOString();
}

export type ConnectorLeaseResult =
  | { status: 'acquired'; leaseId: string; connection: ScheduledConnection }
  | { status: 'busy' | 'not_found' };

export async function acquireConnectorSyncLease(scope: string, connectionId: number): Promise<ConnectorLeaseResult> {
  await databaseReady;
  const organizationId = await resolveOrganizationScope(scope);
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + connectorLeaseMs()).toISOString();
  return database.tenantTransaction(organizationId, async (transaction) => {
    const existing = await transaction.get<ScheduledConnection>(
      'SELECT * FROM user_connections WHERE id = ? AND organization_id = ?',
      [connectionId, organizationId]
    );
    if (!existing) return { status: 'not_found' };
    if (existing.sync_lease_id && existing.sync_lease_expires_at && existing.sync_lease_expires_at > nowIso) {
      return { status: 'busy' };
    }
    await transaction.run(
      `UPDATE user_connections
       SET sync_lease_id = ?, sync_lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`,
      [leaseId, expiresAt, connectionId, organizationId]
    );
    const connection = await transaction.get<ScheduledConnection>(
      'SELECT * FROM user_connections WHERE id = ? AND organization_id = ?',
      [connectionId, organizationId]
    );
    return connection ? { status: 'acquired', leaseId, connection } : { status: 'not_found' };
  });
}

export async function releaseConnectorSyncLease(scope: string, connectionId: number, leaseId: string): Promise<void> {
  await databaseReady;
  const organizationId = await resolveOrganizationScope(scope);
  await database.tenantTransaction(organizationId, (transaction) => transaction.run(
    `UPDATE user_connections
     SET sync_lease_id = NULL, sync_lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND organization_id = ? AND sync_lease_id = ?`,
    [connectionId, organizationId, leaseId]
  ));
}

export async function updateConnectionSchedule(
  scope: string,
  connectionId: number,
  enabled: boolean,
  intervalMinutes: number
): Promise<ScheduledConnection | null> {
  await databaseReady;
  const organizationId = await resolveOrganizationScope(scope);
  const interval = clampInterval(intervalMinutes);
  return database.tenantTransaction(organizationId, async (transaction) => {
    const existing = await transaction.get<ScheduledConnection>(
      'SELECT * FROM user_connections WHERE id = ? AND organization_id = ?',
      [connectionId, organizationId]
    );
    if (!existing) return null;
    await transaction.run(
      `UPDATE user_connections
       SET schedule_enabled = ?, schedule_interval_minutes = ?, next_sync_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`,
      [enabled ? 1 : 0, interval, enabled ? nextSyncAt(interval) : null, connectionId, organizationId]
    );
    return transaction.get<ScheduledConnection>(
      'SELECT * FROM user_connections WHERE id = ? AND organization_id = ?',
      [connectionId, organizationId]
    );
  });
}

export async function listConnectorSyncRuns(
  scope: string,
  connectionId: number,
  requestedLimit = 20
): Promise<ConnectorSyncRun[]> {
  await databaseReady;
  const organizationId = await resolveOrganizationScope(scope);
  const limit = Math.max(1, Math.min(Math.round(requestedLimit), 100));
  return database.tenantTransaction(organizationId, (transaction) => transaction.all<ConnectorSyncRun>(
    `SELECT id, connection_id, status, dataset_id, row_count, column_count,
            error_code, error_message, started_at, finished_at
     FROM connector_sync_runs
     WHERE organization_id = ? AND connection_id = ?
     ORDER BY finished_at DESC LIMIT ?`,
    [organizationId, connectionId, limit]
  ));
}

async function pruneConnectorHistory(
  transaction: QueryExecutor,
  organizationId: string,
  connectionId: number
): Promise<void> {
  const stale = await transaction.all<{ id: string }>(
    `SELECT id FROM connector_sync_runs
     WHERE organization_id = ? AND connection_id = ?
     ORDER BY finished_at DESC, id DESC LIMIT 10000 OFFSET ?`,
    [organizationId, connectionId, connectorHistoryLimit()]
  );
  for (const row of stale) {
    await transaction.run(
      'DELETE FROM connector_sync_runs WHERE id = ? AND organization_id = ? AND connection_id = ?',
      [row.id, organizationId, connectionId]
    );
  }
}

async function persistConnectorSyncRecord(
  transaction: QueryExecutor,
  organizationId: string,
  connection: ScheduledConnection,
  actorEmail: string,
  status: ConnectorSyncRun['status'],
  result: ConnectorSyncResultRecord,
  leaseId?: string
): Promise<{ previousStatus: string | null; connection: ScheduledConnection | null }> {
  const finishedAt = result.finishedAt || new Date().toISOString();
  const errorMessage = status === 'failure'
    ? String(result.errorMessage || 'Veri kaynağı eşitlenemedi.').slice(0, 500)
    : null;
  const errorCode = status === 'failure'
    ? String(result.errorCode || 'CONNECTOR_SYNC_FAILED').slice(0, 80)
    : null;
  const nextAt = connection.schedule_enabled
    ? nextSyncAt(connection.schedule_interval_minutes, new Date(finishedAt))
    : null;
  const updated = await transaction.run(
    `UPDATE user_connections
     SET last_synced_at = ?, last_sync_status = ?, last_sync_error = ?, next_sync_at = ?,
         sync_lease_id = ${leaseId ? 'NULL' : 'sync_lease_id'},
         sync_lease_expires_at = ${leaseId ? 'NULL' : 'sync_lease_expires_at'},
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND organization_id = ?${leaseId ? ' AND sync_lease_id = ?' : ''}`,
    [finishedAt, status, errorMessage, nextAt, connection.id, organizationId, ...(leaseId ? [leaseId] : [])]
  );
  if (updated.changes === 0) return { previousStatus: connection.last_sync_status, connection: null };

  await transaction.run(
    `INSERT INTO connector_sync_runs
     (id, organization_id, connection_id, email, status, dataset_id, row_count, column_count,
      error_code, error_message, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(), organizationId, connection.id, actorEmail, status,
      result.datasetId ?? null, result.rowCount ?? 0, result.columnCount ?? 0,
      errorCode, errorMessage, result.startedAt, finishedAt
    ]
  );
  await pruneConnectorHistory(transaction, organizationId, connection.id);
  return {
    previousStatus: connection.last_sync_status,
    connection: await transaction.get<ScheduledConnection>(
      'SELECT * FROM user_connections WHERE id = ? AND organization_id = ?',
      [connection.id, organizationId]
    )
  };
}

export async function recordConnectorSync(
  scope: string,
  connectionId: number,
  actorEmail: string,
  status: ConnectorSyncRun['status'],
  result: ConnectorSyncResultRecord
): Promise<{ previousStatus: string | null; connection: ScheduledConnection | null }> {
  await databaseReady;
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, async (transaction) => {
    const connection = await transaction.get<ScheduledConnection>(
      'SELECT * FROM user_connections WHERE id = ? AND organization_id = ?',
      [connectionId, organizationId]
    );
    if (!connection) return { previousStatus: null, connection: null };
    return persistConnectorSyncRecord(transaction, organizationId, connection, actorEmail, status, result);
  });
}

export async function finalizeConnectorSyncSuccess(
  scope: string,
  connectionId: number,
  actorEmail: string,
  leaseId: string,
  dataset: DatasetTransactionInput,
  result: Omit<ConnectorSyncResultRecord, 'datasetId'>
): Promise<{
  datasetId: number;
  previousStatus: string | null;
  connection: ScheduledConnection;
} | null> {
  await databaseReady;
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, async (transaction) => {
    const connection = await transaction.get<ScheduledConnection>(
      'SELECT * FROM user_connections WHERE id = ? AND organization_id = ? AND sync_lease_id = ?',
      [connectionId, organizationId, leaseId]
    );
    if (!connection) return null;
    const datasetId = await saveUserDatasetInTransaction(transaction, organizationId, dataset);
    const recorded = await persistConnectorSyncRecord(
      transaction,
      organizationId,
      connection,
      actorEmail,
      'success',
      { ...result, datasetId },
      leaseId
    );
    if (!recorded.connection) return null;
    return { datasetId, previousStatus: recorded.previousStatus, connection: recorded.connection };
  });
}

export async function finalizeConnectorSyncFailure(
  scope: string,
  connectionId: number,
  actorEmail: string,
  leaseId: string,
  result: ConnectorSyncResultRecord
): Promise<{ previousStatus: string | null; connection: ScheduledConnection } | null> {
  await databaseReady;
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, async (transaction) => {
    const connection = await transaction.get<ScheduledConnection>(
      'SELECT * FROM user_connections WHERE id = ? AND organization_id = ? AND sync_lease_id = ?',
      [connectionId, organizationId, leaseId]
    );
    if (!connection) return null;
    const recorded = await persistConnectorSyncRecord(
      transaction,
      organizationId,
      connection,
      actorEmail,
      'failure',
      result,
      leaseId
    );
    return recorded.connection
      ? { previousStatus: recorded.previousStatus, connection: recorded.connection }
      : null;
  });
}

export async function claimDueConnections(requestedLimit = 10): Promise<ScheduledConnection[]> {
  await databaseReady;
  const limit = Math.max(1, Math.min(Math.round(requestedLimit), 50));
  const now = new Date();
  const nowIso = now.toISOString();
  const organizations = await database.all<{ id: string }>('SELECT id FROM saas_organizations ORDER BY id');
  const claimed: ScheduledConnection[] = [];

  for (const organization of organizations) {
    if (claimed.length >= limit) break;
    const remaining = limit - claimed.length;
    const rows = await database.tenantTransaction(organization.id, async (transaction) => {
      const due = await transaction.all<ScheduledConnection>(
        `SELECT * FROM user_connections
         WHERE organization_id = ? AND type IN ('api', 'postgresql') AND schedule_enabled = 1
           AND next_sync_at IS NOT NULL AND next_sync_at <= ?
           AND (sync_lease_expires_at IS NULL OR sync_lease_expires_at <= ?)
         ORDER BY next_sync_at ASC LIMIT ?`,
        [organization.id, nowIso, nowIso, remaining]
      );
      for (const connection of due) {
        await transaction.run(
          `UPDATE user_connections SET next_sync_at = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND organization_id = ? AND schedule_enabled = 1`,
          [nextSyncAt(connection.schedule_interval_minutes, now), connection.id, organization.id]
        );
      }
      return due;
    });
    claimed.push(...rows);
  }
  return claimed;
}
