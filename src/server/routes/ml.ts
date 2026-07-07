import { Router, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../index';
import { CombinedDataset, getCombinedUserDataset } from '../datasets/combined';
import { buildMlForecast, buildMlInsights } from '../ml/pipeline';
import { parseCsv } from '../ml/parser';
import { enqueueJob, getJobStatus } from '../ml/jobQueue';
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
  const response = await fetch(`${mlServiceUrl}/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': email
    },
    body: JSON.stringify({
      rows: csvToRows(dataset.file_content),
      target_column: body?.target_column ?? body?.targetColumn ?? null,
      periods: body?.periods ?? 3
    })
  });

  if (!response.ok) {
    const errBody = await response.text();
    logger.error(`FastAPI /analyze hata: ${errBody}`);
    throw new Error('ML servisi yanıt vermedi.');
  }

  const data = await response.json();
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
