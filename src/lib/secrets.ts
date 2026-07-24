import crypto from 'node:crypto';

const PREFIX = 'enc:v1';

function encryptionKey(): Buffer | null {
  const value = process.env.DATA_ENCRYPTION_KEY?.trim();
  if (!value) return null;

  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

export function isConnectorEncryptionConfigured(): boolean {
  return encryptionKey() !== null;
}

export function encryptConnectorConfig(plaintext: string): string {
  const key = encryptionKey();
  if (!key) throw new Error('CONNECTOR_ENCRYPTION_NOT_CONFIGURED');

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptConnectorConfig(value: string): string {
  const key = encryptionKey();
  if (!key) throw new Error('CONNECTOR_ENCRYPTION_NOT_CONFIGURED');

  const [prefix, version, ivText, tagText, ciphertextText] = value.split(':');
  if (`${prefix}:${version}` !== PREFIX || !ivText || !tagText || !ciphertextText) {
    throw new Error('LEGACY_PLAINTEXT_CONNECTOR_CONFIG');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

export function publicConnectorConfig(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const config = value as Record<string, unknown>;
  const allowed = ['url', 'method', 'host', 'port', 'database', 'username', 'sslMode'];
  return Object.fromEntries(
    allowed
      .filter((key) => typeof config[key] === 'string' || typeof config[key] === 'number')
      .map((key) => {
        if (key !== 'url') return [key, config[key]];
        try {
          const url = new URL(String(config[key]));
          url.username = '';
          url.password = '';
          for (const parameter of [...url.searchParams.keys()]) {
            url.searchParams.set(parameter, '[REDACTED]');
          }
          url.hash = '';
          return [key, url.toString()];
        } catch {
          return [key, '[INVALID URL]'];
        }
      })
  );
}
