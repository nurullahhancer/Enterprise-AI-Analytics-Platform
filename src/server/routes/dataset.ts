import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import * as xlsx from 'xlsx';
import { AuthenticatedRequest } from '../index';
import {
  deleteActiveDataset,
  deleteDataset,
  listUserDatasets,
  saveUserDataset,
  setActiveDataset
} from '../../lib/db';
import { getCombinedUserDataset } from '../datasets/combined';
import { parseCsv } from '../ml/parser';
import { buildDatasetSummary } from '../ml/pipeline';
import logger from '../../lib/logger';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const lowerName = file.originalname.toLowerCase();
    const ok = lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls') || lowerName.endsWith('.csv');
    ok ? cb(null, true) : cb(new Error('Sadece CSV veya Excel dosyası yüklenebilir.'));
  }
});

const uploadMiddleware = upload.single('file');

async function parseUploadedFile(file: Express.Multer.File): Promise<string> {
  if (file.originalname.toLowerCase().endsWith('.xlsx') || file.originalname.toLowerCase().endsWith('.xls')) {
    const workbook = xlsx.read(file.buffer, { type: 'buffer' });
    return xlsx.utils.sheet_to_csv(workbook.Sheets[workbook.SheetNames[0]]);
  }

  return file.buffer.toString('utf-8');
}

function metadataFromContent(content: string) {
  const rows = parseCsv(content);
  return {
    rowCount: Math.max(0, rows.length - 1),
    columnCount: rows[0]?.length ?? 0
  };
}

function uploadHandler(req: AuthenticatedRequest, res: Response, _next: NextFunction) {
  uploadMiddleware(req, res, async (err) => {
    if (err) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
    if (!req.file) return res.status(400).json({ error: { code: 'MISSING_FILE', message: 'Lütfen bir dosya seçin.' } });

    const email = req.user!.email;

    try {
      let content = await parseUploadedFile(req.file);
      const maxChars = Number(process.env.MAX_DATASET_CONTEXT_CHARS || 300_000);
      let warning = '';
      if (content.length > maxChars) {
        content = content.substring(0, maxChars);
        warning = `Dosya ${maxChars.toLocaleString('tr-TR')} karaktere kırpıldı.`;
      }

      const { rowCount, columnCount } = metadataFromContent(content);
      const id = await saveUserDataset(email, req.file.originalname, content, warning, rowCount, columnCount);

      logger.info(`Dataset yüklendi id=${id} kullanıcı=${email} dosya=${req.file.originalname}`);
      res.json({
        id,
        filename: req.file.originalname,
        rowCount,
        columnCount,
        warning,
        is_active: 1
      });
    } catch (e: any) {
      logger.error(`Dosya işleme hatası: ${e.message}`);
      res.status(500).json({ error: { code: 'PARSE_ERROR', message: 'Dosya okunamadı.' } });
    }
  });
}

async function listHandler(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await listUserDatasets(req.user!.email));
  } catch (err) {
    next(err);
  }
}

async function summaryHandler(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const dataset = await getCombinedUserDataset(req.user!.email);
    if (!dataset) {
      return res.status(404).json({ error: { code: 'NO_DATASET', message: 'Önce veri yükleyin.' } });
    }

    res.json({
      datasetIds: dataset.datasetIds,
      datasetCount: dataset.dataset_count,
      datasetFilename: dataset.filename,
      summary: buildDatasetSummary(dataset.file_content, dataset.filename)
    });
  } catch (err) {
    next(err);
  }
}

async function activateHandler(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Geçersiz dataset id.' } });
    }

    const changed = await setActiveDataset(req.user!.email, id);
    if (!changed) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Dataset bulunamadı.' } });

    res.json({ id, is_active: 1, message: 'Aktif dataset güncellendi.' });
  } catch (err) {
    next(err);
  }
}

async function deleteByIdHandler(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Geçersiz dataset id.' } });
    }

    const deleted = await deleteDataset(req.user!.email, id);
    if (!deleted) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Dataset bulunamadı.' } });

    logger.info(`Dataset silindi id=${id} kullanıcı=${req.user!.email}`);
    res.json({ message: 'Dataset silindi.' });
  } catch (err) {
    next(err);
  }
}

async function deleteActiveHandler(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const deleted = await deleteActiveDataset(req.user!.email);
    if (!deleted) return res.status(404).json({ error: { code: 'NO_DATASET', message: 'Silinecek aktif dataset yok.' } });
    res.json({ message: 'Aktif dataset silindi.' });
  } catch (err) {
    next(err);
  }
}

router.post('/upload', uploadHandler);
router.post('/dataset/upload', uploadHandler);
router.post('/datasets/upload', uploadHandler);

router.get('/dataset/list', listHandler);
router.get('/datasets', listHandler);

router.get('/dataset/summary', summaryHandler);

router.delete('/dataset', deleteActiveHandler);

router.post('/dataset/:id/active', activateHandler);
router.put('/dataset/:id/active', activateHandler);
router.post('/datasets/:id/active', activateHandler);
router.put('/datasets/:id/active', activateHandler);

router.delete('/dataset/:id', deleteByIdHandler);
router.delete('/datasets/:id', deleteByIdHandler);

export { router as datasetRouter };
