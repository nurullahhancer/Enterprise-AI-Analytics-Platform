import { describe, expect, it } from 'vitest';
import { validateBusinessWebhook } from './notificationChannels';

describe('business notification webhook validation', () => {
  it('accepts official Slack and Teams webhook hosts', () => {
    expect(validateBusinessWebhook('slack', 'https://hooks.slack.com/services/T/B/secret')).toContain('hooks.slack.com');
    expect(validateBusinessWebhook('teams', 'https://tenant.webhook.office.com/webhookb2/secret')).toContain('webhook.office.com');
  });

  it.each([
    ['slack', 'https://example.com/hooks/slack'],
    ['teams', 'http://tenant.webhook.office.com/webhook'],
    ['teams', 'https://webhook.office.com.evil.example/webhook'],
  ] as const)('rejects untrusted %s URL', (channel, url) => {
    expect(() => validateBusinessWebhook(channel, url)).toThrow();
  });
});
