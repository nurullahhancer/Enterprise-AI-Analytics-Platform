import { database, QueryExecutor } from './database';
import { getPlan, PlanKey } from './plans';
import { initializeSchema, personalOrganizationId } from './schema';
import logger from './logger';

const DATASET_TABLE = 'user_datasets_v2';
export const databaseReady = initializeSchema();

export interface DbUser {
  email: string;
  name: string;
  password_hash: string;
  role: 'admin' | 'analyst' | 'viewer';
  token_version: number;
  email_verified_at: string | null;
  created_at: string;
}

export interface OrganizationMembership {
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  plan_key: PlanKey;
  email: string;
  role: DbUser['role'];
  status: 'active' | 'suspended';
}

export interface Dataset {
  id: number;
  organization_id: string;
  email: string;
  filename: string;
  file_content: string;
  warning: string | null;
  is_active: number;
  include_in_analysis: number;
  source_type: 'file' | 'json' | 'rest' | 'sql' | 'etl';
  source_ref: string | null;
  row_count: number;
  column_count: number;
  created_at: string;
  updated_at: string;
}

export type DatasetMeta = Omit<Dataset, 'file_content'>;

export interface DatasetSaveOptions {
  sourceType?: Dataset['source_type'];
  sourceRef?: string | null;
  replaceExistingSource?: boolean;
  disableDatasetIds?: number[];
}

export interface DatasetTransactionInput {
  filename: string;
  content: string;
  warning?: string;
  rowCount?: number;
  columnCount?: number;
  actorEmail: string;
  options?: DatasetSaveOptions;
}

export class StorageQuotaError extends Error {
  code: 'DATASET_QUOTA_EXCEEDED' | 'DOCUMENT_QUOTA_EXCEEDED' | 'CONNECTOR_QUOTA_EXCEEDED';

  constructor(code: StorageQuotaError['code'], message: string) {
    super(message);
    this.name = 'StorageQuotaError';
    this.code = code;
  }
}

export class LastAdminError extends Error {
  constructor() {
    super('Organizasyondaki son yönetici kaldırılamaz.');
    this.name = 'LastAdminError';
  }
}

async function ready(): Promise<void> {
  await databaseReady;
}

async function insertId(transaction: QueryExecutor, sql: string, parameters: unknown[]): Promise<number> {
  if (transaction.dialect === 'postgres') {
    const row = await transaction.get<{ id: string | number }>(`${sql} RETURNING id`, parameters);
    return Number(row?.id || 0);
  }
  return (await transaction.run(sql, parameters)).lastID;
}

function personalSlug(email: string, organizationId: string): string {
  const local = email.split('@')[0].replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 36) || 'workspace';
  return `${local}-${organizationId.slice(-8)}`;
}

export async function ensurePersonalOrganization(
  email: string,
  name?: string,
  membershipRole?: DbUser['role']
): Promise<string> {
  await ready();
  const normalizedEmail = email.trim().toLowerCase();
  const organizationId = personalOrganizationId(normalizedEmail);
  await database.transaction(async (transaction) => {
    const user = await transaction.get<Pick<DbUser, 'name' | 'role'>>('SELECT name, role FROM users WHERE email = ?', [normalizedEmail]);
    const role = membershipRole || user?.role || 'analyst';
    await transaction.run(
      `INSERT INTO saas_organizations (id, name, slug, owner_email, plan_key)
       VALUES (?, ?, ?, ?, 'starter') ON CONFLICT (id) DO NOTHING`,
      [organizationId, `${name || user?.name || normalizedEmail} Çalışma Alanı`, personalSlug(normalizedEmail, organizationId), normalizedEmail]
    );
    await transaction.run(
      `INSERT INTO organization_members (organization_id, email, role, status)
       VALUES (?, ?, ?, 'active') ON CONFLICT (organization_id, email) DO NOTHING`,
      [organizationId, normalizedEmail, role]
    );
  });
  return organizationId;
}

