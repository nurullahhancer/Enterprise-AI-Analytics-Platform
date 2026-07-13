import sqlite3 from 'sqlite3';
import fs from 'node:fs';
import path from 'path';
import logger from './logger';

const configuredDbPath = process.env.DB_PATH || (process.env.NODE_ENV === 'test' ? ':memory:' : 'data/reai.db');
const dbPath = configuredDbPath === ':memory:' ? configuredDbPath : path.resolve(process.cwd(), configuredDbPath);
const DATASET_TABLE = 'user_datasets_v2';

if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o750 });

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    logger.error('SQLite connection error:', err);
  } else {
    logger.info('SQLite database connection established.');
  }
});

type RunInfo = { lastID: number; changes: number };

function runDirect(sql: string, params: unknown[] = []): Promise<RunInfo> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (this: sqlite3.RunResult, err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

let writeQueue: Promise<void> = Promise.resolve();

function serializeWrite<T>(work: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(work);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

function run(sql: string, params: unknown[] = []): Promise<RunInfo> {
  return serializeWrite(() => runDirect(sql, params));
}

function withTransaction<T>(work: () => Promise<T>): Promise<T> {
  return serializeWrite(async () => {
    let transactionStarted = false;
    try {
      await runDirect('BEGIN IMMEDIATE');
      transactionStarted = true;
      const result = await work();
      await runDirect('COMMIT');
      return result;
    } catch (err) {
      if (transactionStarted) await runDirect('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
}

function get<T>(sql: string, params: unknown[] = []): Promise<T | null> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve((row as T) || null);
    });
  });
}

function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve((rows as T[]) || []);
    });
  });
}

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA busy_timeout = 5000');
  if (configuredDbPath !== ':memory:') db.run('PRAGMA journal_mode = WAL');

  db.run(
    `
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin', 'analyst', 'viewer')),
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `,
    (err) => {
      if (err) {
        logger.error('Failed to create users table:', err);
      } else {
        logger.info('users table ready.');
      }
    }
  );

  db.run(
    `
    CREATE TABLE IF NOT EXISTS ${DATASET_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_content TEXT NOT NULL,
      warning TEXT,
      is_active INTEGER DEFAULT 1,
      row_count INTEGER DEFAULT 0,
      column_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `,
    (err) => {
      if (err) logger.error(`Failed to create ${DATASET_TABLE} table:`, err);
      else logger.info(`${DATASET_TABLE} table ready.`);
    }
  );

  db.run(
    `
    INSERT INTO ${DATASET_TABLE} (email, filename, file_content, warning, is_active, row_count, column_count, created_at, updated_at)
    SELECT d.email, d.filename, d.file_content, d.warning, 0, d.row_count, d.column_count, d.created_at, d.created_at
    FROM datasets d
    WHERE NOT EXISTS (
      SELECT 1
      FROM ${DATASET_TABLE} v2
      WHERE v2.email = d.email
        AND v2.filename = d.filename
        AND v2.created_at = d.created_at
    )
  `,
    (err) => {
      if (!err) logger.info('Migration from datasets to user_datasets_v2 complete (if applicable).');
    }
  );

  db.run(
    `
    INSERT INTO ${DATASET_TABLE} (email, filename, file_content, warning, is_active, row_count, column_count, created_at, updated_at)
    SELECT ud.email, ud.filename, ud.file_content, ud.warning, 0, 0, 0, ud.updated_at, ud.updated_at
    FROM user_datasets ud
    WHERE NOT EXISTS (
      SELECT 1
      FROM ${DATASET_TABLE} v2
      WHERE v2.email = ud.email
        AND v2.filename = ud.filename
        AND v2.file_content = ud.file_content
    )
  `,
    (err) => {
      if (!err) logger.info('Migration from user_datasets to user_datasets_v2 complete (if applicable).');
    }
  );

  db.run(
    `
    UPDATE ${DATASET_TABLE}
    SET is_active = CASE
      WHEN id = (
        SELECT latest.id
        FROM ${DATASET_TABLE} latest
        WHERE latest.email = ${DATASET_TABLE}.email
        ORDER BY datetime(latest.created_at) DESC, latest.id DESC
        LIMIT 1
      ) THEN 1
      ELSE 0
    END
    WHERE email IN (
      SELECT email
      FROM ${DATASET_TABLE}
      GROUP BY email
      HAVING SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) != 1
    )
  `,
    (err) => {
      if (err) logger.error('Failed to normalize active dataset flags:', err);
    }
  );

  // Idempotent compatibility migrations for databases created by older builds.
  db.run(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'analyst'`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0`, () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS user_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      chunks_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'indexed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      ip_address TEXT DEFAULT '127.0.0.1',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS organizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      tenant_id TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      read_status INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_datasets_email ON ${DATASET_TABLE}(email)`);
  db.run('CREATE INDEX IF NOT EXISTS idx_connections_email ON user_connections(email)');
  db.run('CREATE INDEX IF NOT EXISTS idx_documents_email ON user_documents(email)');
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_email_created ON audit_logs(email, created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_notifications_email_created ON user_notifications(email, created_at)');
});

