import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

let activeRequests = 0;
const requests = new Map<string, { count: number; durationSeconds: number }>();

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
    '# HELP reai_http_requests_total HTTP requests grouped by method and status class.',
    '# TYPE reai_http_requests_total counter',
  ];
  for (const [key, value] of [...requests.entries()].sort()) {
    const [method, statusClass] = key.split(':');
    lines.push(`reai_http_requests_total{method="${method}",status_class="${statusClass}"} ${value.count}`);
    lines.push(`reai_http_request_duration_seconds_sum{method="${method}",status_class="${statusClass}"} ${value.durationSeconds.toFixed(6)}`);
    lines.push(`reai_http_request_duration_seconds_count{method="${method}",status_class="${statusClass}"} ${value.count}`);
  }
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`${lines.join('\n')}\n`);
}