export async function resolveOrganizationScope(scope: string): Promise<string> {
  await ready();
  const normalized = scope.trim().toLowerCase();
  if (!normalized.includes('@')) return scope;
  const membership = await database.get<{ organization_id: string }>(
    `SELECT organization_id FROM organization_members
     WHERE email = ? AND status = 'active'
     ORDER BY joined_at ASC, organization_id ASC LIMIT 1`,
    [normalized]
  );
  return membership?.organization_id || ensurePersonalOrganization(normalized);
}

export async function createUser(
  email: string,
  name: string,
  passwordHash: string,
  role: DbUser['role'] = 'analyst',
  emailVerified = false
): Promise<void> {
  await ready();
  await database.run(
    `INSERT INTO users (email, name, password_hash, role, email_verified_at)
     VALUES (?, ?, ?, ?, ?)`,
    [email, name, passwordHash, role, emailVerified ? new Date().toISOString() : null]
  );
}

export async function createUserWithOrganization(
  email: string,
  name: string,
  passwordHash: string,
  options: { globalRole?: DbUser['role']; organizationName?: string; emailVerified?: boolean } = {}
): Promise<string> {
  await ready();
  const normalizedEmail = email.trim().toLowerCase();
  const organizationId = personalOrganizationId(normalizedEmail);
  await database.transaction(async (transaction) => {
    await transaction.run(
      `INSERT INTO users (email, name, password_hash, role, email_verified_at) VALUES (?, ?, ?, ?, ?)`,
      [normalizedEmail, name, passwordHash, options.globalRole || 'analyst', options.emailVerified ? new Date().toISOString() : null]
    );
    await transaction.run(
      `INSERT INTO saas_organizations (id, name, slug, owner_email, plan_key) VALUES (?, ?, ?, ?, 'starter')`,
      [organizationId, options.organizationName || `${name} Çalışma Alanı`, personalSlug(normalizedEmail, organizationId), normalizedEmail]
    );
    await transaction.run(
      `INSERT INTO organization_members (organization_id, email, role, status) VALUES (?, ?, 'admin', 'active')`,
      [organizationId, normalizedEmail]
    );
  });
  return organizationId;
}

