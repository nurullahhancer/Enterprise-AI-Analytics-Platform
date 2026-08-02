import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateProductionConfiguration } from './runtimeConfig';

afterEach(() => {
  vi.unstubAllEnvs();
});

function validProductionEnvironment(): void {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DATABASE_URL', 'postgresql://app:Db9xK4mP7qR2vN8sL5wT1yC6fH3jZ0aB@postgres/reai');
  vi.stubEnv('JWT_SECRET', 'jwt-9F4k2L8m7Q1v6Z3p5R0x8N2w4C7h1T6s');
  vi.stubEnv('ML_INTERNAL_API_KEY', 'ml-8Q2v5N7x1R4k9Z6p3L0w2C8h5T7m1F9s');
  vi.stubEnv('DATA_ENCRYPTION_KEY', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  vi.stubEnv('APP_URL', 'https://app.example.test');
  vi.stubEnv('ALLOW_EXTERNAL_AI_DATA', 'false');
  vi.stubEnv('REQUIRE_EMAIL_VERIFICATION', 'false');
  for (const name of [
    'IYZICO_API_KEY', 'IYZICO_SECRET_KEY', 'IYZICO_MERCHANT_ID',
    'IYZICO_PLAN_PROFESSIONAL', 'IYZICO_PLAN_ENTERPRISE'
  ]) vi.stubEnv(name, '');
}

describe('production configuration validation', () => {
  it('fails closed when required production secrets are missing', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('JWT_SECRET', 'weak');
    vi.stubEnv('ML_INTERNAL_API_KEY', '');
    vi.stubEnv('DATA_ENCRYPTION_KEY', '');
    vi.stubEnv('APP_URL', 'http://localhost:3000');

    expect(() => validateProductionConfiguration()).toThrow(/Unsafe production configuration/);
  });

  it('accepts a complete production configuration with optional integrations disabled', () => {
    validProductionEnvironment();

    expect(() => validateProductionConfiguration()).not.toThrow();
  });

  it('requires a provider key when external AI data sharing is enabled', () => {
    validProductionEnvironment();
    vi.stubEnv('ALLOW_EXTERNAL_AI_DATA', 'true');
    vi.stubEnv('AI_PROVIDER', 'nvidia');
    vi.stubEnv('NVIDIA_API_KEY', '');

    expect(() => validateProductionConfiguration()).toThrow(/NVIDIA_API_KEY/);
  });

  it('rejects long placeholders and low-entropy secrets', () => {
    validProductionEnvironment();
    vi.stubEnv('JWT_SECRET', 'test-only-secret-that-is-long-but-not-safe');
    vi.stubEnv('DATA_ENCRYPTION_KEY', '0'.repeat(64));

    expect(() => validateProductionConfiguration()).toThrow(/placeholder|entropy/);
  });
});
