import { randomUUID } from 'crypto';
import { buildMlForecast, buildMlInsights } from './pipeline';

export type MlJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface MlJobRecord {
  id: string;
  email: string;
  filename: string;
  status: MlJobStatus;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
}

interface QueueItem {
  id: string;
  run: () => Promise<unknown>;
}

const jobs = new Map<string, MlJobRecord>();
const queue: QueueItem[] = [];
let isProcessing = false;

export class MlQueueLimitError extends Error {
  constructor() {
    super('ML iş kuyruğu şu anda dolu. Lütfen mevcut işlerin tamamlanmasını bekleyin.');
    this.name = 'MlQueueLimitError';
  }
}

function boundedEnvInt(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name] || fallback);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function cleanupExpiredJobs(): void {
  const cutoff = Date.now() - boundedEnvInt('ML_JOB_TTL_MS', 30 * 60_000, 60_000, 24 * 60 * 60_000);
  for (const [id, job] of jobs) {
    if ((job.status === 'completed' || job.status === 'failed') && Date.parse(job.updatedAt) < cutoff) {
      jobs.delete(id);
    }
  }
}

function pruneTerminalJobs(maxRecords: number): void {
  cleanupExpiredJobs();
  if (jobs.size < maxRecords) return;
  const terminal = [...jobs.values()]
    .filter((job) => job.status === 'completed' || job.status === 'failed')
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  for (const job of terminal) {
    if (jobs.size < maxRecords) break;
    jobs.delete(job.id);
  }
}

async function runWithTimeout(run: () => Promise<unknown>): Promise<unknown> {
  const timeoutMs = boundedEnvInt('ML_JOB_TIMEOUT_MS', 60_000, 5_000, 10 * 60_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('ML işi zaman aşımına uğradı.')), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function enqueueJob(
  email: string,
  fileContent: string,
  options: { filename?: string; run?: () => Promise<unknown> } = {}
): string {
  const maxQueue = boundedEnvInt('ML_JOB_MAX_QUEUE', 50, 1, 500);
  const maxPerUser = boundedEnvInt('ML_JOB_MAX_PER_USER', 3, 1, 20);
  const maxRecords = boundedEnvInt('ML_JOB_MAX_RECORDS', 200, 10, 2_000);
  pruneTerminalJobs(maxRecords);
  const activeForUser = [...jobs.values()].filter(
    (job) => job.email === email && (job.status === 'queued' || job.status === 'running')
  ).length;
  if (queue.length >= maxQueue || activeForUser >= maxPerUser || jobs.size >= maxRecords) {
    throw new MlQueueLimitError();
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const filename = options.filename || 'dataset.csv';

  jobs.set(id, {
    id,
    email,
    filename,
    status: 'queued',
    createdAt: now,
    updatedAt: now
  });

  queue.push({
    id,
    run: options.run ?? (async () => ({
      forecast: buildMlForecast(fileContent, filename),
      insights: buildMlInsights(fileContent, filename)
    }))
  });

  void processQueue();
  return id;
}

export function getJobStatus(jobId: string): MlJobRecord | null {
  cleanupExpiredJobs();
  return jobs.get(jobId) || null;
}

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  while (queue.length > 0) {
    const item = queue.shift()!;
    const job = jobs.get(item.id);
    if (!job) continue;

    job.status = 'running';
    job.updatedAt = new Date().toISOString();

    try {
      job.result = await runWithTimeout(item.run);
      job.status = 'completed';
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : 'ML job failed.';
    } finally {
      job.updatedAt = new Date().toISOString();
      cleanupExpiredJobs();
    }
  }

  isProcessing = false;
}
