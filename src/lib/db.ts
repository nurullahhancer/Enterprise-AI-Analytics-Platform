import sqlite3 from 'sqlite3';
import path from 'path';
import crypto from 'crypto';
import logger from './logger';

const dbPath = path.resolve(process.cwd(), 'reai.db');
const DATASET_TABLE = 'user_datasets_v2';

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    logger.error('SQLite connection error:', err);
  } else {
    logger.info('Connected to SQLite database: reai.db');
  }
});

type RunInfo = { lastID: number; changes: number };

function run(sql: string, params: unknown[] = []): Promise<RunInfo> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (this: sqlite3.RunResult, err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
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
  db.run(
    `
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `,
    (err) => {
      if (err) {
        logger.error('Failed to create users table:', err);
      } else {
        logger.info('users table ready.');
        
        // Seed default user 'a' with password 'a'
        const salt = '1234567890abcdef';
        const hash = crypto.pbkdf2Sync('a', salt, 1000, 64, 'sha512').toString('hex');
        const storedHash = `${salt}:${hash}`;
        
        db.run(
          `INSERT OR IGNORE INTO users (email, name, password_hash) VALUES (?, ?, ?)`,
          ['a', 'a', storedHash],
          (seedErr) => {
            if (seedErr) logger.error('Failed to seed default user:', seedErr);
            else logger.info('Default user seeded: a / a');
          }
        );
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

  // Enterprise additions
  db.run(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'admin'`, () => {});

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

  // Seed default connections, audit logs, and organizations if empty
  db.get("SELECT count(*) as count FROM organizations", (err, row: any) => {
    if (!err && row && row.count === 0) {
      db.run("INSERT INTO organizations (email, name, tenant_id) VALUES (?, ?, ?)", ['a', 'Acme Corp', 'tenant-acme-123']);
      db.run("INSERT INTO organizations (email, name, tenant_id) VALUES (?, ?, ?)", ['a', 'Global Tech Inc', 'tenant-global-456']);
      
      db.run("INSERT INTO audit_logs (email, action, details) VALUES (?, ?, ?)", ['a', 'User Login', 'Kullanıcı sisteme giriş yaptı']);
      db.run("INSERT INTO audit_logs (email, action, details) VALUES (?, ?, ?)", ['a', 'Tenant Switched', 'Acme Corp organizasyonuna geçiş yapıldı']);
      
      db.run("INSERT INTO user_notifications (email, title, message) VALUES (?, ?, ?)", ['a', 'Sistem Hazır', 'ReAI Kurumsal Suite platformu kullanıma hazır.']);
      db.run("INSERT INTO user_notifications (email, title, message) VALUES (?, ?, ?)", ['a', 'Veri Kaynağı Eşitleme', 'Varsayılan SQL konnektör eşitlemesi tamamlandı.']);

      db.run("INSERT INTO user_connections (email, type, name, config) VALUES (?, ?, ?, ?)", [
        'a', 'sql', 'PostgreSQL Müşteri Veritabanı', JSON.stringify({ host: '127.0.0.1', port: 5432, database: 'enterprise_ai', username: 'enterprise', query: 'SELECT * FROM users LIMIT 100' })
      ]);
      db.run("INSERT INTO user_connections (email, type, name, config) VALUES (?, ?, ?, ?)", [
        'a', 'api', 'Hava Durumu REST API', JSON.stringify({ url: 'https://api.weatherapi.com/v1/forecast.json', method: 'GET', headers: '{"Authorization": "Bearer token"}' })
      ]);
    }
  });
});

export interface DbUser {
  email: string;
  name: string;
  password_hash: string;
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

export function createUser(email: string, name: string, passwordHash: string): Promise<void> {
  return run(
    `INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)`,
    [email, name, passwordHash]
  )
    .then(() => undefined)
    .catch((err) => {
      logger.error(`createUser error for ${email}:`, err);
      throw err;
    });
}

export function findUserByEmail(email: string): Promise<DbUser | null> {
  return get<DbUser>(`SELECT * FROM users WHERE email = ?`, [email]).catch((err) => {
    logger.error(`findUserByEmail error for ${email}:`, err);
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
  try {
    await run('BEGIN IMMEDIATE');
    await run(`UPDATE ${DATASET_TABLE} SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE email = ?`, [email]);
    const result = await run(
      `
      INSERT INTO ${DATASET_TABLE} (email, filename, file_content, warning, is_active, row_count, column_count)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `,
      [email, filename, content, warning, rowCount, columnCount]
    );
    await run('COMMIT');
    return result.lastID;
  } catch (err) {
    await run('ROLLBACK').catch(() => undefined);
    logger.error(`saveUserDataset error for ${email}:`, err);
    throw err;
  }
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
    logger.error(`listUserDatasets error for ${email}:`, err);
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
    logger.error(`getUserDatasets error for ${email}:`, err);
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
    logger.error(`getUserActiveDataset error for ${email}:`, err);
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
    logger.error(`getLatestDataset error for ${email}:`, err);
    throw err;
  });
}

export async function setActiveDataset(email: string, id: number): Promise<boolean> {
  const dataset = await getUserDataset(email, id);
  if (!dataset) return false;

  try {
    await run('BEGIN IMMEDIATE');
    await run(`UPDATE ${DATASET_TABLE} SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE email = ?`, [email]);
    await run(`UPDATE ${DATASET_TABLE} SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE email = ? AND id = ?`, [email, id]);
    await run('COMMIT');
    return true;
  } catch (err) {
    await run('ROLLBACK').catch(() => undefined);
    logger.error(`setActiveDataset error id=${id}:`, err);
    throw err;
  }
}

async function activateLatestDataset(email: string): Promise<void> {
  const latest = await getLatestDataset(email);
  if (latest) await setActiveDataset(email, latest.id);
}

export async function deleteDataset(email: string, id: number): Promise<boolean> {
  const dataset = await getUserDataset(email, id);
  if (!dataset) return false;

  const result = await run(`DELETE FROM ${DATASET_TABLE} WHERE id = ? AND email = ?`, [id, email]).catch((err) => {
    logger.error(`deleteDataset error id=${id}:`, err);
    throw err;
  });

  if (result.changes > 0 && dataset.is_active === 1) {
    await activateLatestDataset(email);
  }

  return result.changes > 0;
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
      logger.error(`deleteAllDatasets error for ${email}:`, err);
      throw err;
    });
}

export async function updateUser(email: string, name: string, passwordHash?: string): Promise<void> {
  if (passwordHash) {
    await run(`UPDATE users SET name = ?, password_hash = ? WHERE email = ?`, [name, passwordHash, email]);
  } else {
    await run(`UPDATE users SET name = ? WHERE email = ?`, [name, email]);
  }
}

export async function deleteUser(email: string): Promise<void> {
  try {
    await run('BEGIN IMMEDIATE');
    await run(`DELETE FROM ${DATASET_TABLE} WHERE email = ?`, [email]);
    await run(`DELETE FROM users WHERE email = ?`, [email]);
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK').catch(() => undefined);
    logger.error(`deleteUser error for ${email}:`, err);
    throw err;
  }
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
  return all<any>(`SELECT * FROM user_documents WHERE email = ? ORDER BY id DESC`, [email]);
}

export function saveDocument(email: string, filename: string, content: string, chunksCount: number): Promise<number> {
  return run(
    `INSERT INTO user_documents (email, filename, content, chunks_count, status) VALUES (?, ?, ?, ?, 'indexed')`,
    [email, filename, content, chunksCount]
  ).then((r) => r.lastID);
}

export function deleteDocument(email: string, id: number): Promise<boolean> {
  return run(`DELETE FROM user_documents WHERE id = ? AND email = ?`, [id, email]).then((r) => r.changes > 0);
}

// Enterprise audit logs helpers
export function listAuditLogs(email: string): Promise<any[]> {
  return all<any>(`SELECT * FROM audit_logs WHERE email = ? ORDER BY id DESC`, [email]);
}

export function addAuditLog(email: string, action: string, details: string, ipAddress: string = '127.0.0.1'): Promise<number> {
  return run(
    `INSERT INTO audit_logs (email, action, details, ip_address) VALUES (?, ?, ?, ?)`,
    [email, action, details, ipAddress]
  ).then((r) => r.lastID);
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
  return get<{ role: string }>(`SELECT role FROM users WHERE email = ?`, [email]).then((r) => r?.role ?? 'admin');
}

export function updateUserRole(email: string, role: string): Promise<boolean> {
  return run(`UPDATE users SET role = ? WHERE email = ?`, [role, email]).then((r) => r.changes > 0);
}

// Enterprise notification helpers
export function listNotifications(email: string): Promise<any[]> {
  return all<any>(`SELECT * FROM user_notifications WHERE email = ? ORDER BY id DESC`, [email]);
}

export function addNotification(email: string, title: string, message: string): Promise<number> {
  return run(
    `INSERT INTO user_notifications (email, title, message) VALUES (?, ?, ?)`,
    [email, title, message]
  ).then((r) => r.lastID);
}

export function markNotificationsRead(email: string): Promise<boolean> {
  return run(`UPDATE user_notifications SET read_status = 1 WHERE email = ?`, [email]).then((r) => r.changes > 0);
}

export const saveDataset = saveUserDataset;
export const listDatasets = listUserDatasets;
export const getDataset = getUserDataset;

