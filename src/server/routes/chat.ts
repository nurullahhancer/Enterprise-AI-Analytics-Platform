import { Router, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../index';
import { getCombinedUserDataset } from '../datasets/combined';
import { getDocumentsForSearch } from '../../lib/db';
import { SYSTEM_PROMPT, sanitizeQuery } from '../../lib/prompts';
import logger from '../../lib/logger';
import { AiProviderError, generateAiResponse, getAiConfiguration } from '../ai/provider';

const router = Router();
const aiUsage = new Map<string, { count: number; resetAt: number }>();
const AI_USAGE_WINDOW_MS = 60 * 60_000;
const MAX_AI_USAGE_KEYS = 10_000;

function aiRequestLimit(): number {
  const parsed = Number(process.env.AI_REQUESTS_PER_HOUR || 20);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(parsed, 500)) : 20;
}

function consumeAiQuota(email: string): boolean {
  const now = Date.now();
  for (const [key, entry] of aiUsage) {
    if (entry.resetAt <= now) aiUsage.delete(key);
  }
  while (aiUsage.size >= MAX_AI_USAGE_KEYS) {
    const oldest = aiUsage.keys().next().value;
    if (oldest === undefined) break;
    aiUsage.delete(oldest);
  }
  const current = aiUsage.get(email);
  if (current && current.count >= aiRequestLimit()) return false;
  aiUsage.set(email, {
    count: (current?.count ?? 0) + 1,
    resetAt: current?.resetAt ?? now + AI_USAGE_WINDOW_MS
  });
  return true;
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
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 8)
    .map((chunk) => `Belge: ${chunk.filename}\nİçerik:\n${chunk.text}`)
    .join('\n\n');
  return selected.slice(0, maxChars) || 'Henüz doküman havuzuna dosya yüklenmedi.';
}

router.post('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const t0 = Date.now();
  try {
    const { message, mode } = req.body;
    if (typeof message !== 'string' || !message.trim() || message.length > 4_000)
      return res.status(400).json({ error: { code: 'INVALID_MESSAGE', message: 'Mesaj 1-4000 karakter arasında olmalıdır.' } });

    const aiConfig = getAiConfiguration();
    if (!aiConfig.configured)
      return res.status(503).json({ error: { code: 'AI_NOT_CONFIGURED', message: 'AI özelliği için servis anahtarı henüz yapılandırılmadı.' } });
    if (process.env.ALLOW_EXTERNAL_AI_DATA !== 'true')
      return res.status(403).json({ error: { code: 'AI_DATA_SHARING_DISABLED', message: 'Müşteri verisinin harici AI servisine gönderimi yönetici tarafından kapalıdır.' } });

    const email = req.user!.email;
    if (!consumeAiQuota(email)) {
      res.setHeader('Retry-After', '3600');
      return res.status(429).json({ error: { code: 'AI_RATE_LIMITED', message: 'Saatlik AI kullanım kotanıza ulaştınız.' } });
    }

    const isRag = mode === 'rag';
    
    let prompt = '';

    if (isRag) {
      const documents = await getDocumentsForSearch(email);
      const docContext = relevantDocumentContext(documents, message);
        
      prompt = `Sen ReAi Kurumsal Doküman Asistanısın (RAG Engine). Kullanıcının sorduğu soruları, aşağıda sağlanan kurumsal dokümanların içeriğine sadık kalarak ve doğru bir şekilde cevaplamalısın. Bilgiyi uydurmamalısın. Eğer dokümanda cevap yoksa bunu belirtmelisin.\n\nKurumsal Dokümanlar:\n${docContext}\n\nKullanıcı Sorusu: ${sanitizeQuery(message)}`;
    } else {
      const dataset = await getCombinedUserDataset(email);
      const context = dataset
        ? [
            `Yuklenen tum dosyalar: ${dataset.filenames.join(', ')}`,
            `${dataset.dataset_count} dosya, ${dataset.row_count} satir, ${dataset.column_count} kolon`,
            '',
            'Birlesik dosya icerigi:',
            dataset.file_content.slice(0, Math.min(Number(process.env.MAX_DATASET_CONTEXT_CHARS || 100_000), 300_000))
          ].join('\n')
        : 'Henuz veri seti yuklenmedi.';
        
      prompt = `${SYSTEM_PROMPT}\n\nKullanici veri seti bilgisi:\n${context}\n\nKullanici Sorusu: ${sanitizeQuery(message)}`;
    }

    const response = await generateAiResponse(prompt);

    logger.info('AI yanıtı tamamlandı.', {
      mode: isRag ? 'rag' : 'dataset',
      provider: response.provider,
      model: response.model,
      durationMs: Date.now() - t0
    });
    res.json({ response: response.text, warning: null });
  } catch (err) {
    if (err instanceof AiProviderError) {
      if (err.retryAfter) res.setHeader('Retry-After', err.retryAfter);
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    next(err);
  }
});

export default router;
