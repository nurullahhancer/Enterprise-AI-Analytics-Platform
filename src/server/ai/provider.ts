import { GoogleGenAI } from '@google/genai';

export type AiProviderName = 'gemini' | 'nvidia';

export interface AiConfiguration {
  provider: AiProviderName;
  configured: boolean;
  model: string;
  issue?: 'missing-key' | 'invalid-provider' | 'invalid-model';
}

export interface AiResponse {
  text: string;
  provider: AiProviderName;
  model: string;
}

export class AiProviderError extends Error {
  status: number;
  code: string;
  retryAfter?: string;

  constructor(status: number, code: string, message: string, retryAfter?: string) {
    super(message);
    this.name = 'AiProviderError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const NVIDIA_CHAT_COMPLETIONS_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const DEFAULT_NVIDIA_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const MODEL_NAME_RE = /^[a-z0-9][a-z0-9._/-]{1,120}$/i;

function selectedProvider(): AiProviderName | 'invalid' {
  const provider = (process.env.AI_PROVIDER || 'auto').trim().toLowerCase();
  if (provider === 'nvidia') return 'nvidia';
  if (provider === 'gemini') return 'gemini';
  if (provider === 'auto' || provider === '') {
    if (process.env.NVIDIA_API_KEY) return 'nvidia';
    return 'gemini';
  }
  return 'invalid';
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

function modelFor(provider: AiProviderName): string {
  if (provider === 'nvidia') return process.env.NVIDIA_AI_MODEL || DEFAULT_NVIDIA_MODEL;
  return process.env.GEMINI_AI_MODEL || DEFAULT_GEMINI_MODEL;
}

export function getAiConfiguration(): AiConfiguration {
  const provider = selectedProvider();
  if (provider === 'invalid') {
    return { provider: 'gemini', configured: false, model: DEFAULT_GEMINI_MODEL, issue: 'invalid-provider' };
  }

  const model = modelFor(provider);
  if (!MODEL_NAME_RE.test(model)) {
    return { provider, configured: false, model, issue: 'invalid-model' };
  }

  const configured = provider === 'nvidia' ? Boolean(process.env.NVIDIA_API_KEY) : Boolean(process.env.GEMINI_API_KEY);
  return { provider, configured, model, issue: configured ? undefined : 'missing-key' };
}

export async function generateAiResponse(prompt: string): Promise<AiResponse> {
  const config = getAiConfiguration();
  if (!config.configured) {
    throw new AiProviderError(503, 'AI_NOT_CONFIGURED', 'AI servis anahtarı yapılandırılmadı.');
  }

  if (config.provider === 'nvidia') {
    return generateNvidiaResponse(prompt, config.model);
  }
  return generateGeminiResponse(prompt, config.model);
}

async function generateGeminiResponse(prompt: string, model: string): Promise<AiResponse> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      maxOutputTokens: boundedInteger(process.env.AI_MAX_OUTPUT_TOKENS, 1_024, 128, 8_192),
      temperature: 0.2
    }
  });
  if (!response.text) {
    throw new AiProviderError(502, 'AI_EMPTY_RESPONSE', 'AI servisinden boş yanıt alındı.');
  }
  return { text: response.text, provider: 'gemini', model };
}

async function generateNvidiaResponse(prompt: string, model: string): Promise<AiResponse> {
  const timeoutMs = boundedInteger(process.env.AI_REQUEST_TIMEOUT_MS, 30_000, 5_000, 300_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(NVIDIA_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY!}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: boundedInteger(process.env.AI_MAX_OUTPUT_TOKENS, 1_024, 128, 16_384),
        stream: false,
        chat_template_kwargs: { thinking: false }
      }),
      signal: controller.signal
    });

    const retryAfter = response.headers.get('retry-after') || undefined;
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AiProviderError(503, 'AI_PROVIDER_AUTH_FAILED', 'AI servis anahtarı geçersiz veya yetkisiz.');
      }
      if (response.status === 429) {
        throw new AiProviderError(429, 'AI_PROVIDER_RATE_LIMITED', 'AI sağlayıcı kullanım limitine ulaştı.', retryAfter);
      }
      if (response.status === 422) {
        throw new AiProviderError(502, 'AI_PROVIDER_REQUEST_REJECTED', 'AI sağlayıcı isteği kabul etmedi.');
      }
      throw new AiProviderError(502, 'AI_PROVIDER_UNAVAILABLE', 'AI sağlayıcı geçici olarak yanıt veremiyor.');
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > 2_000_000) {
      throw new AiProviderError(502, 'AI_RESPONSE_TOO_LARGE', 'AI sağlayıcı beklenenden büyük yanıt döndürdü.');
    }

    const body = await response.json() as {
      choices?: Array<{ message?: { content?: unknown }, delta?: { content?: unknown } }>;
    };
    const text = body.choices?.[0]?.message?.content ?? body.choices?.[0]?.delta?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new AiProviderError(502, 'AI_EMPTY_RESPONSE', 'AI servisinden boş yanıt alındı.');
    }
    return { text, provider: 'nvidia', model };
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiProviderError(504, 'AI_PROVIDER_TIMEOUT', 'AI sağlayıcı zaman aşımına uğradı.');
    }
    throw new AiProviderError(502, 'AI_PROVIDER_UNAVAILABLE', 'AI sağlayıcıya ulaşılamadı.');
  } finally {
    clearTimeout(timer);
  }
}

