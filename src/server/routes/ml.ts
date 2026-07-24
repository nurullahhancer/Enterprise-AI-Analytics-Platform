import { Router, Response, NextFunction } from 'express';
import { AuthenticatedRequest, requireRoles } from '../index';
import { CombinedDataset, getCombinedUserDataset } from '../datasets/combined';
import { buildMlForecast, buildMlInsights } from '../ml/pipeline';
import { parseCsv } from '../ml/parser';
import { enqueueJob, getJobStatus, MlQueueLimitError } from '../ml/jobQueue';
import logger from '../../lib/logger';
import { consumeUsage, PlanQuotaError, refundUsage } from '../../lib/saasDb';
import {
  createAnalysisRun,
  deleteAnalysisRun,
  getAnalysisRun,
  listAnalysisRuns,
  saveAnalysisInterpretation
} from '../../lib/analysisDb';
import { addAuditLog } from '../../lib/db';
import { AiProviderError, generateAiResponse, getAiConfiguration } from '../ai/provider';
import { consumeAiRateLimit } from '../ai/quota';

const router = Router();

class MlServiceError extends Error {
  constructor(
    public readonly serviceStatus: number,
    message: string
  ) {
    super(message);
    this.name = 'MlServiceError';
  }
}

function csvToRows(content: string): Record<string, string>[] {
  const rows = parseCsv(content);
  const headers = rows[0] ?? [];
  if (headers.length === 0) return [];

  return rows.slice(1).map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']))
  );
}

