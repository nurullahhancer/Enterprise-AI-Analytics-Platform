import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeAiRateLimit } from './quota';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AI abuse rate limiting', () => {
  it('does not bypass security limits for e-mail-like keys', () => {
    vi.stubEnv('AI_REQUESTS_PER_HOUR', '1');
    const key = `org-test:user+deneme@gmail.com.example-${Date.now()}`;

    expect(consumeAiRateLimit(key).allowed).toBe(true);
    expect(consumeAiRateLimit(key).allowed).toBe(false);
  });
});