export const databaseReady = new Promise<void>((resolve, reject) => {
  db.serialize(() => {
    db.get('SELECT 1', (err) => err ? reject(err) : resolve());
  });
});

export interface DbUser {
  email: string;
  name: string;
  password_hash: string;
  role: 'admin' | 'analyst' | 'viewer';
  token_version: number;
  created_at: string;
}

export interface Dataset {
  id: number;
  email: string;
  filename: string;
  file_content: string;
  warning: string | null;
  is_active: number;
  row_count: number;
  column_count: number;
  created_at: string;
  updated_at: string;
}

export interface DatasetMeta {
  id: number;
  email: string;
  filename: string;
  warning: string | null;
  is_active: number;
  row_count: number;
  column_count: number;
  created_at: string;
  updated_at: string;
}

export class StorageQuotaError extends Error {
  code: 'DATASET_QUOTA_EXCEEDED' | 'DOCUMENT_QUOTA_EXCEEDED';

  constructor(code: StorageQuotaError['code'], message: string) {
    super(message);
    this.name = 'StorageQuotaError';
    this.code = code;
  }
}

export class LastAdminError extends Error {
  constructor() {
    super('Son yönetici rolü düşürülemez veya hesabı silinemez.');
    this.name = 'LastAdminError';
  }
}

function boundedEnvInt(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name] || fallback);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

export function createUser(
  email: string,
  name: string,
  passwordHash: string,
  role: DbUser['role'] = 'analyst'
): Promise<void> {
  return run(
    `INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)`,
    [email, name, passwordHash, role]
  )
    .then(() => undefined)
    .catch((err) => {
      logger.error('createUser database error.', err);
      throw err;
    });
}

export function findUserByEmail(email: string): Promise<DbUser | null> {
  return get<DbUser>(`SELECT * FROM users WHERE email = ?`, [email]).catch((err) => {
    logger.error('findUserByEmail database error.', err);
    throw err;
  });
}

export async function saveUserDataset(
  email: string,
  filename: string,
  content: string,
  warning = '',
  rowCount = 0,
  columnCount = 0
): Promise<number> {
  return withTransaction(async () => {
    const usage = await get<{ count: number; chars: number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(file_content)), 0) AS chars FROM ${DATASET_TABLE} WHERE email = ?`,
      [email]
    );
    const maxCount = boundedEnvInt('MAX_DATASET_COUNT', 50, 1, 500);
    const maxTotalChars = boundedEnvInt('MAX_DATASET_TOTAL_CHARS', 20_000_000, 100_000, 100_000_000);
    if ((usage?.count ?? 0) >= maxCount || (usage?.chars ?? 0) + content.length > maxTotalChars) {
      throw new StorageQuotaError(
        'DATASET_QUOTA_EXCEEDED',
        `Veri seti kotası aşıldı (en fazla ${maxCount} dosya ve toplam ${maxTotalChars} karakter).`
      );
    }
    await runDirect(`UPDATE ${DATASET_TABLE} SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE email = ?`, [email]);
    const result = await runDirect(
      `INSERT INTO ${DATASET_TABLE} (email, filename, file_content, warning, is_active, row_count, column_count)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [email, filename, content, warning, rowCount, columnCount]
    );
    return result.lastID;
  }).catch((err) => {
    logger.error('saveUserDataset database error.', err);
    throw err;
  });
}

export function listUserDatasets(email: string): Promise<DatasetMeta[]> {
  return all<DatasetMeta>(
    `
    SELECT id, email, filename, warning, is_active, row_count, column_count, created_at, updated_at
    FROM ${DATASET_TABLE}
    WHERE email = ?
    ORDER BY is_active DESC, datetime(created_at) DESC, id DESC
  `,
    [email]
  ).catch((err) => {
    logger.error('listUserDatasets database error.', err);
    throw err;
  });
}

