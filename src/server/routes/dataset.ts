import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { AuthenticatedRequest, requireRoles } from '../index';
import {
  deleteActiveDataset,
  deleteDataset,
  listUserDatasets,
  saveUserDataset,
  setActiveDataset,
  StorageQuotaError
} from '../../lib/db';
import { getCombinedUserDataset } from '../datasets/combined';
import { parseCsv } from '../ml/parser';
import { buildDatasetSummary } from '../ml/pipeline';
import logger from '../../lib/logger';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const lowerName = file.originalname.toLowerCase();
    lowerName.endsWith('.csv') ? cb(null, true) : cb(new Error('Güvenli aktarım için yalnızca CSV dosyası yüklenebilir.'));
  }
});

const uploadMiddleware = upload.single('file');

async function parseUploadedFile(file: Express.Multer.File): Promise<string> {
  const content = file.buffer.toString('utf-8').replace(/^\uFEFF/, '');
  if (content.includes('\0')) throw new Error('Geçersiz ikili dosya içeriği.');
  return content;
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
      const content = await parseUploadedFile(req.file);
      const maxChars = Math.min(Number(process.env.MAX_DATASET_STORAGE_CHARS || 5_000_000), 10_000_000);
      if (content.length > maxChars) {
        return res.status(413).json({ error: { code: 'DATASET_TOO_LARGE', message: `CSV içeriği en fazla ${maxChars.toLocaleString('tr-TR')} karakter olabilir.` } });
      }

      const { rowCount, columnCount } = metadataFromContent(content);
      if (rowCount < 1 || columnCount < 1) {
        return res.status(400).json({ error: { code: 'EMPTY_DATASET', message: 'CSV başlık ve en az bir veri satırı içermelidir.' } });
      }
      const safeFilename = req.file.originalname.replace(/[\r\n\0]/g, '').slice(0, 200);
      const id = await saveUserDataset(email, safeFilename, content, '', rowCount, columnCount);

      logger.info('Dataset yüklendi.', { id, rowCount, columnCount });
      res.json({
        id,
        filename: safeFilename,
        rowCount,
        columnCount,
        warning: '',
        is_active: 1
      });
    } catch (e: any) {
      if (e instanceof StorageQuotaError) {
        return res.status(413).json({ error: { code: e.code, message: e.message } });
      }
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

    logger.info('Dataset silindi.', { id });
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

router.post('/upload', requireRoles('admin', 'analyst'), uploadHandler);
router.post('/dataset/upload', requireRoles('admin', 'analyst'), uploadHandler);
router.post('/datasets/upload', requireRoles('admin', 'analyst'), uploadHandler);

router.get('/dataset/list', listHandler);
router.get('/datasets', listHandler);

router.get('/dataset/summary', summaryHandler);

router.delete('/dataset', requireRoles('admin', 'analyst'), deleteActiveHandler);

router.post('/dataset/:id/active', requireRoles('admin', 'analyst'), activateHandler);
router.put('/dataset/:id/active', requireRoles('admin', 'analyst'), activateHandler);
router.post('/datasets/:id/active', requireRoles('admin', 'analyst'), activateHandler);
router.put('/datasets/:id/active', requireRoles('admin', 'analyst'), activateHandler);

router.delete('/dataset/:id', requireRoles('admin', 'analyst'), deleteByIdHandler);
router.delete('/datasets/:id', requireRoles('admin', 'analyst'), deleteByIdHandler);

export { router as datasetRouter };
