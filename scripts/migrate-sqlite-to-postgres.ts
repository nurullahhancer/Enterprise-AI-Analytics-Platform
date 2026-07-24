import path from 'node:path';
import sqlite3 from 'sqlite3';
import pg from 'pg';

const sourcePath = path.resolve(process.cwd(), process.env.SOURCE_DB_PATH || 'data/reai.db');
const targetUrl = process.env.DATABASE_URL;
if (!targetUrl) throw new Error('DATABASE_URL zorunludur.');

const source = new sqlite3.Database(sourcePath, sqlite3.OPEN_READONLY);
const target = new pg.Client({ connectionString: targetUrl });
const tables = [
  'users',
  'saas_organizations',
  'organization_members',
  'organization_invitations',
  'auth_action_tokens',
  'organization_subscriptions',
  'billing_checkouts',
  'billing_events',
  'usage_counters',
  'user_datasets_v2',
  'user_connections',
  'user_documents',
  'audit_logs',
  'user_notifications'
];
const businessTables = ['user_datasets_v2', 'user_connections', 'user_documents', 'audit_logs', 'user_notifications'];

function quote(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) throw new Error(`Geçersiz SQL tanımlayıcısı: ${identifier}`);
  return `"${identifier}"`;
}

function sourceAll<T>(sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => source.all(sql, (error, rows) => error ? reject(error) : resolve(rows as T[])));
}

async function columnsFor(table: string): Promise<string[]> {
  const sourceColumns = new Set((await sourceAll<{ name: string }>(`PRAGMA table_info(${quote(table)})`)).map((column) => column.name));
  const targetColumns = (await target.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table]
  )).rows.map((column) => column.column_name);
  return targetColumns.filter((column) => sourceColumns.has(column));
}

async function copyTable(table: string): Promise<number> {
  const columns = await columnsFor(table);
  if (columns.length === 0) return 0;
  const rows = await sourceAll<Record<string, unknown>>(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)}`);
  for (const row of rows) {
    const values = columns.map((column) => row[column]);
    const placeholders = values.map((_, index) => `$${index + 1}`).join(',');
    await target.query(
      `INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
      values
    );
  }
  return rows.length;
}

async function main(): Promise<void> {
  await target.connect();
  try {
    await target.query('BEGIN');
    const existingUsers = Number((await target.query('SELECT COUNT(*) AS count FROM users')).rows[0].count);
    if (existingUsers > 0 && process.env.ALLOW_NONEMPTY_TARGET !== 'true') {
      throw new Error('Hedef PostgreSQL boş değil. Birleştirme yapılmadı.');
    }
    for (const table of businessTables) {
      await target.query(`ALTER TABLE ${quote(table)} NO FORCE ROW LEVEL SECURITY`);
      await target.query(`ALTER TABLE ${quote(table)} DISABLE ROW LEVEL SECURITY`);
    }

    for (const table of tables) {
      const sourceCount = Number((await sourceAll<{ count: number }>(`SELECT COUNT(*) AS count FROM ${quote(table)}`))[0]?.count || 0);
      await copyTable(table);
      const targetCount = Number((await target.query(`SELECT COUNT(*) AS count FROM ${quote(table)}`)).rows[0].count);
      if (targetCount < sourceCount) throw new Error(`${table} doğrulaması başarısız: kaynak=${sourceCount}, hedef=${targetCount}`);
      process.stdout.write(`${table}: ${sourceCount} kayıt doğrulandı.\n`);
    }

    for (const table of ['user_datasets_v2', 'user_connections', 'user_documents', 'audit_logs', 'user_notifications']) {
      await target.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${quote(table)}), 1), true)`, [table]);
      await target.query(`ALTER TABLE ${quote(table)} ENABLE ROW LEVEL SECURITY`);
      await target.query(`ALTER TABLE ${quote(table)} FORCE ROW LEVEL SECURITY`);
    }
    await target.query('COMMIT');
  } catch (error) {
    await target.query('ROLLBACK');
    throw error;
  } finally {
    await target.end();
    await new Promise<void>((resolve) => source.close(() => resolve()));
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