export function getUserDatasets(email: string): Promise<Dataset[]> {
  return all<Dataset>(
    `
    SELECT *
    FROM ${DATASET_TABLE}
    WHERE email = ?
    ORDER BY datetime(created_at) ASC, id ASC
  `,
    [email]
  ).catch((err) => {
    logger.error('getUserDatasets database error.', err);
    throw err;
  });
}

export function getUserDataset(email: string, id: number): Promise<Dataset | null> {
  return get<Dataset>(`SELECT * FROM ${DATASET_TABLE} WHERE id = ? AND email = ?`, [id, email]).catch((err) => {
    logger.error(`getUserDataset error id=${id}:`, err);
    throw err;
  });
}

export async function getUserActiveDataset(email: string): Promise<Dataset | null> {
  const active = await get<Dataset>(
    `
    SELECT *
    FROM ${DATASET_TABLE}
    WHERE email = ? AND is_active = 1
    ORDER BY datetime(updated_at) DESC, id DESC
    LIMIT 1
  `,
    [email]
  ).catch((err) => {
    logger.error('getUserActiveDataset database error.', err);
    throw err;
  });

  return active || getLatestDataset(email);
}

export function getLatestDataset(email: string): Promise<Dataset | null> {
  return get<Dataset>(
    `
    SELECT *
    FROM ${DATASET_TABLE}
    WHERE email = ?
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 1
  `,
    [email]
  ).catch((err) => {
    logger.error('getLatestDataset database error.', err);
    throw err;
  });
}

export async function setActiveDataset(email: string, id: number): Promise<boolean> {
  return withTransaction(async () => {
    const dataset = await get<Dataset>(`SELECT * FROM ${DATASET_TABLE} WHERE id = ? AND email = ?`, [id, email]);
    if (!dataset) return false;
    await runDirect(`UPDATE ${DATASET_TABLE} SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE email = ?`, [email]);
    await runDirect(`UPDATE ${DATASET_TABLE} SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE email = ? AND id = ?`, [email, id]);
    return true;
  }).catch((err) => {
    logger.error(`setActiveDataset error id=${id}:`, err);
    throw err;
  });
}

export async function deleteDataset(email: string, id: number): Promise<boolean> {
  return withTransaction(async () => {
    const dataset = await get<Dataset>(`SELECT * FROM ${DATASET_TABLE} WHERE id = ? AND email = ?`, [id, email]);
    if (!dataset) return false;
    const result = await runDirect(`DELETE FROM ${DATASET_TABLE} WHERE id = ? AND email = ?`, [id, email]);
    if (result.changes > 0 && dataset.is_active === 1) {
      const latest = await get<Pick<Dataset, 'id'>>(
        `SELECT id FROM ${DATASET_TABLE} WHERE email = ? ORDER BY datetime(created_at) DESC, id DESC LIMIT 1`,
        [email]
      );
      if (latest) {
        await runDirect(`UPDATE ${DATASET_TABLE} SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE email = ?`, [email]);
        await runDirect(`UPDATE ${DATASET_TABLE} SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE email = ? AND id = ?`, [email, latest.id]);
      }
    }
    return result.changes > 0;
  }).catch((err) => {
    logger.error(`deleteDataset error id=${id}:`, err);
    throw err;
  });
}

export async function deleteActiveDataset(email: string): Promise<boolean> {
  const active = await getUserActiveDataset(email);
  if (!active) return false;
  return deleteDataset(email, active.id);
}

export function deleteAllDatasets(email: string): Promise<number> {
  return run(`DELETE FROM ${DATASET_TABLE} WHERE email = ?`, [email])
    .then((result) => result.changes)
    .catch((err) => {
      logger.error('deleteAllDatasets database error.', err);
      throw err;
    });
}

export async function updateUser(email: string, name: string, passwordHash?: string): Promise<void> {
  if (passwordHash) {
    await run(
      `UPDATE users SET name = ?, password_hash = ?, token_version = token_version + 1 WHERE email = ?`,
      [name, passwordHash, email]
    );
  } else {
    await run(`UPDATE users SET name = ? WHERE email = ?`, [name, email]);
  }
}

export async function revokeUserTokens(email: string): Promise<boolean> {
  const result = await run(
    `UPDATE users SET token_version = token_version + 1 WHERE email = ?`,
    [email]
  );
  return result.changes > 0;
}

