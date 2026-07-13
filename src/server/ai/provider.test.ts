import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiProviderError, generateAiResponse, getAiConfiguration } from './provider';

const originalEnv = { ...process.env };

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = {
      generateContent: vi.fn().mockResolvedValue({ text: 'Mocked Gemini Response' })
    };
  }
  return { GoogleGenAI };
});

function resetAiEnv() {
  process.env = { ...originalEnv };
  delete process.env.AI_PROVIDER;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_AI_MODEL;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_AI_MODEL;
  delete process.env.AI_REQUEST_TIMEOUT_MS;
  delete process.env.AI_MAX_OUTPUT_TOKENS;
}

describe('AI provider adapter', () => {
  beforeEach(() => {
    resetAiEnv();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetAiEnv();
    vi.restoreAllMocks();
  });

  it('reports NVIDIA as configured only when its key is present', () => {
    process.env.AI_PROVIDER = 'nvidia';
    expect(getAiConfiguration()).toMatchObject({
      provider: 'nvidia',
      configured: false,
      model: 'deepseek-ai/deepseek-v4-pro',
      issue: 'missing-key'
    });

    process.env.NVIDIA_API_KEY = 'test-nvidia-key';
    expect(getAiConfiguration()).toMatchObject({
      provider: 'nvidia',
      configured: true,
      model: 'deepseek-ai/deepseek-v4-pro'
    });
  });

  it('calls the fixed NVIDIA chat completions endpoint with the expected model body', async () => {
    process.env.AI_PROVIDER = 'nvidia';
    process.env.NVIDIA_API_KEY = 'test-nvidia-key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'Merhaba' } }] })
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await generateAiResponse('test prompt');

    expect(response).toEqual({
      text: 'Merhaba',
      provider: 'nvidia',
      model: 'deepseek-ai/deepseek-v4-pro'
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer test-nvidia-key');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'deepseek-ai/deepseek-v4-pro',
      messages: [{ role: 'user', content: 'test prompt' }],
      temperature: 1,
      top_p: 0.95,
      stream: false,
      chat_template_kwargs: { thinking: false }
    });
  });

  it('maps NVIDIA auth and malformed responses to safe public errors', async () => {
    process.env.AI_PROVIDER = 'nvidia';
    process.env.NVIDIA_API_KEY = 'test-nvidia-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers()
    }));

    await expect(generateAiResponse('test prompt')).rejects.toMatchObject({
      status: 503,
      code: 'AI_PROVIDER_AUTH_FAILED'
    } satisfies Partial<AiProviderError>);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({ choices: [{ message: { content: '' } }] })
    }));

    await expect(generateAiResponse('test prompt')).rejects.toMatchObject({
      status: 502,
      code: 'AI_EMPTY_RESPONSE'
    } satisfies Partial<AiProviderError>);
  });

  it('rejects invalid model names before making provider calls', async () => {
    process.env.AI_PROVIDER = 'nvidia';
    process.env.NVIDIA_API_KEY = 'test-nvidia-key';
    process.env.NVIDIA_AI_MODEL = 'https://bad.example/model';
    vi.stubGlobal('fetch', vi.fn());

    expect(getAiConfiguration()).toMatchObject({
      configured: false,
      issue: 'invalid-model'
    });
    await expect(generateAiResponse('test prompt')).rejects.toMatchObject({
      status: 503,
      code: 'AI_NOT_CONFIGURED'
    } satisfies Partial<AiProviderError>);
    expect(fetch).not.toHaveBeenCalled();
  });
});
