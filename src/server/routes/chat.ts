import { Router, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../index';
import { getCombinedUserDataset } from '../datasets/combined';
import { getDocumentsForSearch } from '../../lib/db';
import { cleanAssistantAnswer, SYSTEM_PROMPT, sanitizeQuery } from '../../lib/prompts';
import logger from '../../lib/logger';
import { AiProviderError, generateAiResponse, generateAiResponseStream, getAiConfiguration } from '../ai/provider';
import { consumeUsage, PlanQuotaError, recordAiProviderUsage, refundUsage } from '../../lib/saasDb';
import { recordAiMetrics } from '../../lib/metrics';
import { consumeAiRateLimit } from '../ai/quota';
import { buildDataProfile, buildDatasetSummary } from '../ml/pipeline';
import { getLatestAnalysisRun } from '../../lib/analysisDb';
import {
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  saveChatMessage
} from '../../lib/chatDb';

const router = Router();

async function recordProviderUsage(req: AuthenticatedRequest, response: Awaited<ReturnType<typeof generateAiResponse>>): Promise<void> {
  recordAiMetrics(response.provider, response.usage);
  await recordAiProviderUsage({
    organizationId: req.organization!.organization_id,
    email: req.user!.email,
    requestKind: 'chat',
    provider: response.provider,
    model: response.model,
    ...response.usage,
    requestId: String(req.headers['x-request-id'] || '') || undefined
  }).catch((error) => logger.error('AI sağlayıcı kullanım kaydı yazılamadı.', { error }));
}

function relevantDocumentContext(documents: any[], question: string): string {
  const maxChars = Math.min(Number(process.env.MAX_RAG_CONTEXT_CHARS || 40_000), 100_000);
  const terms = new Set(
    question.toLocaleLowerCase('tr-TR').split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 3)
  );
  const chunks = documents.flatMap((document) => {
    const content = String(document.content || '');
    return Array.from({ length: Math.ceil(content.length / 1_000) }, (_, index) => {
      const text = content.slice(index * 1_000, (index + 1) * 1_000);
      const lower = text.toLocaleLowerCase('tr-TR');
      const score = [...terms].reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
      return { filename: String(document.filename || 'belge'), text, score, index };
    });
  });

  const selected = chunks
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 8)
    .map((chunk) => `[KAYNAK:${chunk.filename}:PARCA-${chunk.index + 1}]\n${chunk.text}`)
    .join('\n\n');
  return selected.slice(0, maxChars) || 'SORUYLA_ESLESEN_KAYNAK_YOK';
}

function conversationContext(history: unknown): string {
  if (!Array.isArray(history)) return '';
  return history.slice(-10).map((item) => {
    if (!item || typeof item !== 'object') return '';
    const role = (item as any).role === 'assistant' ? 'assistant' : 'user';
    const content = sanitizeQuery(String((item as any).content || '')).slice(0, role === 'assistant' ? 1000 : 1000);
    return content ? { role, content } : null;
  }).filter(Boolean).map((item) => JSON.stringify(item)).join('\n');
}

// --- Chat Session Endpoints ---
router.get('/sessions', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const organizationId = req.organization!.organization_id;
    const email = req.user!.email;
    const sessions = await listChatSessions(organizationId, email);
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

router.post('/sessions', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const organizationId = req.organization!.organization_id;
    const email = req.user!.email;
    const { title, mode } = req.body || {};
    const session = await createChatSession(organizationId, email, title, mode);
    res.status(201).json({ session });
  } catch (err) {
    next(err);
  }
});

router.get('/sessions/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const organizationId = req.organization!.organization_id;
    const email = req.user!.email;
    const result = await getChatSession(organizationId, email, req.params.id);
    if (!result) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Sohbet oturumu bulunamadı.' } });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete('/sessions/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const organizationId = req.organization!.organization_id;
    const email = req.user!.email;
    const deleted = await deleteChatSession(organizationId, email, req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Silinecek sohbet oturumu bulunamadı.' } });
    }
    res.json({ message: 'Sohbet oturumu silindi.' });
  } catch (err) {
    next(err);
  }
});