export async function deleteUser(email: string): Promise<void> {
  return withTransaction(async () => {
    const user = await get<Pick<DbUser, 'role'>>('SELECT role FROM users WHERE email = ?', [email]);
    if (user?.role === 'admin') {
      const adminCount = await get<{ count: number }>(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`);
      if ((adminCount?.count ?? 0) <= 1) throw new LastAdminError();
    }
    await runDirect(`DELETE FROM ${DATASET_TABLE} WHERE email = ?`, [email]);
    await runDirect('DELETE FROM user_connections WHERE email = ?', [email]);
    await runDirect('DELETE FROM user_documents WHERE email = ?', [email]);
    await runDirect('DELETE FROM organizations WHERE email = ?', [email]);
    await runDirect('DELETE FROM user_notifications WHERE email = ?', [email]);
    await runDirect('DELETE FROM audit_logs WHERE email = ?', [email]);
    await runDirect(`DELETE FROM users WHERE email = ?`, [email]);
  }).catch((err) => {
    if (err instanceof LastAdminError) {
      logger.warn('Son yönetici hesabını silme girişimi engellendi.');
    } else {
      logger.error('deleteUser database error.', err);
    }
    throw err;
  });
}

// Enterprise connection helpers
export function listConnections(email: string): Promise<any[]> {
  return all<any>(`SELECT * FROM user_connections WHERE email = ? ORDER BY id DESC`, [email]);
}

export function getConnection(email: string, id: number): Promise<any | null> {
  return get<any>(`SELECT * FROM user_connections WHERE id = ? AND email = ?`, [id, email]);
}

export function createConnection(email: string, type: string, name: string, config: string): Promise<number> {
  return run(
    `INSERT INTO user_connections (email, type, name, config) VALUES (?, ?, ?, ?)`,
    [email, type, name, config]
  ).then((r) => r.lastID);
}

export function deleteConnection(email: string, id: number): Promise<boolean> {
  return run(`DELETE FROM user_connections WHERE id = ? AND email = ?`, [id, email]).then((r) => r.changes > 0);
}

// Enterprise documents (RAG) helpers
export function listDocuments(email: string): Promise<any[]> {
  return all<any>(
    `SELECT id, email, filename, chunks_count, status, created_at FROM user_documents WHERE email = ? ORDER BY id DESC`,
    [email]
  );
}

export function getDocumentsForSearch(email: string): Promise<any[]> {
  return all<any>(
    `SELECT id, filename, content, chunks_count, status, created_at FROM user_documents WHERE email = ? ORDER BY id DESC`,
    [email]
  );
}

export function saveDocument(email: string, filename: string, content: string, chunksCount: number): Promise<number> {
  return withTransaction(async () => {
    const usage = await get<{ count: number; chars: number }>(
      'SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(content)), 0) AS chars FROM user_documents WHERE email = ?',
      [email]
    );
    const maxCount = boundedEnvInt('MAX_DOCUMENT_COUNT', 50, 1, 500);
    const maxTotalChars = boundedEnvInt('MAX_DOCUMENT_TOTAL_CHARS', 2_000_000, 10_000, 20_000_000);
    if ((usage?.count ?? 0) >= maxCount || (usage?.chars ?? 0) + content.length > maxTotalChars) {
      throw new StorageQuotaError(
        'DOCUMENT_QUOTA_EXCEEDED',
        `Doküman kotası aşıldı (en fazla ${maxCount} dosya ve toplam ${maxTotalChars} karakter).`
      );
    }
    const result = await runDirect(
      `INSERT INTO user_documents (email, filename, content, chunks_count, status) VALUES (?, ?, ?, ?, 'indexed')`,
      [email, filename, content, chunksCount]
    );
    return result.lastID;
  });
}

export function deleteDocument(email: string, id: number): Promise<boolean> {
  return run(`DELETE FROM user_documents WHERE id = ? AND email = ?`, [id, email]).then((r) => r.changes > 0);
}

// Enterprise audit logs helpers
export function listAuditLogs(email: string): Promise<any[]> {
  return all<any>(`SELECT * FROM audit_logs WHERE email = ? ORDER BY id DESC LIMIT 200`, [email]);
}

export function addAuditLog(email: string, action: string, details: string, ipAddress: string = '127.0.0.1'): Promise<number> {
  return withTransaction(async () => {
    const usage = await get<{ count: number }>('SELECT COUNT(*) AS count FROM audit_logs WHERE email = ?', [email]);
    const maxEntries = boundedEnvInt('AUDIT_MAX_ENTRIES_PER_USER', 2_000, 100, 100_000);
    if ((usage?.count ?? 0) >= maxEntries) throw new Error('AUDIT_QUOTA_EXCEEDED');
    const result = await runDirect(
      `INSERT INTO audit_logs (email, action, details, ip_address) VALUES (?, ?, ?, ?)`,
      [email, action, details, ipAddress]
    );
    return result.lastID;
  });
}

// Enterprise organization (tenant) helpers
export function listOrganizations(email: string): Promise<any[]> {
  return all<any>(`SELECT * FROM organizations WHERE email = ? ORDER BY id ASC`, [email]);
}

export function createOrganization(email: string, name: string, tenantId: string): Promise<number> {
  return run(
    `INSERT INTO organizations (email, name, tenant_id) VALUES (?, ?, ?)`,
    [email, name, tenantId]
  ).then((r) => r.lastID);
}

// Enterprise user role helpers
export function getUserRole(email: string): Promise<string> {
  return get<{ role: string }>(`SELECT role FROM users WHERE email = ?`, [email]).then((r) => r?.role ?? 'analyst');
}

export function updateUserRole(email: string, role: DbUser['role']): Promise<boolean> {
  return changeUserRole(email, role).then((result) => result === 'updated');
}

export function changeUserRole(
  email: string,
  role: DbUser['role']
): Promise<'updated' | 'not_found' | 'last_admin'> {
  return withTransaction(async () => {
    const target = await get<Pick<DbUser, 'role'>>('SELECT role FROM users WHERE email = ?', [email]);
    if (!target) return 'not_found';
    if (target.role === 'admin' && role !== 'admin') {
      const adminCount = await get<{ count: number }>(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`);
      if ((adminCount?.count ?? 0) <= 1) return 'last_admin';
    }
    await runDirect(
      `UPDATE users SET role = ?, token_version = token_version + 1 WHERE email = ?`,
      [role, email]
    );
    return 'updated';
  });
}

