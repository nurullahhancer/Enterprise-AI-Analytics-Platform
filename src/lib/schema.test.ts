import { beforeAll, describe, expect, it } from 'vitest';
import { database } from './database';
import { databaseReady } from './db';
import { initializeSchema, personalOrganizationId } from './schema';

describe('transactional schema migration', () => {
  beforeAll(async () => {
    await databaseReady;
  });

  it('is idempotent and installs connector sync lease storage', async () => {
    await expect(initializeSchema()).resolves.toBeUndefined();

    const columns = await database.all<{ name: string }>('PRAGMA table_info(user_connections)');
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'sync_lease_id',
      'sync_lease_expires_at'
    ]));
    const notificationColumns = await database.all<{ name: string }>('PRAGMA table_info(organization_notification_settings)');
    expect(notificationColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'organization_id', 'email_enabled', 'events_json'
    ]));
    const dashboardColumns = await database.all<{ name: string }>('PRAGMA table_info(dashboard_preferences)');
    expect(dashboardColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'organization_id', 'email', 'widget_order_json', 'hidden_widgets_json'
    ]));
    const governanceColumns = await database.all<{ name: string }>('PRAGMA table_info(organization_data_policies)');
    expect(governanceColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'organization_id', 'retention_enabled', 'retention_days', 'last_applied_at'
    ]));

    const indexes = await database.all<{ name: string }>('PRAGMA index_list(user_connections)');
    expect(indexes.map((index) => index.name)).toContain('idx_connections_sync_lease');
    for (const table of ['user_usage_counters', 'organization_ai_settings', 'organization_ai_credit_wallet', 'usage_bonus_allocations', 'usage_threshold_events', 'ai_credit_purchases']) {
      const row = await database.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
      expect(row?.name).toBe(table);
    }
  });

  it('backfills legacy business rows inside the schema migration', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const email = `legacy-schema-${suffix}@example.test`;
    await database.run(
      `INSERT INTO users (email, name, password_hash, role)
       VALUES (?, 'Legacy Schema', 'unused-test-hash', 'analyst')`,
      [email]
    );
    await database.run(
      `INSERT INTO user_connections (organization_id, email, type, name, config)
       VALUES (NULL, ?, 'api', 'Legacy REST', 'legacy-test-config')`,
      [email]
    );

    await initializeSchema();

    const connection = await database.get<{ organization_id: string }>(
      'SELECT organization_id FROM user_connections WHERE email = ?',
      [email]
    );
    expect(connection?.organization_id).toBe(personalOrganizationId(email));
  });
});
