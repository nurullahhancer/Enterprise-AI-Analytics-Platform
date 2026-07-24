import { describe, expect, it } from 'vitest';
import { parsePostgresConnectorConfig, validateReadOnlyQuery } from './postgres';

describe('PostgreSQL connector guardrails', () => {
  it('accepts a bounded read-only query and normalizes the connection fields', () => {
    expect(parsePostgresConnectorConfig({
      host: 'DB.EXAMPLE.COM',
      port: '5432',
      database: 'analytics',
      username: 'reai_reader',
      password: 'secret-value',
      query: 'SELECT date, revenue FROM public.sales;',
      sslMode: 'verify-full'
    })).toEqual({
      host: 'db.example.com',
      port: 5432,
      database: 'analytics',
      username: 'reai_reader',
      password: 'secret-value',
      query: 'SELECT date, revenue FROM public.sales',
      sslMode: 'verify-full'
    });
  });

  it.each([
    'DELETE FROM public.sales',
    'SELECT 1; SELECT 2',
    'WITH removed AS (DELETE FROM public.sales RETURNING *) SELECT * FROM removed',
    'COPY public.sales TO STDOUT'
  ])('rejects unsafe SQL: %s', (query) => {
    expect(() => validateReadOnlyQuery(query)).toThrow();
  });

  it('rejects local platform database targets', () => {
    expect(() => parsePostgresConnectorConfig({
      host: 'postgres', database: 'reai', username: 'reader', password: 'secret', query: 'SELECT 1'
    })).toThrow(/güvenlik/);
  });
});