export function listUsers(): Promise<Array<Pick<DbUser, 'email' | 'name' | 'role' | 'created_at'>>> {
  return all(`SELECT email, name, role, created_at FROM users ORDER BY datetime(created_at), email`);
}

export async function checkDatabase(): Promise<boolean> {
  try {
    await databaseReady;
    if ((await get<{ ok: number }>('SELECT 1 AS ok'))?.ok !== 1) return false;
    const tables = await all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', '${DATASET_TABLE}', 'user_connections', 'user_documents', 'audit_logs', 'organizations', 'user_notifications')`
    );
    if (tables.length !== 7) return false;
    const userColumns = new Set((await all<{ name: string }>('PRAGMA table_info(users)')).map((column) => column.name));
    const datasetColumns = new Set((await all<{ name: string }>(`PRAGMA table_info(${DATASET_TABLE})`)).map((column) => column.name));
    return ['email', 'password_hash', 'role', 'token_version'].every((column) => userColumns.has(column)) &&
      ['id', 'email', 'filename', 'file_content', 'is_active'].every((column) => datasetColumns.has(column));
  } catch {
    return false;
  }
}

let closePromise: Promise<void> | null = null;

export function closeDatabase(): Promise<void> {
  if (closePromise) return closePromise;
  closePromise = serializeWrite(async () => {
    if (configuredDbPath !== ':memory:') {
      await new Promise<void>((resolve, reject) => {
        db.get('PRAGMA wal_checkpoint(TRUNCATE)', (err) => err ? reject(err) : resolve());
      });
    }
    await new Promise<void>((resolve, reject) => {
      db.close((err) => err ? reject(err) : resolve());
    });
  });
  return closePromise;
}

// Enterprise notification helpers
export function listNotifications(email: string): Promise<any[]> {
  return all<any>(`SELECT * FROM user_notifications WHERE email = ? ORDER BY id DESC LIMIT 100`, [email]);
}

export function addNotification(email: string, title: string, message: string): Promise<number> {
  return withTransaction(async () => {
    const usage = await get<{ count: number }>('SELECT COUNT(*) AS count FROM user_notifications WHERE email = ?', [email]);
    const maxEntries = boundedEnvInt('NOTIFICATION_MAX_ENTRIES_PER_USER', 500, 50, 10_000);
    if ((usage?.count ?? 0) >= maxEntries) throw new Error('NOTIFICATION_QUOTA_EXCEEDED');
    const result = await runDirect(
      `INSERT INTO user_notifications (email, title, message) VALUES (?, ?, ?)`,
      [email, title, message]
    );
    return result.lastID;
  });
}

export function markNotificationsRead(email: string): Promise<boolean> {
  return run(`UPDATE user_notifications SET read_status = 1 WHERE email = ?`, [email]).then((r) => r.changes > 0);
}

export const saveDataset = saveUserDataset;
export const listDatasets = listUserDatasets;
export const getDataset = getUserDataset;
