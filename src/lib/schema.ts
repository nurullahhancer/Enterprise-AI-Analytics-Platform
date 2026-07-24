import crypto from 'node:crypto';
import { database, QueryExecutor } from './database';
import logger from './logger';

const BUSINESS_TABLES = [
  'user_datasets_v2',
  'user_connections',
  'connector_sync_runs',
  'user_documents',
  'audit_logs',
  'user_notifications',
  'organization_notification_settings',
  'dashboard_preferences',
  'organization_data_policies',
  'analysis_runs',
  'kpi_definitions',
  'kpi_evaluations'
] as const;

const SCHEMA_MIGRATION_LOCK = 'enterprise-ai-analytics:schema-migration:v1';

export function personalOrganizationId(email: string): string {
  return `org_${crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 24)}`;
}

function slugFor(email: string, organizationId: string): string {
  const local = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'workspace';
  return `${local}-${organizationId.slice(-8)}`;
}

async function sqliteHasColumn(transaction: QueryExecutor, table: string, column: string): Promise<boolean> {
  const columns = await transaction.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return columns.some((item) => item.name === column);
}

async function addColumn(transaction: QueryExecutor, table: string, column: string, definition: string): Promise<void> {
  if (transaction.dialect === 'postgres') {
    await transaction.run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
  } else if (!await sqliteHasColumn(transaction, table, column)) {
    await transaction.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function createCoreTables(transaction: QueryExecutor): Promise<void> {
  const id = transaction.dialect === 'postgres' ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const timestamp = transaction.dialect === 'postgres' ? 'TIMESTAMPTZ' : 'DATETIME';

  await transaction.run(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin', 'analyst', 'viewer')),
      token_version INTEGER NOT NULL DEFAULT 0,
      email_verified_at ${timestamp},
      created_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await addColumn(transaction, 'users', 'role', "TEXT NOT NULL DEFAULT 'analyst'");
  await addColumn(transaction, 'users', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(transaction, 'users', 'email_verified_at', timestamp);

  await transaction.run(`
    CREATE TABLE IF NOT EXISTS saas_organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      owner_email TEXT NOT NULL,
      plan_key TEXT NOT NULL DEFAULT 'starter' CHECK (plan_key IN ('starter', 'professional', 'enterprise')),
      created_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS organization_members (
      organization_id TEXT NOT NULL REFERENCES saas_organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'analyst', 'viewer')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
      joined_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (organization_id, email)
    )
  `);
  await transaction.run('CREATE INDEX IF NOT EXISTS idx_members_email ON organization_members(email)');

  await transaction.run(`
    CREATE TABLE IF NOT EXISTS user_datasets_v2 (
      id ${id},
      organization_id TEXT REFERENCES saas_organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_content TEXT NOT NULL,
      warning TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      include_in_analysis INTEGER NOT NULL DEFAULT 1,
      source_type TEXT NOT NULL DEFAULT 'file',
      source_ref TEXT,
      row_count INTEGER NOT NULL DEFAULT 0,
      column_count INTEGER NOT NULL DEFAULT 0,
      created_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS user_connections (
      id ${id},
      organization_id TEXT REFERENCES saas_organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      schedule_enabled INTEGER NOT NULL DEFAULT 0,
      schedule_interval_minutes INTEGER NOT NULL DEFAULT 60,
      next_sync_at ${timestamp},
      last_synced_at ${timestamp},
      last_sync_status TEXT,
      last_sync_error TEXT,
      sync_lease_id TEXT,
      sync_lease_expires_at ${timestamp},
      created_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS connector_sync_runs (
      id TEXT PRIMARY KEY,
      organization_id TEXT REFERENCES saas_organizations(id) ON DELETE CASCADE,
      connection_id INTEGER NOT NULL REFERENCES user_connections(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
      dataset_id INTEGER,
      row_count INTEGER NOT NULL DEFAULT 0,
      column_count INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      started_at ${timestamp} NOT NULL,
      finished_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS user_documents (
      id ${id},
      organization_id TEXT REFERENCES saas_organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      chunks_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'indexed',
      created_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id ${id},
      organization_id TEXT REFERENCES saas_organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      ip_address TEXT NOT NULL DEFAULT '127.0.0.1',
      created_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS user_notifications (
      id ${id},
      organization_id TEXT REFERENCES saas_organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      read_status INTEGER NOT NULL DEFAULT 0,
      created_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS organization_notification_settings (
      organization_id TEXT PRIMARY KEY REFERENCES saas_organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      email_enabled INTEGER NOT NULL DEFAULT 0,
      slack_webhook_encrypted TEXT,
      teams_webhook_encrypted TEXT,
      events_json TEXT NOT NULL DEFAULT '["kpi_breach","kpi_recovery","connector_failure","connector_recovery","billing"]',
      updated_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS dashboard_preferences (
      organization_id TEXT NOT NULL REFERENCES saas_organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      widget_order_json TEXT NOT NULL DEFAULT '[]',
      hidden_widgets_json TEXT NOT NULL DEFAULT '[]',
      updated_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (organization_id, email)
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS organization_data_policies (
      organization_id TEXT PRIMARY KEY REFERENCES saas_organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      retention_enabled INTEGER NOT NULL DEFAULT 0,
      retention_days INTEGER NOT NULL DEFAULT 365,
      last_applied_at ${timestamp},
      updated_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS analysis_runs (
      id TEXT PRIMARY KEY,
      organization_id TEXT REFERENCES saas_organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      dataset_ids_json TEXT NOT NULL,
      dataset_filename TEXT NOT NULL,
      target_column TEXT,
      periods INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      interpretation TEXT,
      ai_provider TEXT,
      ai_model TEXT,
      created_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS kpi_definitions (
      id TEXT PRIMARY KEY,
      organization_id TEXT REFERENCES saas_organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      column_name TEXT NOT NULL,
      aggregation TEXT NOT NULL CHECK (aggregation IN ('sum', 'average', 'min', 'max', 'count')),
      display_format TEXT NOT NULL DEFAULT 'number' CHECK (display_format IN ('number', 'currency', 'percent')),
      threshold_type TEXT NOT NULL DEFAULT 'none' CHECK (threshold_type IN ('none', 'minimum', 'maximum')),
      threshold_value REAL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS kpi_evaluations (
      id TEXT PRIMARY KEY,
      organization_id TEXT REFERENCES saas_organizations(id) ON DELETE CASCADE,
      kpi_id TEXT NOT NULL REFERENCES kpi_definitions(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      value REAL,
      status TEXT NOT NULL CHECK (status IN ('healthy', 'breach', 'unavailable')),
      row_count INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL,
      evaluated_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  for (const table of BUSINESS_TABLES) await addColumn(transaction, table, 'organization_id', 'TEXT');
  await addColumn(transaction, 'user_datasets_v2', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
  await addColumn(transaction, 'user_datasets_v2', 'include_in_analysis', 'INTEGER NOT NULL DEFAULT 1');
  await addColumn(transaction, 'user_datasets_v2', 'source_type', "TEXT NOT NULL DEFAULT 'file'");
  await addColumn(transaction, 'user_datasets_v2', 'source_ref', 'TEXT');
  await addColumn(transaction, 'user_datasets_v2', 'row_count', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(transaction, 'user_datasets_v2', 'column_count', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(transaction, 'user_datasets_v2', 'updated_at', `${timestamp} DEFAULT CURRENT_TIMESTAMP`);
  await addColumn(transaction, 'user_connections', 'schedule_enabled', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(transaction, 'user_connections', 'schedule_interval_minutes', 'INTEGER NOT NULL DEFAULT 60');
  await addColumn(transaction, 'user_connections', 'next_sync_at', timestamp);
  await addColumn(transaction, 'user_connections', 'last_synced_at', timestamp);
  await addColumn(transaction, 'user_connections', 'last_sync_status', 'TEXT');
  await addColumn(transaction, 'user_connections', 'last_sync_error', 'TEXT');
  await addColumn(transaction, 'user_connections', 'sync_lease_id', 'TEXT');
  await addColumn(transaction, 'user_connections', 'sync_lease_expires_at', timestamp);
  await addColumn(transaction, 'user_connections', 'updated_at', `${timestamp} DEFAULT CURRENT_TIMESTAMP`);

  await transaction.run('CREATE INDEX IF NOT EXISTS idx_datasets_org ON user_datasets_v2(organization_id)');
  await transaction.run('CREATE INDEX IF NOT EXISTS idx_connections_org ON user_connections(organization_id)');
  await transaction.run('CREATE INDEX IF NOT EXISTS idx_documents_org ON user_documents(organization_id)');
  await transaction.run('CREATE INDEX IF NOT EXISTS idx_audit_org_created ON audit_logs(organization_id, created_at)');
  await transaction.run('CREATE INDEX IF NOT EXISTS idx_notifications_org_user ON user_notifications(organization_id, email, created_at)');
  await transaction.run('CREATE INDEX IF NOT EXISTS idx_datasets_analysis_scope ON user_datasets_v2(organization_id, include_in_analysis, created_at)');
  await transaction.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_datasets_source_ref ON user_datasets_v2(organization_id, source_type, source_ref) WHERE source_ref IS NOT NULL');
  await transaction.run('CREATE INDEX IF NOT EXISTS idx_analysis_runs_org_created ON analysis_runs(organization_id, created_at)');
  await transaction.run('CREATE INDEX IF NOT EXISTS idx_connector_sync_runs_org_connection ON connector_sync_runs(organization_id, connection_id, finished_at)');
  await transaction.run('CREATE INDEX IF NOT EXISTS idx_connections_due_sync ON user_connections(organization_id, schedule_enabled, next_sync_at)');
  await transaction.run('CREATE INDEX IF NOT EXISTS idx_connections_sync_lease ON user_connections(organization_id, sync_lease_expires_at)');
  await transaction.run('CREATE INDEX IF NOT EXISTS idx_kpi_definitions_org ON kpi_definitions(organization_id, enabled, created_at)');
  await transaction.run('CREATE INDEX IF NOT EXISTS idx_kpi_evaluations_org_kpi ON kpi_evaluations(organization_id, kpi_id, evaluated_at)');
}

async function createSaasTables(transaction: QueryExecutor): Promise<void> {
  const timestamp = transaction.dialect === 'postgres' ? 'TIMESTAMPTZ' : 'DATETIME';
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS organization_invitations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES saas_organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'analyst', 'viewer')),
      token_hash TEXT NOT NULL UNIQUE,
      invited_by TEXT NOT NULL,
      expires_at ${timestamp} NOT NULL,
      accepted_at ${timestamp},
      revoked_at ${timestamp},
      created_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run('CREATE INDEX IF NOT EXISTS idx_invitations_org ON organization_invitations(organization_id, email)');
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS auth_action_tokens (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at ${timestamp} NOT NULL,
      consumed_at ${timestamp},
      created_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run('CREATE INDEX IF NOT EXISTS idx_auth_tokens_email ON auth_action_tokens(email, purpose)');
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS organization_subscriptions (
      organization_id TEXT PRIMARY KEY REFERENCES saas_organizations(id) ON DELETE CASCADE,
      provider TEXT NOT NULL DEFAULT 'manual',
      provider_customer_reference TEXT,
      provider_subscription_reference TEXT,
      plan_key TEXT NOT NULL DEFAULT 'starter' CHECK (plan_key IN ('starter', 'professional', 'enterprise')),
      status TEXT NOT NULL DEFAULT 'active',
      current_period_start ${timestamp},
      current_period_end ${timestamp},
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      updated_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS billing_checkouts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES saas_organizations(id) ON DELETE CASCADE,
      requested_by TEXT NOT NULL,
      plan_key TEXT NOT NULL,
      provider_token TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL UNIQUE,
      checkout_form_content TEXT NOT NULL,
      expires_at ${timestamp} NOT NULL,
      completed_at ${timestamp},
      created_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS billing_events (
      event_key TEXT PRIMARY KEY,
      organization_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      processed_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS usage_counters (
      organization_id TEXT NOT NULL REFERENCES saas_organizations(id) ON DELETE CASCADE,
      metric TEXT NOT NULL CHECK (metric IN ('ai_requests', 'ml_runs')),
      period_key TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      updated_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (organization_id, metric, period_key)
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS user_usage_counters (
      organization_id TEXT NOT NULL REFERENCES saas_organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      metric TEXT NOT NULL CHECK (metric IN ('ai_requests')),
      period_key TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      updated_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (organization_id, email, metric, period_key)
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS organization_ai_settings (
      organization_id TEXT PRIMARY KEY REFERENCES saas_organizations(id) ON DELETE CASCADE,
      per_user_monthly_limit INTEGER,
      auto_use_prepaid_credits INTEGER NOT NULL DEFAULT 0,
      auto_credit_bundle INTEGER NOT NULL DEFAULT 1000 CHECK (auto_credit_bundle IN (1000, 5000)),
      updated_by TEXT,
      updated_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS organization_ai_credit_wallet (
      organization_id TEXT PRIMARY KEY REFERENCES saas_organizations(id) ON DELETE CASCADE,
      balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
      updated_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS usage_bonus_allocations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES saas_organizations(id) ON DELETE CASCADE,
      metric TEXT NOT NULL CHECK (metric IN ('ai_requests')),
      period_key TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      source TEXT NOT NULL CHECK (source IN ('manual', 'automatic', 'purchase')),
      created_by TEXT NOT NULL,
      created_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS usage_threshold_events (
      organization_id TEXT NOT NULL REFERENCES saas_organizations(id) ON DELETE CASCADE,
      metric TEXT NOT NULL,
      period_key TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      created_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (organization_id, metric, period_key, threshold)
    )
  `);
  await transaction.run(`
    CREATE TABLE IF NOT EXISTS ai_credit_purchases (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES saas_organizations(id) ON DELETE CASCADE,
      requested_by TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity IN (1000, 5000)),
      amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
      currency TEXT NOT NULL DEFAULT 'TRY',
      status TEXT NOT NULL DEFAULT 'initialized' CHECK (status IN ('initialized', 'paid', 'failed')),
      provider_token TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL UNIQUE,
      checkout_form_content TEXT NOT NULL,
      payment_id TEXT UNIQUE,
      expires_at ${timestamp} NOT NULL,
      completed_at ${timestamp},
      created_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await transaction.run('CREATE INDEX IF NOT EXISTS idx_user_usage_period ON user_usage_counters(organization_id, period_key, email)');
  await transaction.run('CREATE INDEX IF NOT EXISTS idx_usage_bonus_period ON usage_bonus_allocations(organization_id, metric, period_key)');
  await transaction.run('CREATE INDEX IF NOT EXISTS idx_ai_credit_purchases_org ON ai_credit_purchases(organization_id, created_at)');
}

async function upsertPersonalOrganization(transaction: QueryExecutor, email: string, name: string, role: string): Promise<string> {
  const normalizedEmail = email.trim().toLowerCase();
  const organizationId = personalOrganizationId(normalizedEmail);
  const safeRole = ['admin', 'analyst', 'viewer'].includes(role) ? role : 'analyst';
  await transaction.run(
    `INSERT INTO saas_organizations (id, name, slug, owner_email, plan_key)
     VALUES (?, ?, ?, ?, 'starter') ON CONFLICT (id) DO NOTHING`,
    [organizationId, `${name.trim() || normalizedEmail} Çalışma Alanı`, slugFor(normalizedEmail, organizationId), normalizedEmail]
  );
  await transaction.run(
    `INSERT INTO organization_members (organization_id, email, role, status)
     VALUES (?, ?, ?, 'active') ON CONFLICT (organization_id, email) DO NOTHING`,
    [organizationId, normalizedEmail, safeRole]
  );
  return organizationId;
}

async function migrateLegacyData(transaction: QueryExecutor): Promise<void> {
  const users = await transaction.all<{ email: string; name: string; role: string }>('SELECT email, name, role FROM users');
  for (const user of users) {
    const organizationId = await upsertPersonalOrganization(transaction, user.email, user.name, user.role);
    for (const table of BUSINESS_TABLES) {
      await transaction.run(`UPDATE ${table} SET organization_id = ? WHERE organization_id IS NULL AND email = ?`, [organizationId, user.email]);
    }
  }

  for (const table of BUSINESS_TABLES) {
    const orphanEmails = await transaction.all<{ email: string }>(`SELECT DISTINCT email FROM ${table} WHERE organization_id IS NULL`);
    for (const orphan of orphanEmails) {
      const organizationId = await upsertPersonalOrganization(transaction, orphan.email, orphan.email.split('@')[0], 'analyst');
      await transaction.run(`UPDATE ${table} SET organization_id = ? WHERE organization_id IS NULL AND email = ?`, [organizationId, orphan.email]);
    }
  }
}

async function configurePostgresRls(transaction: QueryExecutor): Promise<void> {
  if (transaction.dialect !== 'postgres') return;
  for (const table of BUSINESS_TABLES) {
    await transaction.run(`ALTER TABLE ${table} ALTER COLUMN organization_id SET NOT NULL`);
    await transaction.run(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await transaction.run(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await transaction.run(`DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table}`);
    await transaction.run(`
      CREATE POLICY ${table}_tenant_isolation ON ${table}
      USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), ''))
      WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), ''))
    `);
  }
}

async function suspendPostgresRlsForMigration(transaction: QueryExecutor): Promise<void> {
  if (transaction.dialect !== 'postgres') return;
  for (const table of BUSINESS_TABLES) {
    await transaction.run(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
    await transaction.run(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
  }
}

export async function initializeSchema(): Promise<void> {
  if (database.dialect === 'sqlite') {
    await database.run('PRAGMA foreign_keys = ON');
    await database.run('PRAGMA busy_timeout = 5000');
    if (process.env.DB_PATH !== ':memory:') await database.run('PRAGMA journal_mode = WAL');
  }
  await database.transaction(async (transaction) => {
    if (transaction.dialect === 'postgres') {
      await transaction.run(
        "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
        [SCHEMA_MIGRATION_LOCK]
      );
    }
    await createCoreTables(transaction);
    await createSaasTables(transaction);
    await suspendPostgresRlsForMigration(transaction);
    await migrateLegacyData(transaction);
    await configurePostgresRls(transaction);
  });
  logger.info('SaaS veritabanı şeması hazır.', { dialect: database.dialect });
}
