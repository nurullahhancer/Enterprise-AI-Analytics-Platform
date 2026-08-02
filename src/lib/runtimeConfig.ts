import { isConnectorEncryptionConfigured } from './secrets';

const MIN_SECRET_LENGTH = 32;
const WEAK_SECRET_MARKERS = [
  'change-me', 'changeme', 'replace-me', 'replace_me', 'test-only',
  'example-secret', 'your-secret', 'default-secret'
];

function configured(name: string): string {
  return process.env[name]?.trim() || '';
}

function isObviouslyWeakSecret(value: string): boolean {
  const normalized = value.toLowerCase();
  return new Set(value).size < 8
    || /^(.)\1+$/.test(value)
    || WEAK_SECRET_MARKERS.some((marker) => normalized.includes(marker));
}

function requireSecret(errors: string[], name: string, value = configured(name)): void {
  if (value.length < MIN_SECRET_LENGTH) {
    errors.push(`${name} must contain at least ${MIN_SECRET_LENGTH} characters`);
  } else if (isObviouslyWeakSecret(value)) {
    errors.push(`${name} is a known placeholder or has insufficient entropy`);
  }
}

export function validateProductionConfiguration(): void {
  if (process.env.NODE_ENV !== 'production') return;

  const errors: string[] = [];
  const databaseUrl = configured('DATABASE_URL');
  if (!databaseUrl) {
    errors.push('DATABASE_URL is required');
  } else {
    try {
      const parsed = new URL(databaseUrl);
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) errors.push('DATABASE_URL must use PostgreSQL');
      requireSecret(errors, 'DATABASE_URL password', decodeURIComponent(parsed.password));
    } catch {
      errors.push('DATABASE_URL must be a valid PostgreSQL URL');
    }
  }
  requireSecret(errors, 'JWT_SECRET');
  requireSecret(errors, 'ML_INTERNAL_API_KEY');
  const accessTtl = Number(process.env.JWT_ACCESS_TTL_SECONDS || 1_800);
  if (!Number.isInteger(accessTtl) || accessTtl < 300 || accessTtl > 3_600) {
    errors.push('JWT_ACCESS_TTL_SECONDS must be between 300 and 3600');
  }
  if (!isConnectorEncryptionConfigured()) {
    errors.push('DATA_ENCRYPTION_KEY must be a base64 or hex encoded 32-byte key');
  } else if (isObviouslyWeakSecret(configured('DATA_ENCRYPTION_KEY'))) {
    errors.push('DATA_ENCRYPTION_KEY has insufficient entropy');
  }

  const appUrl = configured('APP_URL');
  if (!appUrl.startsWith('https://')) errors.push('APP_URL must use HTTPS');

  if (process.env.ALLOW_EXTERNAL_AI_DATA === 'true') {
    const provider = (configured('AI_PROVIDER') || 'auto').toLowerCase();
    const hasNvidia = Boolean(configured('NVIDIA_API_KEY'));
    const hasGemini = Boolean(configured('GEMINI_API_KEY'));
    if (provider === 'nvidia' && !hasNvidia) errors.push('NVIDIA_API_KEY is required for the NVIDIA provider');
    if (provider === 'gemini' && !hasGemini) errors.push('GEMINI_API_KEY is required for the Gemini provider');
    if (provider === 'auto' && !hasNvidia && !hasGemini) errors.push('An AI provider API key is required when external AI data sharing is enabled');
  }

  if (process.env.REQUIRE_EMAIL_VERIFICATION === 'true' && (!configured('RESEND_API_KEY') || !configured('EMAIL_FROM'))) {
    errors.push('RESEND_API_KEY and EMAIL_FROM are required when e-mail verification is enabled');
  }

  const billingValues = [
    'IYZICO_API_KEY', 'IYZICO_SECRET_KEY', 'IYZICO_MERCHANT_ID',
    'IYZICO_PLAN_PROFESSIONAL', 'IYZICO_PLAN_ENTERPRISE'
  ];
  const configuredBillingValues = billingValues.filter((name) => Boolean(configured(name)));
  if (configuredBillingValues.length > 0 && configuredBillingValues.length !== billingValues.length) {
    errors.push('iyzico configuration is partial; configure all API, merchant and plan values or none');
  }

  if (errors.length > 0) {
    throw new Error(`Unsafe production configuration: ${errors.join('; ')}`);
  }
}
