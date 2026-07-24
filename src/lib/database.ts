import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import pg from 'pg';
import logger from './logger';

export type DatabaseDialect = 'sqlite' | 'postgres';
export type QueryParameters = unknown[];

export interface RunResult {
  changes: number;
  lastID: number;
}

export interface QueryExecutor {
  readonly dialect: DatabaseDialect;
  run(sql: string, parameters?: QueryParameters): Promise<RunResult>;
  get<T>(sql: string, parameters?: QueryParameters): Promise<T | null>;
  all<T>(sql: string, parameters?: QueryParameters): Promise<T[]>;
}

export interface PlatformDatabase extends QueryExecutor {
  transaction<T>(work: (transaction: QueryExecutor) => Promise<T>): Promise<T>;
  tenantTransaction<T>(organizationId: string, work: (transaction: QueryExecutor) => Promise<T>): Promise<T>;
  check(): Promise<boolean>;
  close(): Promise<void>;
}

function postgresSql(sql: string): string {
  let parameter = 0;
  let quote: "'" | '"' | null = null;
  let output = '';
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      output += character;
      if (character === quote && sql[index - 1] !== '\\') quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      output += character;
    } else if (character === '?') {
      output += `$${++parameter}`;
    } else {
      output += character;
    }
  }
  return output;
}

function createSqliteDatabase(): PlatformDatabase {
  const configuredPath = process.env.DB_PATH || (process.env.NODE_ENV === 'test' ? ':memory:' : 'data/reai.db');
  const filename = configuredPath === ':memory:' ? configuredPath : path.resolve(process.cwd(), configuredPath);
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o750 });

  const connection = new sqlite3.Database(filename);
  let queue: Promise<void> = Promise.resolve();
  let closed = false;

  const runDirect = (sql: string, parameters: QueryParameters = []) => new Promise<RunResult>((resolve, reject) => {
    connection.run(sql, parameters, function (this: sqlite3.RunResult, error) {
      if (error) reject(error);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
  const getDirect = <T>(sql: string, parameters: QueryParameters = []) => new Promise<T | null>((resolve, reject) => {
    connection.get(sql, parameters, (error, row) => error ? reject(error) : resolve((row as T) ?? null));
  });
  const allDirect = <T>(sql: string, parameters: QueryParameters = []) => new Promise<T[]>((resolve, reject) => {
    connection.all(sql, parameters, (error, rows) => error ? reject(error) : resolve((rows as T[]) ?? []));
  });
  const executor: QueryExecutor = { dialect: 'sqlite', run: runDirect, get: getDirect, all: allDirect };

  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    dialect: 'sqlite',
    run: (sql, parameters) => serialized(() => runDirect(sql, parameters)),
    get: getDirect,
    all: allDirect,
    transaction: (work) => serialized(async () => {
      await runDirect('BEGIN IMMEDIATE');
      try {
        const result = await work(executor);
        await runDirect('COMMIT');
        return result;
      } catch (error) {
        await runDirect('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }),
    tenantTransaction: (_organizationId, work) => serialized(async () => {
      await runDirect('BEGIN IMMEDIATE');
      try {
        const result = await work(executor);
        await runDirect('COMMIT');
        return result;
      } catch (error) {
        await runDirect('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }),
    check: async () => (await getDirect<{ ok: number }>('SELECT 1 AS ok'))?.ok === 1,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return serialized(async () => {
        if (filename !== ':memory:') await runDirect('PRAGMA wal_checkpoint(TRUNCATE)');
        await new Promise<void>((resolve, reject) => connection.close((error) => error ? reject(error) : resolve()));
      });
    }
  };
}

function createPostgresDatabase(connectionString: string): PlatformDatabase {
  pg.types.setTypeParser(20, (value) => Number(value));
  const pool = new pg.Pool({
    connectionString,
    max: Math.max(2, Math.min(Number(process.env.DATABASE_POOL_SIZE || 10), 30)),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined
  });

  const executorFor = (queryable: pg.Pool | pg.PoolClient): QueryExecutor => ({
    dialect: 'postgres',
    run: async (sql, parameters = []) => {
      const result = await queryable.query(postgresSql(sql), parameters);
      const id = result.rows[0]?.id;
      return { changes: result.rowCount ?? 0, lastID: typeof id === 'number' ? id : Number(id || 0) };
    },
    get: async <T>(sql: string, parameters: QueryParameters = []) => {
      const result = await queryable.query(postgresSql(sql), parameters);
      return (result.rows[0] as T) ?? null;
    },
    all: async <T>(sql: string, parameters: QueryParameters = []) => {
      const result = await queryable.query(postgresSql(sql), parameters);
      return result.rows as T[];
    }
  });
  const root = executorFor(pool);

  const transaction = async <T>(work: (transaction: QueryExecutor) => Promise<T>, organizationId?: string): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (organizationId) {
        await client.query("SELECT set_config('app.current_organization_id', $1, true)", [organizationId]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [organizationId]);
      }
      const result = await work(executorFor(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  pool.on('error', (error) => logger.error('PostgreSQL pool error.', { error }));
  return {
    ...root,
    transaction: (work) => transaction(work),
    tenantTransaction: (organizationId, work) => transaction(work, organizationId),
    check: async () => (await root.get<{ ok: number }>('SELECT 1 AS ok'))?.ok === 1,
    close: () => pool.end()
  };
}

export const database: PlatformDatabase = process.env.DATABASE_URL
  ? createPostgresDatabase(process.env.DATABASE_URL)
  : createSqliteDatabase();

logger.info('Veritabanı sürücüsü yapılandırıldı.', { dialect: database.dialect });
