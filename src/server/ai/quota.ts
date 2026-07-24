const usage = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60 * 60_000;
const MAX_KEYS = 10_000;

function requestLimit(): number {
  const parsed = Number(process.env.AI_REQUESTS_PER_HOUR || 20);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(parsed, 500)) : 20;
}

export function consumeAiRateLimit(key: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  for (const [storedKey, entry] of usage) {
    if (entry.resetAt <= now) usage.delete(storedKey);
  }
  while (usage.size >= MAX_KEYS) {
    const oldest = usage.keys().next().value;
    if (oldest === undefined) break;
    usage.delete(oldest);
  }

  const current = usage.get(key);
  if (current && current.count >= requestLimit()) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)) };
  }
  const resetAt = current?.resetAt ?? now + WINDOW_MS;
  usage.set(key, { count: (current?.count ?? 0) + 1, resetAt });
  return { allowed: true, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1_000)) };
}