// --- Main Chat Generation Endpoint ---
router.post('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const t0 = Date.now();
  let reservedUsage: { organizationId: string; email: string } | null = null;
  const refundReservedUsage = async () => {
    if (!reservedUsage) return;
    const reserved = reservedUsage;
    reservedUsage = null;
    await refundUsage(reserved.organizationId, 'ai_requests', 1, reserved.email).catch((error) => logger.warn('Başarısız AI isteği kullanım hakkı iade edilemedi.', { error }));
  };
  try {
    const { message, mode, stream, history, sessionId } = req.body;
    if (typeof message !== 'string' || !message.trim() || message.length > 4_000)
      return res.status(400).json({ error: { code: 'INVALID_MESSAGE', message: 'Mesaj 1-4000 karakter arasında olmalıdır.' } });

    const aiConfig = getAiConfiguration();
    if (!aiConfig.configured)
      return res.status(503).json({ error: { code: 'AI_NOT_CONFIGURED', message: 'AI özelliği için servis anahtarı henüz yapılandırılmadı.' } });
    if (process.env.ALLOW_EXTERNAL_AI_DATA !== 'true')
      return res.status(403).json({ error: { code: 'AI_DATA_SHARING_DISABLED', message: 'Müşteri verisinin harici AI servisine gönderimi yönetici tarafından kapalıdır.' } });

    const email = req.user!.email;
    const organizationId = req.organization!.organization_id;
    const rate = consumeAiRateLimit(`${organizationId}:${email}`);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      return res.status(429).json({ error: { code: 'AI_RATE_LIMITED', message: 'Saatlik AI kullanım kotanıza ulaştınız.' } });
    }
    await consumeUsage(organizationId, 'ai_requests', 1, email);
    reservedUsage = { organizationId, email };

    // Handle DB Session
    let activeSessionId = sessionId;
    if (!activeSessionId || typeof activeSessionId !== 'string') {
      const newSession = await createChatSession(organizationId, email, message.slice(0, 40), mode === 'rag' ? 'rag' : 'dataset');
      activeSessionId = newSession.id;
    }

    // Save user message to database
    await saveChatMessage(organizationId, email, activeSessionId, 'user', message.trim());

    const isRag = mode === 'rag';
    const recentConversation = conversationContext(history);
    const currentQuestion = sanitizeQuery(message);
    const allowDialogueFormat = /soru\s*[-–/]?\s*cevap|sss|faq|diyalog|röportaj/i.test(currentQuestion);
    
    let prompt = '';

    if (isRag) {
      const documents = await getDocumentsForSearch(organizationId);
      const docContext = relevantDocumentContext(documents, message);
        
      prompt = `Sen ReAi Kurumsal Doküman Asistanısın.

[BİRİNCİL ÖNCELİK: KULLANICININ YAZDIĞI MESAJ VE SORU]
Aşağıda kullanıcının sorduğu soru/mesaj bulunmaktadır. Yanıtında ÖNCELİKLE VE DOĞRUDAN bu soruyu yanıtla.

<guncel_soru (BİRİNCİL ÖNCELİK)>
${currentQuestion}
</guncel_soru>

${recentConversation ? `<konusma_baglami kullanım="yalnızca referans; cevapta tekrarlama">\n${recentConversation}\n</konusma_baglami>\n\n` : ''}<kaynaklar (ARKA PLAN DOKÜMANLARI)>
${docContext}
</kaynaklar>

Yalnızca kaynaklarda açıkça bulunan bilgileri kullan. Her önemli iddianın sonunda ilgili [KAYNAK:...:PARCA-N] etiketini aynen belirt. SORUYLA_ESLESEN_KAYNAK_YOK yazıyorsa cevabın bulunamadığını açıkça söyle. İlk cümlede doğrudan kullanıcının sorusunun cevabına başla.`;
    } else {
      const dataset = await getCombinedUserDataset(organizationId);
      let context = 'Henuz veri seti yuklenmedi.';
      if (dataset) {
        const profile = buildDataProfile(dataset.file_content);
        const summary = buildDatasetSummary(dataset.file_content, dataset.filename);
        const latestRun = await getLatestAnalysisRun(organizationId);
        const latestResult = latestRun?.result as Record<string, any> | undefined;
        const forecastPoints = Array.isArray(latestResult?.forecast?.data) ? latestResult.forecast.data.slice(0, 12) : [];
        const forecastValues = forecastPoints
          .map((point: Record<string, any>) => Number(point?.predicted ?? point?.value ?? point?.yhat))
          .filter((value: number) => Number.isFinite(value));
        const firstForecast = forecastValues[0];
        const lastForecast = forecastValues[forecastValues.length - 1];
        const forecastSummary = latestRun && forecastValues.length > 0 ? {
          target: latestRun.targetColumn,
          periodCount: forecastValues.length,
          expectedTotal: forecastValues.reduce((sum: number, value: number) => sum + value, 0),
          expectedPeriodAverage: forecastValues.reduce((sum: number, value: number) => sum + value, 0) / forecastValues.length,
          firstPeriod: firstForecast,
          lastPeriod: lastForecast,
          firstToLastChangePercent: firstForecast !== 0
            ? ((lastForecast - firstForecast) / Math.abs(firstForecast)) * 100
            : null,
          points: forecastPoints.map((point: Record<string, any>, index: number) => ({
            period: point?.date ?? point?.row ?? point?.period ?? `Dönem ${index + 1}`,
            expected: Number(point?.predicted ?? point?.value ?? point?.yhat)
          }))
        } : null;
        const evidence = {
          scope: { datasetCount: dataset.dataset_count, rowCount: dataset.row_count, columnCount: dataset.column_count },
          profile: {
            datasetType: profile.datasetType,
            columns: profile.columns.slice(0, 100).map((column) => ({
              name: column.name,
              type: column.type,
              nullRate: column.nullRate,
              uniqueCount: column.uniqueCount,
              minimum: column.min,
              maximum: column.max,
              average: column.mean,
              mostCommonValues: column.topValues
            }))
          },
          verifiedMetrics: {
            measuredValue: summary.valueColumn,
            groupedBy: summary.regionColumn,
            totalValue: summary.totalRevenue,
            totalCost: summary.totalCost,
            grossMarginPercent: summary.grossMargin,
            riskLossPercent: summary.churnRate,
            groupBreakdown: [...summary.chartData].sort((left, right) => right.ciro - left.ciro).slice(0, 50)
          },
          latestValidatedAnalysis: latestRun ? {
            id: latestRun.id,
            forecastSummary,
            unusualRecords: latestResult?.anomalies ? {
              count: Array.isArray(latestResult.anomalies.data) ? latestResult.anomalies.data.length : 0,
              records: Array.isArray(latestResult.anomalies.data) ? latestResult.anomalies.data.slice(0, 10) : []
            } : null,
            similarGroups: latestResult?.segments ? {
              count: Array.isArray(latestResult.segments.data) ? latestResult.segments.data.length : 0,
              groups: Array.isArray(latestResult.segments.data) ? latestResult.segments.data.slice(0, 10) : []
            } : null,
            warnings: latestResult?.warnings || []
          } : null
        };
        context = JSON.stringify(evidence);
      }
        
      prompt = `${SYSTEM_PROMPT}

[BİRİNCİL ÖNCELİK: KULLANICININ YAZDIĞI MESAJ VE SORU]
Aşağıda kullanıcının yazdığı güncel mesaj/soru bulunmaktadır. Yanıtında BİRİNCİL ÖNCELİK kullanıcının yazdıklarını ve sorduklarını doğrudan yanıtlamaktır. Sunucuda hesaplanmış veri ve ML analizleri, kullanıcının sorusunu desteklemek ve yanıtlamak için referans verisidir. Kullanıcının sorusunu göz ardı edip sadece ML analizlerini dökme.

<guncel_soru (BİRİNCİL ÖNCELİK)>
${currentQuestion}
</guncel_soru>

${recentConversation ? `<konusma_baglami kullanım="yalnızca referans; cevapta tekrarlama">\n${recentConversation}\n</konusma_baglami>\n\n` : ''}<sunucuda_hesaplanmis_kanit (DESTEKLEYİCİ BAĞLAM VERİSİ)>
${context}
</sunucuda_hesaplanmis_kanit>`;
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      res.write(': connected\n\n');
      res.write(`data: ${JSON.stringify({ sessionId: activeSessionId })}\n\n`);

      try {
        let bufferedAnswer = '';
        const response = await generateAiResponseStream(prompt, (chunkText) => {
          bufferedAnswer += chunkText;
          res.write(`data: ${JSON.stringify({ token: chunkText, sessionId: activeSessionId })}\n\n`);
        });
        const answer = cleanAssistantAnswer(bufferedAnswer, allowDialogueFormat);
        if (!answer) throw new AiProviderError(502, 'AI_EMPTY_RESPONSE', 'AI servisinden boş yanıt alındı.');
        await recordProviderUsage(req, response);
        
        // Save assistant message to DB
        await saveChatMessage(organizationId, email, activeSessionId, 'assistant', answer).catch((err) =>
          logger.error('Sohbet mesajı veri tabanına kaydedilemedi.', { error: err })
        );

        logger.info('AI akışı tamamlandı.', {
          mode: isRag ? 'rag' : 'dataset',
          provider: response.provider,
          model: response.model,
          sessionId: activeSessionId,
          durationMs: Date.now() - t0
        });

        res.write('data: [DONE]\n\n');
        reservedUsage = null;
        res.end();
      } catch (err) {
        await refundReservedUsage();
        const errObj = err instanceof AiProviderError ? { code: err.code, message: err.message } : { code: 'AI_PROVIDER_UNAVAILABLE', message: 'AI sağlayıcıya ulaşılamadı.' };
        logger.warn('AI akışı başarısız.', {
          mode: isRag ? 'rag' : 'dataset',
          code: errObj.code,
          durationMs: Date.now() - t0
        });
        res.write(`data: ${JSON.stringify({ error: errObj.message })}\n\n`);
        res.end();
      }
    } else {
      const response = await generateAiResponse(prompt);
      const answer = cleanAssistantAnswer(response.text, allowDialogueFormat);
      if (!answer) throw new AiProviderError(502, 'AI_EMPTY_RESPONSE', 'AI servisinden boş yanıt alındı.');
      await recordProviderUsage(req, response);

      // Save assistant message to DB
      await saveChatMessage(organizationId, email, activeSessionId, 'assistant', answer).catch((err) =>
        logger.error('Sohbet mesajı veri tabanına kaydedilemedi.', { error: err })
      );

      logger.info('AI yanıtı tamamlandı.', {
        mode: isRag ? 'rag' : 'dataset',
        provider: response.provider,
        model: response.model,
        sessionId: activeSessionId,
        durationMs: Date.now() - t0
      });
      res.json({ response: answer, warning: null, sessionId: activeSessionId });
      reservedUsage = null;
    }
  } catch (err) {
    await refundReservedUsage();
    if (err instanceof PlanQuotaError) {
      return res.status(429).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof AiProviderError) {
      if (err.retryAfter) res.setHeader('Retry-After', err.retryAfter);
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    next(err);
  }
});

export default router;