export async function findUserByEmail(email: string): Promise<DbUser | null> {
  await ready();
  return database.get<DbUser>('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
}

export async function getActiveMembership(email: string, requestedOrganizationId?: string): Promise<OrganizationMembership | null> {
  await ready();
  const parameters: unknown[] = [email.trim().toLowerCase()];
  const requested = requestedOrganizationId?.trim();
  let organizationFilter = '';
  if (requested) {
    organizationFilter = 'AND m.organization_id = ?';
    parameters.push(requested);
  }
  return database.get<OrganizationMembership>(
    `SELECT m.organization_id, o.name AS organization_name, o.slug AS organization_slug,
            o.plan_key, m.email, m.role, m.status
     FROM organization_members m
     JOIN saas_organizations o ON o.id = m.organization_id
     WHERE m.email = ? AND m.status = 'active' ${organizationFilter}
     ORDER BY m.joined_at ASC, m.organization_id ASC LIMIT 1`,
    parameters
  );
}

export async function listMemberships(email: string): Promise<OrganizationMembership[]> {
  await ready();
  return database.all<OrganizationMembership>(
    `SELECT m.organization_id, o.name AS organization_name, o.slug AS organization_slug,
            o.plan_key, m.email, m.role, m.status
     FROM organization_members m
     JOIN saas_organizations o ON o.id = m.organization_id
     WHERE m.email = ? AND m.status = 'active'
     ORDER BY m.joined_at ASC, m.organization_id ASC`,
    [email.trim().toLowerCase()]
  );
}

export async function listOrganizationAdminEmails(scope: string): Promise<string[]> {
  const organizationId = await resolveOrganizationScope(scope);
  const rows = await database.tenantTransaction(organizationId, (transaction) => transaction.all<{ email: string }>(
    `SELECT email FROM organization_members
     WHERE organization_id = ? AND status = 'active' AND role = 'admin'
     ORDER BY email`,
    [organizationId]
  ));
  return rows.map((row) => row.email);
}

async function organizationPlan(transaction: QueryExecutor, organizationId: string): Promise<PlanKey> {
  const row = await transaction.get<{ plan_key: PlanKey }>('SELECT plan_key FROM saas_organizations WHERE id = ?', [organizationId]);
  return row?.plan_key || 'starter';
}

export async function saveUserDatasetInTransaction(
  transaction: QueryExecutor,
  organizationId: string,
  input: DatasetTransactionInput
): Promise<number> {
  const options = input.options || {};
  const sourceType = options.sourceType || 'file';
  const sourceRef = options.sourceRef?.trim().slice(0, 180) || null;
  const allowedSourceTypes: Dataset['source_type'][] = ['file', 'json', 'rest', 'sql', 'etl'];
  if (!allowedSourceTypes.includes(sourceType)) throw new Error('Geçersiz veri kaynağı türü.');
  const existingSource = sourceRef && options.replaceExistingSource
    ? await transaction.get<Pick<Dataset, 'id'>>(
        `SELECT id FROM ${DATASET_TABLE}
         WHERE organization_id = ? AND source_type = ? AND source_ref = ?`,
        [organizationId, sourceType, sourceRef]
      )
    : null;
  const usage = await transaction.get<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM ${DATASET_TABLE} WHERE organization_id = ?`,
    [organizationId]
  );
  const plan = getPlan(await organizationPlan(transaction, organizationId));
  const nextCount = Number(usage?.count || 0) + (existingSource ? 0 : 1);
  if (nextCount > plan.limits.datasets) {
    throw new StorageQuotaError('DATASET_QUOTA_EXCEEDED', `Plan kotası aşıldı: en fazla ${plan.limits.datasets} veri seti yüklenebilir.`);
  }
  await transaction.run(`UPDATE ${DATASET_TABLE} SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`, [organizationId]);
  const disabledIds = [...new Set(options.disableDatasetIds || [])].filter((id) => Number.isInteger(id) && id > 0);
  for (const id of disabledIds) {
    await transaction.run(
      `UPDATE ${DATASET_TABLE} SET include_in_analysis = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`,
      [id, organizationId]
    );
  }
  if (existingSource) {
    await transaction.run(
      `UPDATE ${DATASET_TABLE}
       SET email = ?, filename = ?, file_content = ?, warning = ?, is_active = 1,
           row_count = ?, column_count = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`,
      [
        input.actorEmail, input.filename, input.content, input.warning || '',
        input.rowCount || 0, input.columnCount || 0, existingSource.id, organizationId
      ]
    );
    return existingSource.id;
  }
  if (sourceType === 'rest' && sourceRef) {
    await transaction.run(
      `UPDATE ${DATASET_TABLE} SET include_in_analysis = 0, updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = ? AND filename = ? AND source_ref IS NULL`,
      [organizationId, input.filename]
    );
  }
  return insertId(
    transaction,
    `INSERT INTO ${DATASET_TABLE}
     (organization_id, email, filename, file_content, warning, is_active, include_in_analysis, source_type, source_ref, row_count, column_count)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
    [
      organizationId, input.actorEmail, input.filename, input.content, input.warning || '',
      sourceType, sourceRef, input.rowCount || 0, input.columnCount || 0
    ]
  );
}

export async function saveUserDataset(
  scope: string,
  filename: string,
  content: string,
  warning = '',
  rowCount = 0,
  columnCount = 0,
  actorEmail?: string,
  options: DatasetSaveOptions = {}
): Promise<number> {
  const organizationId = await resolveOrganizationScope(scope);
  const actor = actorEmail || (scope.includes('@') ? scope : 'system@local');
  return database.tenantTransaction(organizationId, (transaction) => saveUserDatasetInTransaction(transaction, organizationId, {
    filename,
    content,
    warning,
    rowCount,
    columnCount,
    actorEmail: actor,
    options
  }));
}

