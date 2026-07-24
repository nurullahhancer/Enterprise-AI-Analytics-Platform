import { database } from './database';
import { databaseReady, resolveOrganizationScope } from './db';

export interface DataRetentionPolicy {
  enabled: boolean;
  retentionDays: number;
  lastAppliedAt: string | null;
  updatedAt: string | null;
}

export async function getDataRetentionPolicy(scope: string): Promise<DataRetentionPolicy> {
  await databaseReady;
  const organizationId = await resolveOrganizationScope(scope);
  const row = await database.tenantTransaction(organizationId, (transaction) => transaction.get<{
    retention_enabled: number; retention_days: number; last_applied_at: string | null; updated_at: string;
  }>('SELECT retention_enabled, retention_days, last_applied_at, updated_at FROM organization_data_policies WHERE organization_id = ?', [organizationId]));
  return {
    enabled: Boolean(row?.retention_enabled),
    retentionDays: Number(row?.retention_days || 365),
    lastAppliedAt: row?.last_applied_at || null,
    updatedAt: row?.updated_at || null
  };
}

export async function saveDataRetentionPolicy(scope: string, actorEmail: string, enabled: boolean, retentionDays: number): Promise<DataRetentionPolicy> {
  await databaseReady;
  const organizationId = await resolveOrganizationScope(scope);
  await database.tenantTransaction(organizationId, (transaction) => transaction.run(
    `INSERT INTO organization_data_policies (organization_id, email, retention_enabled, retention_days, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (organization_id) DO UPDATE SET
       email = excluded.email, retention_enabled = excluded.retention_enabled,
       retention_days = excluded.retention_days, updated_at = CURRENT_TIMESTAMP`,
    [organizationId, actorEmail, enabled ? 1 : 0, retentionDays]
  ));
  return getDataRetentionPolicy(organizationId);
}

export async function applyDataRetentionPolicy(scope: string, force = false): Promise<Record<string, number>> {
  await databaseReady;
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, async (transaction) => {
    const policy = await transaction.get<{ retention_enabled: number; retention_days: number }>(
      'SELECT retention_enabled, retention_days FROM organization_data_policies WHERE organization_id = ?', [organizationId]
    );
    if (!policy || (!force && !policy.retention_enabled)) return {};
    const cutoff = new Date(Date.now() - Math.max(30, Math.min(policy.retention_days, 3_650)) * 86_400_000).toISOString();
    const targets = [
      ['kpi_evaluations', 'evaluated_at'],
      ['connector_sync_runs', 'finished_at'],
      ['analysis_runs', 'created_at'],
      ['user_notifications', 'created_at'],
      ['audit_logs', 'created_at'],
    ] as const;
    const deleted: Record<string, number> = {};
    for (const [table, column] of targets) {
      deleted[table] = (await transaction.run(`DELETE FROM ${table} WHERE organization_id = ? AND ${column} < ?`, [organizationId, cutoff])).changes;
    }
    await transaction.run('UPDATE organization_data_policies SET last_applied_at = CURRENT_TIMESTAMP WHERE organization_id = ?', [organizationId]);
    return deleted;
  });
}

export async function listEnabledRetentionOrganizations(): Promise<string[]> {
  await databaseReady;
  // PostgreSQL business tables use FORCE ROW LEVEL SECURITY. Enumerate only the
  // non-tenant organization directory globally, then inspect every policy inside
  // its own tenant transaction so the scheduler cannot bypass tenant isolation.
  const organizations = await database.all<{ id: string }>('SELECT id FROM saas_organizations');
  const enabled: string[] = [];
  for (const organization of organizations) {
    const policy = await database.tenantTransaction(organization.id, (transaction) => transaction.get<{ retention_enabled: number }>(
      'SELECT retention_enabled FROM organization_data_policies WHERE organization_id = ?',
      [organization.id]
    ));
    if (policy?.retention_enabled) enabled.push(organization.id);
  }
  return enabled;
}

export async function exportOrganizationData(scope: string): Promise<Record<string, unknown>> {
  await databaseReady;
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, async (transaction) => ({
    exportedAt: new Date().toISOString(),
    organization: await transaction.get('SELECT id, name, slug, owner_email, plan_key, created_at, updated_at FROM saas_organizations WHERE id = ?', [organizationId]),
    members: await transaction.all('SELECT email, role, status, joined_at FROM organization_members WHERE organization_id = ?', [organizationId]),
    datasets: await transaction.all('SELECT id, filename, file_content, warning, source_type, row_count, column_count, created_at, updated_at FROM user_datasets_v2 WHERE organization_id = ?', [organizationId]),
    documents: await transaction.all('SELECT id, filename, content, chunks_count, status, created_at FROM user_documents WHERE organization_id = ?', [organizationId]),
    analyses: await transaction.all('SELECT id, dataset_filename, target_column, periods, result_json, interpretation, created_at FROM analysis_runs WHERE organization_id = ?', [organizationId]),
    kpis: await transaction.all('SELECT * FROM kpi_definitions WHERE organization_id = ?', [organizationId]),
    auditLogs: await transaction.all('SELECT email, action, details, ip_address, created_at FROM audit_logs WHERE organization_id = ?', [organizationId])
  }));
}