export async function generateAiResponseStream(prompt: string, onChunk: (text: string) => void): Promise<AiResponse> {
  const config = getAiConfiguration();
  if (!config.configured) {
    throw new AiProviderError(503, 'AI_NOT_CONFIGURED', 'AI servis anahtarı yapılandırılmadı.');
  }

  if (config.provider === 'nvidia') {
    return generateNvidiaResponseStream(prompt, config.model, onChunk);
  }
  return generateGeminiResponseStream(prompt, config.model, onChunk);
}

async function generateGeminiResponseStream(prompt: string, model: string, onChunk: (text: string) => void): Promise<AiResponse> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const responseStream = await ai.models.generateContentStream({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      maxOutputTokens: boundedInteger(process.env.AI_MAX_OUTPUT_TOKENS, 1_024, 128, 8_192),
      temperature: 0.2
    }
  });
  let text = '';
  for await (const chunk of responseStream) {
    const chunkText = chunk.text || '';
    text += chunkText;
    onChunk(chunkText);
  }
  if (!text) {
    throw new AiProviderError(502, 'AI_EMPTY_RESPONSE', 'AI servisinden boş yanıt alındı.');
  }
  return { text, provider: 'gemini', model };
}

async function generateNvidiaResponseStream(prompt: string, model: string, onChunk: (text: string) => void): Promise<AiResponse> {
  const timeoutMs = boundedInteger(process.env.AI_REQUEST_TIMEOUT_MS, 30_000, 5_000, 300_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(NVIDIA_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY!}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: boundedInteger(process.env.AI_MAX_OUTPUT_TOKENS, 1_024, 128, 16_384),
        stream: true,
        chat_template_kwargs: { thinking: false }
      }),
      signal: controller.signal
    });

    const retryAfter = response.headers.get('retry-after') || undefined;
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AiProviderError(503, 'AI_PROVIDER_AUTH_FAILED', 'AI servis anahtarı geçersiz veya yetkisiz.');
      }
      if (response.status === 429) {
        throw new AiProviderError(429, 'AI_PROVIDER_RATE_LIMITED', 'AI sağlayıcı kullanım limitine ulaştı.', retryAfter);
      }
      if (response.status === 422) {
        throw new AiProviderError(502, 'AI_PROVIDER_REQUEST_REJECTED', 'AI sağlayıcı isteği kabul etmedi.');
      }
      throw new AiProviderError(502, 'AI_PROVIDER_UNAVAILABLE', 'AI sağlayıcı geçici olarak yanıt veremiyor.');
    }

    if (!response.body) {
      throw new AiProviderError(502, 'AI_EMPTY_RESPONSE', 'AI servisinden boş yanıt alındı.');
    }

    let text = '';
    const reader = response.body.getReader ? response.body.getReader() : null;
    const decoder = new TextDecoder();
    let buffer = '';

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = parseSseBuffer(buffer, (content) => {
          text += content;
          onChunk(content);
        });
      }
    } else {
      for await (const chunk of response.body as any) {
        buffer += decoder.decode(chunk, { stream: true });
        buffer = parseSseBuffer(buffer, (content) => {
          text += content;
          onChunk(content);
        });
      }
    }

    buffer += decoder.decode();
    parseSseBuffer(buffer, (content) => {
      text += content;
      onChunk(content);
    });

    if (!text.trim()) {
      throw new AiProviderError(502, 'AI_EMPTY_RESPONSE', 'AI servisinden boş yanıt alındı.');
    }
    return { text, provider: 'nvidia', model };
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiProviderError(504, 'AI_PROVIDER_TIMEOUT', 'AI sağlayıcı zaman aşımına uğradı.');
    }
    throw new AiProviderError(502, 'AI_PROVIDER_UNAVAILABLE', 'AI sağlayıcıya ulaşılamadı.');
  } finally {
    clearTimeout(timer);
  }
}

function parseSseBuffer(buffer: string, onContent: (content: string) => void): string {
  const lines = buffer.split('\n');
  const lastLine = lines.pop() || '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('data:')) {
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === '[DONE]') continue;
      try {
        const parsed = JSON.parse(dataStr);
        const content = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content;
        if (typeof content === 'string') {
          onContent(content);
        }
      } catch (e) {
        // Ignore JSON parse errors for partial lines
      }
    }
  }
  return lastLine;
}
