import winston from 'winston';

const SENSITIVE_KEY = /(^|[_-])(password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|encryption[_-]?key)($|[_-])/i;

function redactText(input: string): string {
  let value = input
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password|signature|sig|auth)=)[^&\s]+/gi, '$1[REDACTED]');
  for (const name of ['JWT_SECRET', 'GEMINI_API_KEY', 'DATA_ENCRYPTION_KEY', 'BOOTSTRAP_ADMIN_TOKEN', 'ML_INTERNAL_API_KEY']) {
    const secret = process.env[name];
    if (secret && secret.length >= 8) value = value.split(secret).join('[REDACTED]');
  }
  return value;
}

function redactValue(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactText(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), code: (value as NodeJS.ErrnoException).code };
  }
  if (!value || typeof value !== 'object' || depth >= 5) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, '', depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
      childKey,
      redactValue(childValue, childKey, depth + 1)
    ])
  );
}

const redact = winston.format((info) => {
  for (const [key, value] of Object.entries(info)) {
    info[key] = redactValue(value, key);
  }
  return info;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    redact(),
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        redact(),
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...metadata }) => {
          let msg = `[${timestamp}] ${level}: ${message}`;
          if (Object.keys(metadata).length) {
            msg += ` ${JSON.stringify(metadata)}`;
          }
          return msg;
        })
      )
    })
  ]
});

export default logger;
