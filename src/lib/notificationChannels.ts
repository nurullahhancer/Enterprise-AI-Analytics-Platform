import crypto from 'node:crypto';
import { listOrganizationAdminEmails } from './db';
import { sendTransactionalEmail, isEmailConfigured } from './email';
import logger from './logger';
import { BusinessAlertEvent, getNotificationDestinations } from './notificationSettingsDb';

export type NotificationChannel = 'slack' | 'teams';

export function validateBusinessWebhook(channel: NotificationChannel, value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_000 || /[\0\r\n]/.test(value)) {
    throw new Error(`${channel === 'slack' ? 'Slack' : 'Teams'} webhook adresi geçersiz.`);
  }
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Webhook adresi geçersiz.'); }
  const host = url.hostname.toLowerCase();
  const validHost = channel === 'slack'
    ? host === 'hooks.slack.com'
    : host.endsWith('.webhook.office.com') || host.endsWith('.logic.azure.com') || host.endsWith('.environment.api.powerplatform.com');
  if (url.protocol !== 'https:' || !validHost || url.username || url.password || url.hash) {
    throw new Error(`${channel === 'slack' ? 'Slack' : 'Teams'} için resmi HTTPS webhook adresini kullanın.`);
  }
  return url.toString();
}

async function postWebhook(channel: NotificationChannel, rawUrl: string, title: string, message: string): Promise<void> {
  const url = validateBusinessWebhook(channel, rawUrl);
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'ReAi-SaaS/1.0' },
    signal: AbortSignal.timeout(8_000),
    body: JSON.stringify({ text: `ReAi · ${title}\n${message}` })
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${channel} webhook HTTP ${response.status} döndürdü.`);
  }
  await response.body?.cancel();
}

export async function deliverBusinessAlert(
  organizationId: string,
  event: BusinessAlertEvent,
  title: string,
  message: string
): Promise<void> {
  const settings = await getNotificationDestinations(organizationId);
  if (!settings.events.includes(event)) return;
  const tasks: Array<Promise<unknown>> = [];
  if (settings.emailEnabled && isEmailConfigured()) {
    const recipients = await listOrganizationAdminEmails(organizationId);
    tasks.push(...recipients.map((to) => sendTransactionalEmail({
      to, subject: `ReAi · ${title}`, text: message,
      idempotencyKey: `alert-${event}-${crypto.createHash('sha256').update(`${organizationId}:${to}:${title}:${message}`).digest('hex')}`
    })));
  }
  if (settings.slackWebhook) tasks.push(postWebhook('slack', settings.slackWebhook, title, message));
  if (settings.teamsWebhook) tasks.push(postWebhook('teams', settings.teamsWebhook, title, message));
  const results = await Promise.allSettled(tasks);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) logger.warn('Harici iş bildiriminin bazı kanalları başarısız oldu.', { organizationId, event, failures: failures.length });
}
