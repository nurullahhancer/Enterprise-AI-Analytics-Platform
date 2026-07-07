import { Router, Response, NextFunction } from 'express';
import { GoogleGenAI } from '@google/genai';
import { AuthenticatedRequest } from '../index';
import { getCombinedUserDataset } from '../datasets/combined';
import { listDocuments } from '../../lib/db';
import { SYSTEM_PROMPT, sanitizeQuery } from '../../lib/prompts';
import logger from '../../lib/logger';

const router = Router();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

router.post('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const t0 = Date.now();
  try {
    const { message, mode } = req.body;
    if (!message) return res.status(400).json({ error: { code: 'MISSING_MESSAGE', message: 'Mesaj bos olamaz.' } });

    const email = req.user!.email;
    const isRag = mode === 'rag';
    
    let prompt = '';

    if (isRag) {
      const documents = await listDocuments(email);
      const docContext = documents.length > 0
        ? documents.map(d => `Belge: ${d.filename}\nİçerik:\n${d.content}`).join('\n\n')
        : 'Henüz RAG doküman havuzuna dosya yüklenmedi.';
        
      prompt = `Sen ReAi Kurumsal Doküman Asistanısın (RAG Engine). Kullanıcının sorduğu soruları, aşağıda sağlanan kurumsal dokümanların içeriğine sadık kalarak ve doğru bir şekilde cevaplamalısın. Bilgiyi uydurmamalısın. Eğer dokümanda cevap yoksa bunu belirtmelisin.\n\nKurumsal Dokümanlar:\n${docContext}\n\nKullanıcı Sorusu: ${sanitizeQuery(message)}`;
    } else {
      const dataset = await getCombinedUserDataset(email);
      const context = dataset
        ? [
            `Yuklenen tum dosyalar: ${dataset.filenames.join(', ')}`,
            `${dataset.dataset_count} dosya, ${dataset.row_count} satir, ${dataset.column_count} kolon`,
            '',
            'Birlesik dosya icerigi:',
            dataset.file_content
          ].join('\n')
        : 'Henuz veri seti yuklenmedi.';
        
      prompt = `${SYSTEM_PROMPT}\n\nKullanici veri seti bilgisi:\n${context}\n\nKullanici Sorusu: ${sanitizeQuery(message)}`;
    }

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });

    logger.info(`AI yanit (${isRag ? 'RAG' : 'Dataset'}) ${Date.now() - t0}ms kullanici=${email}`);
    res.json({ response: response.text, warning: null });
  } catch (err) {
    next(err);
  }
});

export default router;