export async function listUserDatasets(scope: string): Promise<DatasetMeta[]> {
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, (transaction) => transaction.all<DatasetMeta>(
    `SELECT id, organization_id, email, filename, warning, is_active, include_in_analysis,
            source_type, source_ref, row_count, column_count, created_at, updated_at
     FROM ${DATASET_TABLE} WHERE organization_id = ? ORDER BY is_active DESC, created_at DESC, id DESC`,
    [organizationId]
  ));
}

export async function getUserDatasets(scope: string, analysisOnly = false): Promise<Dataset[]> {
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, (transaction) => transaction.all<Dataset>(
    `SELECT * FROM ${DATASET_TABLE} WHERE organization_id = ?
     ${analysisOnly ? 'AND include_in_analysis = 1' : ''}
     ORDER BY created_at ASC, id ASC`,
    [organizationId]
  ));
}

export async function setDatasetAnalysisScope(scope: string, id: number, enabled: boolean): Promise<boolean> {
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, async (transaction) => (
    await transaction.run(
      `UPDATE ${DATASET_TABLE} SET include_in_analysis = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`,
      [enabled ? 1 : 0, id, organizationId]
    )
  ).changes > 0);
}

export async function getUserDataset(scope: string, id: number): Promise<Dataset | null> {
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, (transaction) => transaction.get<Dataset>(
    `SELECT * FROM ${DATASET_TABLE} WHERE id = ? AND organization_id = ?`, [id, organizationId]
  ));
}

export async function getUserActiveDataset(scope: string): Promise<Dataset | null> {
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, (transaction) => transaction.get<Dataset>(
    `SELECT * FROM ${DATASET_TABLE} WHERE organization_id = ?
     ORDER BY is_active DESC, updated_at DESC, id DESC LIMIT 1`,
    [organizationId]
  ));
}

export async function getLatestDataset(scope: string): Promise<Dataset | null> {
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, (transaction) => transaction.get<Dataset>(
    `SELECT * FROM ${DATASET_TABLE} WHERE organization_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [organizationId]
  ));
}

export async function setActiveDataset(scope: string, id: number): Promise<boolean> {
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, async (transaction) => {
    const existing = await transaction.get<{ id: number }>(`SELECT id FROM ${DATASET_TABLE} WHERE id = ? AND organization_id = ?`, [id, organizationId]);
    if (!existing) return false;
    await transaction.run(`UPDATE ${DATASET_TABLE} SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`, [organizationId]);
    await transaction.run(`UPDATE ${DATASET_TABLE} SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`, [id, organizationId]);
    return true;
  });
}

export async function deleteDataset(scope: string, id: number): Promise<boolean> {
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, async (transaction) => {
    const existing = await transaction.get<Pick<Dataset, 'id' | 'is_active'>>(
      `SELECT id, is_active FROM ${DATASET_TABLE} WHERE id = ? AND organization_id = ?`, [id, organizationId]
    );
    if (!existing) return false;
    const deleted = await transaction.run(`DELETE FROM ${DATASET_TABLE} WHERE id = ? AND organization_id = ?`, [id, organizationId]);
    if (existing.is_active === 1) {
      const latest = await transaction.get<{ id: number }>(
        `SELECT id FROM ${DATASET_TABLE} WHERE organization_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [organizationId]
      );
      if (latest) await transaction.run(`UPDATE ${DATASET_TABLE} SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`, [latest.id, organizationId]);
    }
    return deleted.changes > 0;
  });
}

export async function deleteActiveDataset(scope: string): Promise<boolean> {
  const active = await getUserActiveDataset(scope);
  return active ? deleteDataset(scope, active.id) : false;
}

export async function deleteAllDatasets(scope: string): Promise<number> {
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, async (transaction) => (
    await transaction.run(`DELETE FROM ${DATASET_TABLE} WHERE organization_id = ?`, [organizationId])
  ).changes);
}

export async function updateUser(email: string, name: string, passwordHash?: string): Promise<void> {
  await ready();
  if (passwordHash) {
    await database.run('UPDATE users SET name = ?, password_hash = ?, token_version = token_version + 1 WHERE email = ?', [name, passwordHash, email]);
  } else {
    await database.run('UPDATE users SET name = ? WHERE email = ?', [name, email]);
  }
}

