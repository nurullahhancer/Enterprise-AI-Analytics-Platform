import dns from 'node:dns/promises';
import net from 'node:net';
import { Client, ClientConfig } from 'pg';
import { recordsToCsv, NormalizedTabularData } from '../datasets/normalize';

const DEFAULT_PORT = 5432;
const MAX_QUERY_LENGTH = 10_000;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 100;
const CONNECT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 20_000;

export interface PostgresConnectorConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  query: string;
  sslMode: 'require' | 'verify-full';
}

function allowedHosts(): Set<string> {
  return new Set(
    (process.env.SQL_CONNECTOR_ALLOWED_HOSTS || '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  );
}

function boundedText(value: unknown, field: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  const invalidCharacters = field === 'query' ? /\0/.test(text) : /[\r\n\0]/.test(text);
  if (!text || text.length > maxLength || invalidCharacters) {
    throw new Error(`${field} alanı geçersiz.`);
  }
  return text;
}

export function validateReadOnlyQuery(value: unknown): string {
  let query = boundedText(value, 'query', MAX_QUERY_LENGTH);
  query = query.replace(/;\s*$/, '').trim();
  if (!query || query.includes(';') || !/^(select|with)\b/i.test(query)) {
    throw new Error('SQL sorgusu tek bir SELECT veya salt-okunur WITH sorgusu olmalıdır.');
  }
  if (/\b(insert|update|delete|merge|copy|call|do|alter|create|drop|truncate|grant|revoke|vacuum|analyze|refresh|set|reset|listen|notify|lock)\b/i.test(query)) {
    throw new Error('SQL konnektöründe veri değiştiren veya yönetimsel komutlara izin verilmez.');
  }
  return query;
}

export function parsePostgresConnectorConfig(value: unknown): PostgresConnectorConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PostgreSQL yapılandırması geçersiz.');
  const input = value as Record<string, unknown>;
  const host = boundedText(input.host, 'host', 253).toLowerCase();
  if (host === 'localhost' || host === 'postgres' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Bu PostgreSQL hostuna güvenlik nedeniyle bağlanılamaz.');
  }
  const port = input.port === undefined || input.port === '' ? DEFAULT_PORT : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PostgreSQL portu geçersiz.');
  const sslMode = input.sslMode === 'verify-full' ? 'verify-full' : 'require';
  return {
    host,
    port,
    database: boundedText(input.database, 'database', 128),
    username: boundedText(input.username, 'username', 128),
    password: boundedText(input.password, 'password', 512),
    query: validateReadOnlyQuery(input.query),
    sslMode
  };
}

async function validateAllowedHost(host: string): Promise<void> {
  const allowlist = allowedHosts();
  if (allowlist.size === 0 || !allowlist.has(host)) {
    throw new Error('Bu PostgreSQL hostu sunucu izin listesinde değil.');
  }
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error('PostgreSQL hostu çözümlenemedi.');
  if (addresses.some(({ address }) => {
    if (net.isIPv4(address)) {
      const [a, b] = address.split('.').map(Number);
      return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
    }
    const normalized = address.toLowerCase().split('%')[0];
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
  })) {
    throw new Error('PostgreSQL hostu güvenli olmayan bir ağ adresine çözümleniyor.');
  }
}

function clientConfig(config: PostgresConnectorConfig): ClientConfig {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    application_name: 'reai-readonly-connector',
    ssl: { rejectUnauthorized: config.sslMode === 'verify-full' }
  };
}

export async function queryPostgresAsCsv(
  rawConfig: unknown,
  signal?: AbortSignal
): Promise<NormalizedTabularData> {
  const config = parsePostgresConnectorConfig(rawConfig);
  await validateAllowedHost(config.host);
  if (signal?.aborted) throw new Error('PostgreSQL veri yenileme işlemi durduruldu.');

  const client = new Client(clientConfig(config));
  const abort = () => void client.end().catch(() => undefined);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${QUERY_TIMEOUT_MS}ms'`);
    const result = await client.query({
      text: `SELECT * FROM (${config.query}) AS reai_source LIMIT ${MAX_ROWS + 1}`,
      rowMode: 'array'
    });
    if (result.rows.length > MAX_ROWS) throw new Error(`PostgreSQL sorgusu en fazla ${MAX_ROWS.toLocaleString('tr-TR')} satır döndürebilir.`);
    if (result.fields.length === 0) throw new Error('PostgreSQL sorgusu kolon döndürmedi.');
    if (result.fields.length > MAX_COLUMNS) throw new Error(`PostgreSQL sorgusu en fazla ${MAX_COLUMNS} kolon döndürebilir.`);

    const headers = result.fields.map((field) => field.name);
    const records = result.rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
    return recordsToCsv(records, { maxRows: MAX_ROWS, maxColumns: MAX_COLUMNS });
  } finally {
    signal?.removeEventListener('abort', abort);
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
