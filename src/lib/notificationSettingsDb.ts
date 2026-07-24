import { database } from './database';
import { databaseReady, resolveOrganizationScope } from './db';
import { decryptConnectorConfig, encryptConnectorConfig } from './secrets';

export type BusinessAlertEvent = 'kpi_breach' | 'kpi_recovery' | 'connector_failure' | 'connector_recovery' | 'billing';
export const BUSINESS_ALERT_EVENTS: BusinessAlertEvent[] = ['kpi_breach', 'kpi_recovery', 'connector_failure', 'connector_recovery', 'billing'];

interface NotificationSettingsRow {
  organization_id: string;
  email: string;
  email_enabled: number;
  slack_webhook_encrypted: string | null;
  teams_webhook_encrypted: string | null;
  events_json: string;
  updated_at: string;
}

export interface NotificationSettings {
  organizationId: string;
  emailEnabled: boolean;
  slackConfigured: boolean;
  teamsConfigured: boolean;
  events: BusinessAlertEvent[];
  updatedAt: string | null;
}

export interface NotificationDestinations extends NotificationSettings {
  slackWebhook: string | null;
  teamsWebhook: string | null;
}

function events(value: string | null | undefined): BusinessAlertEvent[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed)
      ? BUSINESS_ALERT_EVENTS.filter((event) => parsed.includes(event))
      : [...BUSINESS_ALERT_EVENTS];
  } catch {
    return [...BUSINESS_ALERT_EVENTS];
  }
}

function publicSettings(row: NotificationSettingsRow | null, organizationId: string): NotificationSettings {
  return {
    organizationId,
    emailEnabled: Boolean(row?.email_enabled),
    slackConfigured: Boolean(row?.slack_webhook_encrypted),
    teamsConfigured: Boolean(row?.teams_webhook_encrypted),
    events: row ? events(row.events_json) : [...BUSINESS_ALERT_EVENTS],
    updatedAt: row?.updated_at || null
  };
}

export async function getNotificationSettings(scope: string): Promise<NotificationSettings> {
  await databaseReady;
  const organizationId = await resolveOrganizationScope(scope);
  const row = await database.tenantTransaction(organizationId, (transaction) => transaction.get<NotificationSettingsRow>(
    'SELECT * FROM organization_notification_settings WHERE organization_id = ?', [organizationId]
  ));
  return publicSettings(row || null, organizationId);
}

export async function getNotificationDestinations(scope: string): Promise<NotificationDestinations> {
  await databaseReady;
  const organizationId = await resolveOrganizationScope(scope);
  const row = await database.tenantTransaction(organizationId, (transaction) => transaction.get<NotificationSettingsRow>(
    'SELECT * FROM organization_notification_settings WHERE organization_id = ?', [organizationId]
  ));
  const base = publicSettings(row || null, organizationId);
  const decrypt = (value: string | null | undefined) => {
    if (!value) return null;
    try { return decryptConnectorConfig(value); } catch { return null; }
  };
  return { ...base, slackWebhook: decrypt(row?.slack_webhook_encrypted), teamsWebhook: decrypt(row?.teams_webhook_encrypted) };
}

export async function saveNotificationSettings(input: {
  organizationId: string;
  actorEmail: string;
  emailEnabled: boolean;
  events: BusinessAlertEvent[];
  slackWebhook?: string | null;
  teamsWebhook?: string | null;
  removeSlack?: boolean;
  removeTeams?: boolean;
}): Promise<NotificationSettings> {
  await databaseReady;
  const organizationId = await resolveOrganizationScope(input.organizationId);
  await database.tenantTransaction(organizationId, async (transaction) => {
    const current = await transaction.get<NotificationSettingsRow>(
      'SELECT * FROM organization_notification_settings WHERE organization_id = ?', [organizationId]
    );
    const slack = input.removeSlack ? null : input.slackWebhook ? encryptConnectorConfig(input.slackWebhook) : current?.slack_webhook_encrypted || null;
    const teams = input.removeTeams ? null : input.teamsWebhook ? encryptConnectorConfig(input.teamsWebhook) : current?.teams_webhook_encrypted || null;
    await transaction.run(
      `INSERT INTO organization_notification_settings
       (organization_id, email, email_enabled, slack_webhook_encrypted, teams_webhook_encrypted, events_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (organization_id) DO UPDATE SET
         email = excluded.email, email_enabled = excluded.email_enabled,
         slack_webhook_encrypted = excluded.slack_webhook_encrypted,
         teams_webhook_encrypted = excluded.teams_webhook_encrypted,
         events_json = excluded.events_json, updated_at = CURRENT_TIMESTAMP`,
      [organizationId, input.actorEmail, input.emailEnabled ? 1 : 0, slack, teams, JSON.stringify(input.events)]
    );
  });
  return getNotificationSettings(organizationId);
}
