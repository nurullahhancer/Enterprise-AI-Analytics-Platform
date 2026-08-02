import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

let activeRequests = 0;
const requests = new Map<string, { count: number; durationSeconds: number }>();
const aiUsage = new Map<string, { requests: number; inputTokens: number; outputTokens: number; costMicroUsd: number }>();
const mlRequests = { total: 0, errors: 0, durationSeconds: 0 };

export function recordAiMetrics(
  provider: string,
  usage: { inputTokens: number; outputTokens: number; costMicroUsd: number }
): void {
  const safeProvider = /^[A-Za-z0-9_-]{1,30}$/.test(provider) ? provider : 'unknown';
  const current = aiUsage.get(safeProvider) || { requests: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 };
  current.requests += 1;
  current.inputTokens += Math.max(0, usage.inputTokens);
  current.outputTokens += Math.max(0, usage.outputTokens);
  current.costMicroUsd += Math.max(0, usage.costMicroUsd);
  aiUsage.set(safeProvider, current);
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/internal/metrics') return next();
  const started = process.hrtime.bigint();
  activeRequests += 1;
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    activeRequests = Math.max(0, activeRequests - 1);
    const durationSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
    const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
    const key = `${req.method}:${statusClass}`;
    const current = requests.get(key) || { count: 0, durationSeconds: 0 };
    current.count += 1;
    current.durationSeconds += durationSeconds;
    requests.set(key, current);
    if (req.path.startsWith('/api/ml/')) {
      mlRequests.total += 1;
      mlRequests.durationSeconds += durationSeconds;
      if (res.statusCode >= 500) mlRequests.errors += 1;
    }
  };
  res.once('finish', record);
  res.once('close', record);
  next();
}

function tokenMatches(req: Request): boolean {
  const expected = process.env.METRICS_TOKEN?.trim();
  if (!expected) return true;
  const supplied = String(req.headers['x-metrics-token'] || '').trim();
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function renderMetrics(req: Request, res: Response): void {
  if (!tokenMatches(req)) {
    res.status(404).end();
    return;
  }
  const memory = process.memoryUsage();
  const lines = [
    '# HELP reai_http_active_requests Current in-flight HTTP requests.',
    '# TYPE reai_http_active_requests gauge',
    `reai_http_active_requests ${activeRequests}`,
    '# HELP reai_process_uptime_seconds Node.js process uptime.',
    '# TYPE reai_process_uptime_seconds gauge',
    `reai_process_uptime_seconds ${process.uptime().toFixed(3)}`,
    '# HELP reai_process_resident_memory_bytes Resident memory size.',
    '# TYPE reai_process_resident_memory_bytes gauge',
    `reai_process_resident_memory_bytes ${memory.rss}`,
    '# HELP reai_ml_requests_total ML API requests.',
    '# TYPE reai_ml_requests_total counter',
    `reai_ml_requests_total ${mlRequests.total}`,
    '# HELP reai_ml_errors_total ML API server errors.',
    '# TYPE reai_ml_errors_total counter',
    `reai_ml_errors_total ${mlRequests.errors}`,
    '# HELP reai_ml_request_duration_seconds_sum Cumulative ML API latency.',
    '# TYPE reai_ml_request_duration_seconds_sum counter',
    `reai_ml_request_duration_seconds_sum ${mlRequests.durationSeconds.toFixed(6)}`,
    '# HELP reai_http_requests_total HTTP requests grouped by method and status class.',
    '# TYPE reai_http_requests_total counter',
  ];
  for (const [key, value] of [...requests.entries()].sort()) {
    const [method, statusClass] = key.split(':');
    lines.push(`reai_http_requests_total{method="${method}",status_class="${statusClass}"} ${value.count}`);
    lines.push(`reai_http_request_duration_seconds_sum{method="${method}",status_class="${statusClass}"} ${value.durationSeconds.toFixed(6)}`);
    lines.push(`reai_http_request_duration_seconds_count{method="${method}",status_class="${statusClass}"} ${value.count}`);
  }
  lines.push('# HELP reai_llm_requests_total Completed external LLM requests.');
  lines.push('# TYPE reai_llm_requests_total counter');
  for (const [provider, value] of [...aiUsage.entries()].sort()) {
    lines.push(`reai_llm_requests_total{provider="${provider}"} ${value.requests}`);
    lines.push(`reai_llm_input_tokens_total{provider="${provider}"} ${value.inputTokens}`);
    lines.push(`reai_llm_output_tokens_total{provider="${provider}"} ${value.outputTokens}`);
    lines.push(`reai_llm_cost_microusd_total{provider="${provider}"} ${value.costMicroUsd}`);
  }
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`${lines.join('\n')}\n`);
}
