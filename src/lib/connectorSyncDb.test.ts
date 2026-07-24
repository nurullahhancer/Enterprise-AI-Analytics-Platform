import { beforeAll, describe, expect, it } from 'vitest';
import { database } from './database';
import { createConnection, createUserWithOrganization } from './db';
import {
  acquireConnectorSyncLease,
  claimDueConnections,
  finalizeConnectorSyncSuccess,
  listConnectorSyncRuns,
  recordConnectorSync,
  releaseConnectorSyncLease,
  updateConnectionSchedule
} from './connectorSyncDb';

describe('connector sync scheduling and history', () => {
  const email = `connector-sync-${Date.now()}@example.test`;
  let organizationId = '';
  let connectionId = 0;

  beforeAll(async () => {
    organizationId = await createUserWithOrganization(email, 'Connector Sync', 'unused-test-hash');
    connectionId = await createConnection(organizationId, 'api', 'Test REST', 'encrypted-placeholder', email);
  });

  it('validates and persists an organization-scoped schedule', async () => {
    const scheduled = await updateConnectionSchedule(organizationId, connectionId, true, 30);

    expect(scheduled?.schedule_enabled).toBe(1);
    expect(scheduled?.schedule_interval_minutes).toBe(30);
    expect(new Date(scheduled?.next_sync_at || '').getTime()).toBeGreaterThan(Date.now());
  });

  it('claims only due connections and advances the next run before work starts', async () => {
    await database.tenantTransaction(organizationId, (transaction) => transaction.run(
      'UPDATE user_connections SET next_sync_at = ? WHERE id = ? AND organization_id = ?',
      [new Date(Date.now() - 60_000).toISOString(), connectionId, organizationId]
    ));

    const due = await claimDueConnections(10);
    const claimed = due.find((item) => item.id === connectionId && item.organization_id === organizationId);
    expect(claimed).toBeDefined();

    const row = await database.tenantTransaction(organizationId, (transaction) => transaction.get<{ next_sync_at: string }>(
      'SELECT next_sync_at FROM user_connections WHERE id = ? AND organization_id = ?',
      [connectionId, organizationId]
    ));
    expect(new Date(row?.next_sync_at || '').getTime()).toBeGreaterThan(Date.now());
  });

  it('stores bounded, user-safe success and failure history', async () => {
    const first = await recordConnectorSync(organizationId, connectionId, email, 'success', {
      datasetId: 42,
      rowCount: 25,
      columnCount: 4,
      startedAt: new Date(Date.now() - 2_000).toISOString(),
      finishedAt: new Date(Date.now() - 1_000).toISOString()
    });
    expect(first.previousStatus).toBeNull();

    const second = await recordConnectorSync(organizationId, connectionId, email, 'failure', {
      errorCode: 'REMOTE_TIMEOUT',
      errorMessage: 'REST isteği zaman aşımına uğradı.',
      startedAt: new Date(Date.now() - 500).toISOString(),
      finishedAt: new Date().toISOString()
    });
    expect(second.previousStatus).toBe('success');

    const runs = await listConnectorSyncRuns(organizationId, connectionId, 10);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ status: 'failure', error_code: 'REMOTE_TIMEOUT' });
    expect(runs[1]).toMatchObject({ status: 'success', dataset_id: 42, row_count: 25, column_count: 4 });
  });

  it('leases one connector at a time and rejects a superseded snapshot', async () => {
    const raceConnectionId = await createConnection(organizationId, 'api', 'Race-safe REST', 'encrypted-placeholder', email);
    const first = await acquireConnectorSyncLease(organizationId, raceConnectionId);
    expect(first.status).toBe('acquired');
    expect((await acquireConnectorSyncLease(organizationId, raceConnectionId)).status).toBe('busy');
    if (first.status !== 'acquired') throw new Error('Test lease could not be acquired.');

    await database.tenantTransaction(organizationId, (transaction) => transaction.run(
      'UPDATE user_connections SET sync_lease_expires_at = ? WHERE id = ? AND organization_id = ?',
      [new Date(Date.now() - 1_000).toISOString(), raceConnectionId, organizationId]
    ));
    const second = await acquireConnectorSyncLease(organizationId, raceConnectionId);
    expect(second.status).toBe('acquired');
    if (second.status !== 'acquired') throw new Error('Replacement lease could not be acquired.');

    const stale = await finalizeConnectorSyncSuccess(
      organizationId,
      raceConnectionId,
      email,
      first.leaseId,
      { filename: 'stale.csv', content: 'value\n1', rowCount: 1, columnCount: 1, actorEmail: email },
      { rowCount: 1, columnCount: 1, startedAt: new Date(Date.now() - 2_000).toISOString() }
    );
    expect(stale).toBeNull();

    const current = await finalizeConnectorSyncSuccess(
      organizationId,
      raceConnectionId,
      email,
      second.leaseId,
      {
        filename: 'current.csv',
        content: 'value\n2',
        rowCount: 1,
        columnCount: 1,
        actorEmail: email,
        options: { sourceType: 'rest', sourceRef: `connection:${raceConnectionId}`, replaceExistingSource: true }
      },
      { rowCount: 1, columnCount: 1, startedAt: new Date(Date.now() - 1_000).toISOString() }
    );
    expect(current?.datasetId).toBeGreaterThan(0);
    expect((await listConnectorSyncRuns(organizationId, raceConnectionId, 10))).toHaveLength(1);

    await releaseConnectorSyncLease(organizationId, raceConnectionId, second.leaseId);
  });
});