export async function markEmailVerified(email: string): Promise<void> {
  await ready();
  await database.run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE email = ?', [new Date().toISOString(), email]);
}

export async function replacePassword(email: string, passwordHash: string): Promise<boolean> {
  await ready();
  return (await database.run(
    'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE email = ?',
    [passwordHash, email]
  )).changes > 0;
}

export async function revokeUserTokens(email: string): Promise<boolean> {
  await ready();
  return (await database.run('UPDATE users SET token_version = token_version + 1 WHERE email = ?', [email])).changes > 0;
}

export async function deleteUser(email: string): Promise<void> {
  await ready();
  await database.transaction(async (transaction) => {
    const memberships = await transaction.all<{ organization_id: string; role: DbUser['role'] }>(
      `SELECT organization_id, role FROM organization_members WHERE email = ? AND status = 'active'`, [email]
    );
    for (const membership of memberships) {
      const counts = await transaction.get<{ members: string | number; admins: string | number }>(
        `SELECT COUNT(*) AS members, SUM(CASE WHEN role = 'admin' AND status = 'active' THEN 1 ELSE 0 END) AS admins
         FROM organization_members WHERE organization_id = ?`,
        [membership.organization_id]
      );
      if (Number(counts?.members || 0) === 1) {
        if (transaction.dialect === 'sqlite') {
          for (const table of [
            'kpi_evaluations', 'kpi_definitions', 'connector_sync_runs', DATASET_TABLE,
            'user_connections', 'user_documents', 'audit_logs', 'user_notifications', 'analysis_runs'
          ]) {
            await transaction.run(`DELETE FROM ${table} WHERE organization_id = ?`, [membership.organization_id]);
          }
        }
        await transaction.run('DELETE FROM saas_organizations WHERE id = ?', [membership.organization_id]);
      } else {
        if (membership.role === 'admin' && Number(counts?.admins || 0) <= 1) throw new LastAdminError();
        await transaction.run('DELETE FROM organization_members WHERE organization_id = ? AND email = ?', [membership.organization_id, email]);
      }
    }
    await transaction.run('DELETE FROM auth_action_tokens WHERE email = ?', [email]);
    await transaction.run('DELETE FROM users WHERE email = ?', [email]);
  });
}

export async function listConnections(scope: string): Promise<any[]> {
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, (transaction) => transaction.all(
    'SELECT * FROM user_connections WHERE organization_id = ? ORDER BY id DESC', [organizationId]
  ));
}

export async function getConnection(scope: string, id: number): Promise<any | null> {
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, (transaction) => transaction.get(
    'SELECT * FROM user_connections WHERE id = ? AND organization_id = ?', [id, organizationId]
  ));
}

export async function createConnection(scope: string, type: string, name: string, config: string, actorEmail?: string): Promise<number> {
  const organizationId = await resolveOrganizationScope(scope);
  const actor = actorEmail || (scope.includes('@') ? scope : 'system@local');
  return database.tenantTransaction(organizationId, async (transaction) => {
    const count = await transaction.get<{ count: string | number }>('SELECT COUNT(*) AS count FROM user_connections WHERE organization_id = ?', [organizationId]);
    const plan = getPlan(await organizationPlan(transaction, organizationId));
    if (Number(count?.count || 0) >= plan.limits.connectors) {
      throw new StorageQuotaError('CONNECTOR_QUOTA_EXCEEDED', `Plan kotası aşıldı: en fazla ${plan.limits.connectors} konnektör.`);
    }
    return insertId(transaction,
      'INSERT INTO user_connections (organization_id, email, type, name, config) VALUES (?, ?, ?, ?, ?)',
      [organizationId, actor, type, name, config]
    );
  });
}

export async function deleteConnection(scope: string, id: number): Promise<boolean> {
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, async (transaction) => (
    await transaction.run('DELETE FROM user_connections WHERE id = ? AND organization_id = ?', [id, organizationId])
  ).changes > 0);
}

