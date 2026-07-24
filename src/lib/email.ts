import crypto from 'node:crypto';
import logger from './logger';

interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim());
}

export async function sendTransactionalEmail(message: TransactionalEmail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from) {
    if (process.env.NODE_ENV === 'production' && process.env.REQUIRE_EMAIL_VERIFICATION === 'true') {
      throw new Error('E-posta servisi yapılandırılmadı.');
    }
    logger.info('İşlem e-postası geliştirme ortamında atlandı.', {
      recipientHash: crypto.createHash('sha256').update(message.to).digest('hex').slice(0, 12),
      subject: message.subject,
    });
    return;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': message.idempotencyKey.slice(0, 256),
      'User-Agent': 'ReAi-SaaS/1.0',
    },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    }),
  });

  if (!response.ok) {
    await response.body?.cancel();
    logger.error('İşlem e-postası gönderilemedi.', { status: response.status });
    throw new Error('E-posta gönderilemedi.');
  }
  await response.body?.cancel();
}

export function appLink(pathname: string, params: Record<string, string>): string {
  const baseUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const url = new URL(pathname, `${baseUrl}/`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

