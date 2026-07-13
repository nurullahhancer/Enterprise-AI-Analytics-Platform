import { Router, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../index';
import { CombinedDataset, getCombinedUserDataset } from '../datasets/combined';
import { buildMlForecast, buildMlInsights } from '../ml/pipeline';
import { parseCsv } from '../ml/parser';
import { enqueueJob, getJobStatus, MlQueueLimitError } from '../ml/jobQueue';
import logger from '../../lib/logger';

const router = Router();

function csvToRows(content: string): Record<string, string>[] {
  const rows = parseCsv(content);
  const headers = rows[0] ?? [];
  if (headers.length === 0) return [];

  return rows.slice(1).map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']))
  );
}

async function analyzeWithFastApi(
  email: string,
  dataset: CombinedDataset,
  body: Record<string, unknown> | undefined
) {
  const mlServiceUrl = (process.env.ML_SERVICE_URL || 'http://localhost:8000').replace(/\/+$/, '');
  const timeoutValue = Number(process.env.ML_JOB_TIMEOUT_MS || 60_000);
  const timeoutMs = Number.isFinite(timeoutValue) ? Math.max(5_000, Math.min(timeoutValue, 10 * 60_000)) : 60_000;
  const response = await fetch(`${mlServiceUrl}/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': email
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      rows: csvToRows(dataset.file_content),
      target_column: body?.target_column ?? body?.targetColumn ?? null,
      periods: body?.periods ?? 3
    })
  });

  if (!response.ok) {
    await response.body?.cancel();
    logger.error('FastAPI /analyze başarısız.', { status: response.status });
    throw new Error('ML servisi yanıt vermedi.');
  }

  const maxResponseBytes = 5 * 1024 * 1024;
  const advertisedLength = Number(response.headers.get('content-length') || 0);
  if (advertisedLength > maxResponseBytes) {
    await response.body?.cancel();
    throw new Error('ML servisi izin verilen boyuttan büyük yanıt döndürdü.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('ML servisi boş yanıt döndürdü.');
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxResponseBytes) {
      await reader.cancel();
      throw new Error('ML servisi izin verilen boyuttan büyük yanıt döndürdü.');
    }
    chunks.push(value);
  }
  const responseText = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error('ML servisi geçersiz JSON döndürdü.');
  }
  if (!data || typeof data !== 'object' || typeof data.dataset_type !== 'string' || !Array.isArray(data.feature_columns)) {
    throw new Error('ML servisi beklenmeyen bir yanıt şeması döndürdü.');
  }
  return {
    ...data,
    datasetIds: dataset.datasetIds,
    datasetCount: dataset.dataset_count,
    datasetFilename: dataset.filename,
    sourceFilenames: dataset.filenames
  };
}

router.get('/forecast', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const dataset = await getCombinedUserDataset(req.user!.email);
    if (!dataset) return res.status(404).json({ error: { code: 'NO_DATASET', message: 'Önce veri yükleyin.' } });
    res.json(buildMlForecast(dataset.file_content, dataset.filename));
  } catch (err) {
    next(err);
  }
});

router.get('/insights', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const dataset = await getCombinedUserDataset(req.user!.email);
    if (!dataset) return res.status(404).json({ error: { code: 'NO_DATASET', message: 'Önce veri yükleyin.' } });
    res.json(buildMlInsights(dataset.file_content, dataset.filename));
  } catch (err) {
    next(err);
  }
});

router.post('/analyze', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const dataset = await getCombinedUserDataset(req.user!.email);
    if (!dataset) return res.status(404).json({ error: { code: 'NO_DATASET', message: 'Önce veri yükleyin.' } });

    const threshold = Number(process.env.ML_ANALYZE_ASYNC_THRESHOLD_CHARS || 0);
    const requestedAsync = req.body?.async === true || req.query.async === '1';
    const exceedsThreshold = threshold > 0 && dataset.file_content.length > threshold;

    if (requestedAsync || exceedsThreshold) {
      const jobId = enqueueJob(req.user!.email, dataset.file_content, {
        filename: dataset.filename,
        run: () => analyzeWithFastApi(req.user!.email, dataset, req.body)
      });

      return res.status(202).json({
        jobId,
        status: 'queued',
        statusUrl: `/api/ml/job/${jobId}`,
        datasetIds: dataset.datasetIds,
        datasetCount: dataset.dataset_count,
        datasetFilename: dataset.filename
      });
    }

    res.json(await analyzeWithFastApi(req.user!.email, dataset, req.body));
  } catch (err: any) {
    if (err instanceof MlQueueLimitError) {
      return res.status(429).json({ error: { code: 'ML_QUEUE_FULL', message: err.message } });
    }
    if (err.message === 'ML servisi yanıt vermedi.') {
      return res.status(502).json({ error: { code: 'ML_SERVICE_ERROR', message: err.message } });
    }
    next(err);
  }
});

router.get('/job/:id', (req: AuthenticatedRequest, res: Response) => {
  const job = getJobStatus(req.params.id);
  if (!job || job.email !== req.user!.email) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'ML işi bulunamadı.' } });
  }

  const { email: _email, ...publicJob } = job;
  res.json(publicJob);
});

export default router;