export async function listDocuments(scope: string): Promise<any[]> {
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, (transaction) => transaction.all(
    `SELECT id, organization_id, email, filename, chunks_count, status, created_at
     FROM user_documents WHERE organization_id = ? ORDER BY id DESC`, [organizationId]
  ));
}

export async function getDocumentsForSearch(scope: string): Promise<any[]> {
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, (transaction) => transaction.all(
    `SELECT id, filename, content, chunks_count, status, created_at
     FROM user_documents WHERE organization_id = ? ORDER BY id DESC`, [organizationId]
  ));
}

export async function saveDocument(scope: string, filename: string, content: string, chunksCount: number, actorEmail?: string): Promise<number> {
  const organizationId = await resolveOrganizationScope(scope);
  const actor = actorEmail || (scope.includes('@') ? scope : 'system@local');
  return database.tenantTransaction(organizationId, async (transaction) => {
    const usage = await transaction.get<{ count: string | number; chars: string | number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(content)), 0) AS chars FROM user_documents WHERE organization_id = ?`, [organizationId]
    );
    const plan = getPlan(await organizationPlan(transaction, organizationId));
    if (Number(usage?.count || 0) >= plan.limits.documents || Number(usage?.chars || 0) + content.length > plan.limits.documentChars) {
      throw new StorageQuotaError('DOCUMENT_QUOTA_EXCEEDED', `Plan kotası aşıldı: en fazla ${plan.limits.documents} doküman ve ${plan.limits.documentChars.toLocaleString('tr-TR')} karakter.`);
    }
    return insertId(transaction,
      `INSERT INTO user_documents (organization_id, email, filename, content, chunks_count, status)
       VALUES (?, ?, ?, ?, ?, 'indexed')`,
      [organizationId, actor, filename, content, chunksCount]
    );
  });
}

export async function deleteDocument(scope: string, id: number): Promise<boolean> {
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, async (transaction) => (
    await transaction.run('DELETE FROM user_documents WHERE id = ? AND organization_id = ?', [id, organizationId])
  ).changes > 0);
}

export async function listAuditLogs(scope: string): Promise<any[]> {
  const organizationId = await resolveOrganizationScope(scope);
  return database.tenantTransaction(organizationId, (transaction) => transaction.all(
    'SELECT * FROM audit_logs WHERE organization_id = ? ORDER BY id DESC LIMIT 200', [organizationId]
  ));
}

export async function addAuditLog(
  scope: string,
  action: string,
  details: string,
  ipAddress = '127.0.0.1',
  actorEmail?: string
): Promise<number> {
  const organizationId = await resolveOrganizationScope(scope);
  const actor = actorEmail || (scope.includes('@') ? scope : 'system@local');
  return database.tenantTransaction(organizationId, async (transaction) => {
    const maxEntries = Math.max(100, Math.min(Number(process.env.AUDIT_MAX_ENTRIES_PER_ORG || 10_000), 100_000));
    const usage = await transaction.get<{ count: string | number }>('SELECT COUNT(*) AS count FROM audit_logs WHERE organization_id = ?', [organizationId]);
    if (Number(usage?.count || 0) >= maxEntries) {
      const oldest = await transaction.get<{ id: number }>('SELECT id FROM audit_logs WHERE organization_id = ? ORDER BY id ASC LIMIT 1', [organizationId]);
      if (oldest) await transaction.run('DELETE FROM audit_logs WHERE id = ? AND organization_id = ?', [oldest.id, organizationId]);
    }
    return insertId(transaction,
      'INSERT INTO audit_logs (organization_id, email, action, details, ip_address) VALUES (?, ?, ?, ?, ?)',
      [organizationId, actor, action, details, ipAddress || 'unknown']
    );
  });
}

export async function listOrganizations(email: string): Promise<any[]> {
  return (await listMemberships(email)).map((item) => ({
    id: item.organization_id,
    name: item.organization_name,
    tenant_id: item.organization_id,
    slug: item.organization_slug,
    plan_key: item.plan_key,
    role: item.role
  }));
}

export async function createOrganization(email: string, name: string, tenantId: string): Promise<number> {
  await ready();
  await database.transaction(async (transaction) => {
    await transaction.run(
      `INSERT INTO saas_organizations (id, name, slug, owner_email, plan_key) VALUES (?, ?, ?, ?, 'starter')`,
      [tenantId, name, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${tenantId.slice(-8)}`, email]
    );
    await transaction.run(
      `INSERT INTO organization_members (organization_id, email, role, status) VALUES (?, ?, 'admin', 'active')`,
      [tenantId, email]
    );
  });
  return 1;
}

