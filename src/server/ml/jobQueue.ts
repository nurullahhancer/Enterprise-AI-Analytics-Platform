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

export function enqueueJob(
  email: string,
  fileContent: string,
  options: { filename?: string; run?: () => Promise<unknown> } = {}
): string {
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
      job.result = await item.run();
      job.status = 'completed';
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : 'ML job failed.';
    } finally {
      job.updatedAt = new Date().toISOString();
    }
  }

  isProcessing = false;
}