async function analyzeWithFastApi(
  tenantId: string,
  dataset: CombinedDataset,
  body: Record<string, unknown> | undefined
) {
  const mlServiceUrl = (process.env.ML_SERVICE_URL || 'http://localhost:8000').replace(/\/+$/, '');
  const timeoutValue = Number(process.env.ML_JOB_TIMEOUT_MS || 60_000);
  const timeoutMs = Number.isFinite(timeoutValue) ? Math.max(5_000, Math.min(timeoutValue, 10 * 60_000)) : 60_000;
  const rows = csvToRows(dataset.file_content);
  const response = await fetch(`${mlServiceUrl}/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': tenantId,
      ...(process.env.ML_INTERNAL_API_KEY ? { 'X-Internal-Api-Key': process.env.ML_INTERNAL_API_KEY } : {})
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      rows,
      target_column: body?.target_column ?? body?.targetColumn ?? null,
      periods: body?.periods ?? 3
    })
  });

  if (!response.ok) {
    await response.body?.cancel();
    logger.error('FastAPI /analyze başarısız.', {
      status: response.status,
      rowCount: rows.length,
      columnCount: Object.keys(rows[0] || {}).length
    });
    const message = response.status === 422
      ? 'ML servisi analiz verisini doğrulayamadı. Veri boyutu veya kolon biçimi desteklenen sınırları aşıyor.'
      : 'ML servisi analizi tamamlayamadı.';
    throw new MlServiceError(response.status, message);
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

function analysisParameters(body: Record<string, unknown> | undefined): { targetColumn: string | null; periods: number } {
  const rawTarget = body?.target_column ?? body?.targetColumn ?? null;
  const targetColumn = rawTarget === null || rawTarget === undefined || rawTarget === '' ? null : String(rawTarget).trim();
  const periods = Number(body?.periods ?? 3);
  if (targetColumn && (targetColumn.length > 128 || /[\r\n\0]/.test(targetColumn))) {
    throw Object.assign(new Error('Hedef kolon adı geçersiz.'), { status: 400, code: 'INVALID_TARGET_COLUMN' });
  }
  if (!Number.isInteger(periods) || periods < 1 || periods > 12) {
    throw Object.assign(new Error('Tahmin ufku 1 ile 12 arasında tam sayı olmalıdır.'), { status: 400, code: 'INVALID_FORECAST_HORIZON' });
  }
  return { targetColumn, periods };
}

async function persistAnalysisResult(input: {
  req: AuthenticatedRequest;
  dataset: CombinedDataset;
  targetColumn: string | null;
  periods: number;
  result: Record<string, unknown>;
}) {
  const organizationId = input.req.organization!.organization_id;
  const run = await createAnalysisRun({
    organizationId,
    createdBy: input.req.user!.email,
    datasetIds: input.dataset.datasetIds,
    datasetFilename: input.dataset.filename,
    targetColumn: input.targetColumn,
    periods: input.periods,
    result: input.result
  });
  void addAuditLog(
    organizationId,
    'ML Analysis Completed',
    `Doğrulamalı analiz tamamlandı: ${input.dataset.filename}; hedef=${input.targetColumn || 'otomatik'}; ufuk=${input.periods}; run=${run.id}`,
    input.req.ip,
    input.req.user!.email
  ).catch((error) => logger.warn('Analiz audit kaydı yazılamadı.', { error }));
  return { ...input.result, analysisRunId: run.id };
}

async function refundMlReservation(organizationId: string): Promise<void> {
  try {
    await refundUsage(organizationId, 'ml_runs');
  } catch (error) {
    logger.error('Başarısız ML işi için kota rezervasyonu iade edilemedi.', { error });
  }
}

router.get('/forecast', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const organizationId = req.organization!.organization_id;
    const dataset = await getCombinedUserDataset(organizationId);
    if (!dataset) return res.status(404).json({ error: { code: 'NO_DATASET', message: 'Önce veri yükleyin.' } });
    await consumeUsage(organizationId, 'ml_runs');
    res.json(buildMlForecast(dataset.file_content, dataset.filename));
  } catch (err) {
    if (err instanceof PlanQuotaError) return res.status(429).json({ error: { code: err.code, message: err.message } });
    next(err);
  }
});

router.get('/insights', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const organizationId = req.organization!.organization_id;
    const dataset = await getCombinedUserDataset(organizationId);
    if (!dataset) return res.status(404).json({ error: { code: 'NO_DATASET', message: 'Önce veri yükleyin.' } });
    await consumeUsage(organizationId, 'ml_runs');
    res.json(buildMlInsights(dataset.file_content, dataset.filename));
  } catch (err) {
    if (err instanceof PlanQuotaError) return res.status(429).json({ error: { code: err.code, message: err.message } });
    next(err);
  }
});

router.post('/analyze', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const organizationId = req.organization!.organization_id;
    const jobOwner = `${organizationId}:${req.user!.email}`;
    const dataset = await getCombinedUserDataset(organizationId);
    if (!dataset) return res.status(404).json({ error: { code: 'NO_DATASET', message: 'Önce veri yükleyin.' } });
    const { targetColumn, periods } = analysisParameters(req.body);
    const headers = parseCsv(dataset.file_content)[0] ?? [];
    if (targetColumn && !headers.includes(targetColumn)) {
      return res.status(400).json({ error: { code: 'TARGET_COLUMN_NOT_FOUND', message: 'Seçilen hedef kolon analiz kapsamındaki veride bulunamadı.' } });
    }
    const analysisBody = { target_column: targetColumn, periods };
    await consumeUsage(organizationId, 'ml_runs');

    const threshold = Number(process.env.ML_ANALYZE_ASYNC_THRESHOLD_CHARS || 0);
    const requestedAsync = req.body?.async === true || req.query.async === '1';
    const exceedsThreshold = threshold > 0 && dataset.file_content.length > threshold;

    if (requestedAsync || exceedsThreshold) {
      let jobId: string;
      try {
        jobId = enqueueJob(jobOwner, dataset.file_content, {
          filename: dataset.filename,
          run: async () => {
            try {
              const result = await analyzeWithFastApi(organizationId, dataset, analysisBody);
              return await persistAnalysisResult({ req, dataset, targetColumn, periods, result });
            } catch (error) {
              await refundMlReservation(organizationId);
              throw error;
            }
          }
        });
      } catch (error) {
        await refundMlReservation(organizationId);
        throw error;
      }

      return res.status(202).json({
        jobId,
        status: 'queued',
        statusUrl: `/api/ml/job/${jobId}`,
        datasetIds: dataset.datasetIds,
        datasetCount: dataset.dataset_count,
        datasetFilename: dataset.filename
      });
    }

    try {
      const result = await analyzeWithFastApi(organizationId, dataset, analysisBody);
      res.json(await persistAnalysisResult({ req, dataset, targetColumn, periods, result }));
    } catch (error) {
      await refundMlReservation(organizationId);
      throw error;
    }
  } catch (err: any) {
    if (err instanceof PlanQuotaError) {
      return res.status(429).json({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof MlQueueLimitError) {
      return res.status(429).json({ error: { code: 'ML_QUEUE_FULL', message: err.message } });
    }
    if (err instanceof MlServiceError) {
      return res.status(502).json({ error: { code: 'ML_SERVICE_ERROR', message: err.message } });
    }
    next(err);
  }
});

router.get('/analyses', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const items = await listAnalysisRuns(req.organization!.organization_id, Number(req.query.limit || 20));
    res.json({
      items: items.map((run) => {
        const forecast = run.result.forecast as Record<string, any> | null | undefined;
        return {
          id: run.id,
          datasetIds: run.datasetIds,
          datasetFilename: run.datasetFilename,
          targetColumn: run.targetColumn,
          periods: run.periods,
          confidence: Number(forecast?.confidence || 0),
          metrics: forecast?.metrics || {},
          hasInterpretation: Boolean(run.interpretation),
          createdBy: run.createdBy,
          createdAt: run.createdAt
        };
      })
    });
  } catch (err) {
    next(err);
  }
});

router.get('/analyses/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const run = await getAnalysisRun(req.organization!.organization_id, req.params.id);
    if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Analiz kaydı bulunamadı.' } });
    res.json({ ...run.result, analysisRunId: run.id, interpretation: run.interpretation, createdAt: run.createdAt });
  } catch (err) {
    next(err);
  }
});

router.delete('/analyses/:id', requireRoles('admin', 'analyst'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const deleted = await deleteAnalysisRun(req.organization!.organization_id, req.params.id);
    if (!deleted) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Analiz kaydı bulunamadı.' } });
    res.json({ message: 'Analiz kaydı silindi.' });
  } catch (err) {
    next(err);
  }
});

router.post('/analyses/:id/interpret', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  let aiUsageReserved = false;
  try {
    const organizationId = req.organization!.organization_id;
    const run = await getAnalysisRun(organizationId, req.params.id);
    if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Yorumlanacak analiz kaydı bulunamadı.' } });
    if (run.interpretation && req.body?.refresh !== true) {
      return res.json({
        analysisRunId: run.id,
        interpretation: run.interpretation,
        provider: run.aiProvider,
        model: run.aiModel,
        cached: true
      });
    }
    const ai = getAiConfiguration();
    if (!ai.configured) {
      return res.status(503).json({ error: { code: 'AI_NOT_CONFIGURED', message: 'AI yorumlama servisi henüz yapılandırılmadı.' } });
    }
    if (process.env.ALLOW_EXTERNAL_AI_DATA !== 'true') {
      return res.status(403).json({ error: { code: 'AI_DATA_SHARING_DISABLED', message: 'Analiz özetinin harici AI servisine gönderimi yönetici tarafından kapalıdır.' } });
    }
    const rate = consumeAiRateLimit(`${organizationId}:${req.user!.email}`);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      return res.status(429).json({ error: { code: 'AI_RATE_LIMITED', message: 'Saatlik AI kullanım kotanıza ulaştınız.' } });
    }
    await consumeUsage(organizationId, 'ai_requests', 1, req.user!.email);
    aiUsageReserved = true;

    const result = run.result as Record<string, any>;
    const forecastPoints = Array.isArray(result.forecast?.data) ? result.forecast.data.slice(0, 12) : [];
    const forecastValues = forecastPoints
      .map((point: Record<string, any>) => Number(point?.predicted ?? point?.value ?? point?.yhat))
      .filter((value: number) => Number.isFinite(value));
    const lowerValues = forecastPoints
      .map((point: Record<string, any>) => Number(point?.lower ?? point?.lowerBound ?? point?.lower_bound))
      .filter((value: number) => Number.isFinite(value));
    const upperValues = forecastPoints
      .map((point: Record<string, any>) => Number(point?.upper ?? point?.upperBound ?? point?.upper_bound))
      .filter((value: number) => Number.isFinite(value));
    const targetKey = run.targetColumn
      .toLocaleLowerCase('tr-TR')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ı/g, 'i');
    const additiveTarget = /satis|sales|siparis|order|talep|demand|adet|quantity|qty|miktar|count|tutar|amount|ciro|revenue|gelir|income|kazanc|kar|profit|maliyet|cost/.test(targetKey);
    const firstForecast = forecastValues[0];
    const lastForecast = forecastValues[forecastValues.length - 1];
    const trendPercent = Number.isFinite(firstForecast) && firstForecast !== 0 && Number.isFinite(lastForecast)
      ? ((lastForecast - firstForecast) / Math.abs(firstForecast)) * 100
      : null;
    const businessSummary = forecastValues.length > 0 ? {
      target: run.targetColumn,
      periodCount: forecastValues.length,
      useTotal: additiveTarget,
      expectedTotal: forecastValues.reduce((sum: number, value: number) => sum + value, 0),
      expectedPeriodAverage: forecastValues.reduce((sum: number, value: number) => sum + value, 0) / forecastValues.length,
      firstPeriod: firstForecast,
      lastPeriod: lastForecast,
      firstToLastChangePercent: trendPercent,
      possibleTotalLower: lowerValues.length === forecastValues.length ? lowerValues.reduce((sum: number, value: number) => sum + value, 0) : null,
      possibleTotalUpper: upperValues.length === forecastValues.length ? upperValues.reduce((sum: number, value: number) => sum + value, 0) : null,
      possibleAverageLower: lowerValues.length === forecastValues.length ? lowerValues.reduce((sum: number, value: number) => sum + value, 0) / lowerValues.length : null,
      possibleAverageUpper: upperValues.length === forecastValues.length ? upperValues.reduce((sum: number, value: number) => sum + value, 0) / upperValues.length : null
    } : null;
    const evidence = {
      businessSummary,
      dataset: { target: run.targetColumn, periods: run.periods },
      datasetType: result.dataset_type,
      warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 20) : [],
      forecast: result.forecast ? {
        confidence: result.forecast.confidence,
        metrics: result.forecast.metrics,
        points: forecastPoints
      } : null,
      anomalies: result.anomalies ? {
        metrics: result.anomalies.metrics,
        points: Array.isArray(result.anomalies.data) ? result.anomalies.data.slice(0, 12) : []
      } : null,
      segments: result.segments ? {
        metrics: result.segments.metrics,
        groups: Array.isArray(result.segments.data) ? result.segments.data.slice(0, 8) : []
      } : null,
      classifications: Array.isArray(result.classifications)
        ? result.classifications.slice(0, 3).map((item: Record<string, any>) => ({
          confidence: item.confidence,
          metrics: item.metrics,
          highestRiskRows: Array.isArray(item.data) ? item.data.slice(0, 5) : []
        }))
        : []
    };
    const prompt = `Sen, veri veya yazılım bilgisi olmayan bir işletme sahibine sonuçları açıklayan deneyimli bir iş danışmanısın. Aşağıdaki kanıt doğrulanmış analiz sonuçlarını içerir. Türkçe, doğal ve doğrudan konuş.\n\nYanıt biçimi mutlaka şöyle olsun:\n## Beklenen sonuç\nÖnümüzdeki kaç dönemde ne kadar sonuç beklendiğini tek, net bir cümleyle söyle. businessSummary.useTotal true ise expectedTotal değerini, false ise expectedPeriodAverage değerini kullan.\n\n## Değişim\nİlk dönem ile son dönem arasındaki artış, düşüş veya dengeli görünümü sayıyla açıkla. Varsa olası alt ve üst aralığı anlaşılır biçimde belirt.\n\n## Önerilen adımlar\nİşletmenin şimdi uygulayabileceği en fazla 3 kısa ve somut öneri yaz. Artış varsa stok, ekip veya kapasite hazırlığını; düşüş varsa fiyat, kampanya ve müşteri kaybı incelemesini yalnız öneri olarak sun.\n\n## Tahmin notu\nTahminin geçmiş verilere dayandığını ve kampanya, fiyat, stok veya piyasa değişikliklerinin sonucu etkileyebileceğini tek cümleyle belirt.\n\nKesin kurallar:\n- Yalnız kanıttaki sayıları kullan; sayı, neden veya ilişki uydurma.\n- Kullanıcıya yöntem anlatma. "model", "algoritma", "makine öğrenmesi", "MAE", "RMSE", "R²", "SMAPE", "ROC-AUC", "holdout", "eğitim verisi", "test verisi", "regresyon", "confidence", "JSON" ve sağlayıcı adlarını yazma.\n- Teknik kolon adını aynen tekrarlamak yerine mümkünse satış, satış tutarı, satış adedi, ciro, gelir, kâr veya talep gibi doğal bir ad kullan.\n- Başlıklarda veya metinde kendi kendine soru sorma; soru cümlesi, Soru/Cevap biçimi ve varsayımsal diyalog kullanma.\n- confidence değerini gerçekleşme olasılığı gibi sunma.\n- Veri yetersizse bunu "Bu konuda net bir sonuç çıkarmak için yeterli geçmiş veri yok" diye açıkla.\n- Uzun giriş, teknik açıklama ve genel geçer övgü yazma.\n\n<dogrulanmis_analiz>\n${JSON.stringify(evidence)}\n</dogrulanmis_analiz>`;
    const response = await generateAiResponse(prompt);
    await saveAnalysisInterpretation(organizationId, run.id, response.text, response.provider, response.model);
    aiUsageReserved = false;
    void addAuditLog(
      organizationId,
      'AI Analysis Interpreted',
      `Kalıcı analiz AI ile yorumlandı: ${run.id}`,
      req.ip,
      req.user!.email
    ).catch((error) => logger.warn('AI yorum audit kaydı yazılamadı.', { error }));
    res.json({
      analysisRunId: run.id,
      interpretation: response.text,
      provider: response.provider,
      model: response.model,
      cached: false
    });
  } catch (err) {
    if (aiUsageReserved) await refundUsage(req.organization!.organization_id, 'ai_requests', 1, req.user!.email).catch(() => undefined);
    if (err instanceof PlanQuotaError) return res.status(429).json({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof AiProviderError) {
      if (err.retryAfter) res.setHeader('Retry-After', err.retryAfter);
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    next(err);
  }
});

router.get('/job/:id', (req: AuthenticatedRequest, res: Response) => {
  const job = getJobStatus(req.params.id);
  const jobOwner = `${req.organization!.organization_id}:${req.user!.email}`;
  if (!job || job.email !== jobOwner) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'ML işi bulunamadı.' } });
  }

  const { email: _email, ...publicJob } = job;
  res.json(publicJob);
});

export default router;