export async function getUserRole(email: string): Promise<string> {
  await ready();
  return (await database.get<{ role: string }>('SELECT role FROM users WHERE email = ?', [email]))?.role || 'analyst';
}

export async function updateUserRole(email: string, role: DbUser['role']): Promise<boolean> {
  return (await changeUserRole(email, role)) === 'updated';
}

export async function changeUserRole(email: string, role: DbUser['role']): Promise<'updated' | 'not_found' | 'last_admin'> {
  await ready();
  return database.transaction(async (transaction) => {
    const target = await transaction.get<Pick<DbUser, 'role'>>('SELECT role FROM users WHERE email = ?', [email]);
    if (!target) return 'not_found';
    if (target.role === 'admin' && role !== 'admin') {
      const admins = await transaction.get<{ count: string | number }>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'");
      if (Number(admins?.count || 0) <= 1) return 'last_admin';
    }
    await transaction.run('UPDATE users SET role = ?, token_version = token_version + 1 WHERE email = ?', [role, email]);
    return 'updated';
  });
}

export async function listUsers(): Promise<Array<Pick<DbUser, 'email' | 'name' | 'role' | 'created_at'>>> {
  await ready();
  return database.all('SELECT email, name, role, created_at FROM users ORDER BY created_at, email');
}

export async function checkDatabase(): Promise<boolean> {
  try {
    await ready();
    if (!await database.check()) return false;
    const required = [
      'users', 'saas_organizations', 'organization_members', DATASET_TABLE, 'usage_counters',
      'analysis_runs', 'connector_sync_runs', 'kpi_definitions', 'kpi_evaluations'
    ];
    if (database.dialect === 'postgres') {
      const rows = await database.all<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN (${required.map(() => '?').join(',')})`, required
      );
      return rows.length === required.length;
    }
    const rows = await database.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${required.map(() => '?').join(',')})`, required
    );
    return rows.length === required.length;
  } catch (error) {
    logger.error('Veritabanı sağlık kontrolü başarısız.', { error });
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await database.close();
}

export async function listNotifications(scope: string, recipientEmail?: string): Promise<any[]> {
  const organizationId = await resolveOrganizationScope(scope);
  const recipient = recipientEmail || (scope.includes('@') ? scope : 'system@local');
  return database.tenantTransaction(organizationId, (transaction) => transaction.all(
    `SELECT * FROM user_notifications WHERE organization_id = ? AND email = ? ORDER BY id DESC LIMIT 100`,
    [organizationId, recipient]
  ));
}

export async function addNotification(scope: string, title: string, message: string, recipientEmail?: string): Promise<number> {
  const organizationId = await resolveOrganizationScope(scope);
  const recipient = recipientEmail || (scope.includes('@') ? scope : 'system@local');
  return database.tenantTransaction(organizationId, async (transaction) => insertId(
    transaction,
    'INSERT INTO user_notifications (organization_id, email, title, message) VALUES (?, ?, ?, ?)',
    [organizationId, recipient, title, message]
  ));
}

export async function markNotificationsRead(scope: string, recipientEmail?: string): Promise<boolean> {
  const organizationId = await resolveOrganizationScope(scope);
  const recipient = recipientEmail || (scope.includes('@') ? scope : 'system@local');
  return database.tenantTransaction(organizationId, async (transaction) => (
    await transaction.run(
      'UPDATE user_notifications SET read_status = 1 WHERE organization_id = ? AND email = ?',
      [organizationId, recipient]
    )
  ).changes > 0);
}

export const saveDataset = saveUserDataset;
export const listDatasets = listUserDatasets;
export const getDataset = getUserDataset;
