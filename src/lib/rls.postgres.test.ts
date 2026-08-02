import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { database } from './database';
import { databaseReady } from './db';

const describePostgres = process.env.DATABASE_URL ? describe : describe.skip;

describePostgres('PostgreSQL forced tenant isolation', () => {
  it('enforces RLS for every tenant data-plane table', async () => {
    await databaseReady;
    const protectedTables = [
      'user_datasets_v2', 'user_connections', 'connector_sync_runs', 'user_documents',
      'audit_logs', 'user_notifications', 'organization_notification_settings',
      'dashboard_preferences', 'organization_data_policies', 'analysis_runs',
      'kpi_definitions', 'kpi_evaluations', 'organization_subscriptions',
      'organization_entitlements', 'billing_checkouts', 'billing_events',
      'usage_counters', 'user_usage_counters', 'organization_ai_settings',
      'organization_ai_credit_wallet', 'usage_bonus_allocations',
      'usage_threshold_events', 'ai_credit_purchases', 'ai_provider_usage'
    ];
    const rows = await database.all<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND c.relname = ANY(?)`,
      [protectedTables]
    );
    expect(rows).toHaveLength(protectedTables.length);
    expect(rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });

  it('blocks cross-tenant read, update and delete and clears pooled context', async () => {
    await databaseReady;
    const suffix = crypto.randomBytes(8).toString('hex');
    const organizationA = `org_rls_a_${suffix}`;
    const organizationB = `org_rls_b_${suffix}`;
    await database.run(
      `INSERT INTO saas_organizations (id, name, slug, owner_email)
       VALUES (?, 'RLS A', ?, ?), (?, 'RLS B', ?, ?)`,
      [organizationA, `rls-a-${suffix}`, `rls-a-${suffix}@example.test`, organizationB, `rls-b-${suffix}`, `rls-b-${suffix}@example.test`]
    );

    const datasetA = await database.tenantTransaction(organizationA, async (transaction) => {
      const result = await transaction.get<{ id: number }>(
        `INSERT INTO user_datasets_v2 (organization_id, email, filename, file_content, row_count, column_count)
         VALUES (?, ?, 'a.csv', 'value\\n1', 1, 1) RETURNING id`,
        [organizationA, `rls-a-${suffix}@example.test`]
      );
      return result!.id;
    });
    const datasetB = await database.tenantTransaction(organizationB, async (transaction) => {
      const result = await transaction.get<{ id: number }>(
        `INSERT INTO user_datasets_v2 (organization_id, email, filename, file_content, row_count, column_count)
         VALUES (?, ?, 'b.csv', 'value\\n2', 1, 1) RETURNING id`,
        [organizationB, `rls-b-${suffix}@example.test`]
      );
      return result!.id;
    });

    await database.tenantTransaction(organizationA, async (transaction) => {
      expect(await transaction.get('SELECT id FROM user_datasets_v2 WHERE id = ?', [datasetA])).not.toBeNull();
      expect(await transaction.get('SELECT id FROM user_datasets_v2 WHERE id = ?', [datasetB])).toBeNull();
      expect((await transaction.run('UPDATE user_datasets_v2 SET filename = ? WHERE id = ?', ['stolen.csv', datasetB])).changes).toBe(0);
      expect((await transaction.run('DELETE FROM user_datasets_v2 WHERE id = ?', [datasetB])).changes).toBe(0);
    });

    expect(await database.get('SELECT id FROM user_datasets_v2 WHERE id IN (?, ?)', [datasetA, datasetB])).toBeNull();
    await expect(database.run(
      `INSERT INTO user_datasets_v2 (organization_id, email, filename, file_content, row_count, column_count)
       VALUES (?, ?, 'missing-context.csv', 'value\\n3', 1, 1)`,
      [organizationA, `rls-a-${suffix}@example.test`]
    )).rejects.toThrow(/row-level security|policy/i);

    const afterPoolReuse = await database.tenantTransaction(organizationB, (transaction) => transaction.all<{ id: number }>(
      'SELECT id FROM user_datasets_v2 ORDER BY id'
    ));
    expect(afterPoolReuse.map((row) => row.id)).toEqual([datasetB]);
  });
});
