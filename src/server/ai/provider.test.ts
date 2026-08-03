import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiProviderError, generateAiResponse, generateAiResponseStream, getAiConfiguration } from './provider';

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
  delete process.env.AI_MAX_RETRIES;
  delete process.env.AI_INPUT_COST_PER_MILLION_USD;
  delete process.env.AI_OUTPUT_COST_PER_MILLION_USD;
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
      model: 'nvidia/nemotron-3-super-120b-a12b',
      issue: 'missing-key'
    });

    process.env.NVIDIA_API_KEY = 'test-nvidia-key';
    expect(getAiConfiguration()).toMatchObject({
      provider: 'nvidia',
      configured: true,
      model: 'nvidia/nemotron-3-super-120b-a12b'
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

    expect(response).toMatchObject({
      text: 'Merhaba',
      provider: 'nvidia',
      model: 'nvidia/nemotron-3-super-120b-a12b',
      usage: { estimated: true }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer test-nvidia-key');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'nvidia/nemotron-3-super-120b-a12b',
      messages: [{ role: 'user', content: 'test prompt' }],
      temperature: 0.2,
      top_p: 0.9,
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

  it('retries transient provider failures with bounded backoff and reports token cost', async () => {
    process.env.AI_PROVIDER = 'nvidia';
    process.env.NVIDIA_API_KEY = 'test-nvidia-key';
    process.env.AI_MAX_RETRIES = '1';
    process.env.AI_INPUT_COST_PER_MILLION_USD = '2';
    process.env.AI_OUTPUT_COST_PER_MILLION_USD = '4';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers() })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({
          choices: [{ message: { content: 'Yanıt' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        })
      });
    vi.stubGlobal('fetch', fetchMock);

    const response = await generateAiResponse('test prompt');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5, costMicroUsd: 40, estimated: false });
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

  it('streams chunks in real-time to onChunk callback during generateAiResponseStream', async () => {
    process.env.AI_PROVIDER = 'nvidia';
    process.env.NVIDIA_API_KEY = 'test-nvidia-key';

    const sseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Merhaba "}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Dünya"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: sseBody
    });
    vi.stubGlobal('fetch', fetchMock);

    const receivedChunks: string[] = [];
    const response = await generateAiResponseStream('test streaming', (chunkText) => {
      receivedChunks.push(chunkText);
    });

    expect(response.text).toBe('Merhaba Dünya');
    expect(receivedChunks).toEqual(['Merhaba ', 'Dünya']);
  });
});
