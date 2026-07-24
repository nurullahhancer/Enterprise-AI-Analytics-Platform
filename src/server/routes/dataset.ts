import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { AuthenticatedRequest, requireRoles } from '../index';
import {
  deleteActiveDataset,
  deleteDataset,
  listUserDatasets,
  saveUserDataset,
  setDatasetAnalysisScope,
  setActiveDataset,
  StorageQuotaError
} from '../../lib/db';
import { getCombinedUserDataset } from '../datasets/combined';
import { parseCsv } from '../ml/parser';
import { buildDatasetSummary } from '../ml/pipeline';
import logger from '../../lib/logger';
import { jsonToCsv } from '../datasets/normalize';
import { readFile, unlink } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const router = Router();
const uploadDirectory = process.env.DATASET_UPLOAD_TMP_DIR || path.resolve(process.cwd(), 'data', 'dataset-uploads');
mkdirSync(uploadDirectory, { recursive: true, mode: 0o750 });

const upload = multer({
  dest: uploadDirectory,
  limits: { files: 1 },
  fileFilter: (_req, file, cb) => {
    const lowerName = file.originalname.toLowerCase();
    lowerName.endsWith('.csv') || lowerName.endsWith('.json')
      ? cb(null, true)
      : cb(new Error('Güvenli aktarım için CSV veya JSON dosyası yükleyin.'));
  }
});

const uploadMiddleware = upload.single('file');

async function parseUploadedFile(file: Express.Multer.File): Promise<{
  content: string;
  rowCount: number;
  columnCount: number;
  sourceType: 'file' | 'json';
}> {
  const rawContent = (await readFile(file.path, 'utf-8')).replace(/^\uFEFF/, '');
  if (rawContent.includes('\0')) throw new Error('Geçersiz ikili dosya içeriği.');
  if (file.originalname.toLowerCase().endsWith('.json')) {
    const normalized = jsonToCsv(rawContent);
    return { content: normalized.csv, rowCount: normalized.rowCount, columnCount: normalized.columnCount, sourceType: 'json' };
  }
  const metadata = metadataFromContent(rawContent);
  return { content: rawContent, ...metadata, sourceType: 'file' };
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
    const organizationId = req.organization!.organization_id;

    try {
      const parsedFile = await parseUploadedFile(req.file);
      const { content, rowCount, columnCount, sourceType } = parsedFile;
      if (rowCount < 1 || columnCount < 1) {
        return res.status(400).json({ error: { code: 'EMPTY_DATASET', message: 'CSV başlık ve en az bir veri satırı içermelidir.' } });
      }
      const safeFilename = req.file.originalname.replace(/[\r\n\0]/g, '').slice(0, 200);
      const id = await saveUserDataset(
        organizationId,
        safeFilename,
        content,
        '',
        rowCount,
        columnCount,
        email,
        { sourceType }
      );

      logger.info('Dataset yüklendi.', { id, rowCount, columnCount });
      res.json({
        id,
        filename: safeFilename,
        rowCount,
        columnCount,
        sourceType,
        warning: '',
        is_active: 1
      });
    } catch (e: any) {
      if (e instanceof StorageQuotaError) {
        return res.status(413).json({ error: { code: e.code, message: e.message } });
      }
      logger.error(`Dosya işleme hatası: ${e.message}`);
      res.status(500).json({ error: { code: 'PARSE_ERROR', message: 'Dosya okunamadı.' } });
    } finally {
      await unlink(req.file.path).catch((cleanupError) => logger.warn('Geçici veri dosyası silinemedi.', { cleanupError }));
    }
  });
}

async function listHandler(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await listUserDatasets(req.organization!.organization_id));
  } catch (err) {
    next(err);
  }
}

async function summaryHandler(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const dataset = await getCombinedUserDataset(req.organization!.organization_id);
    if (!dataset) {
      return res.status(404).json({ error: { code: 'NO_DATASET', message: 'Önce veri yükleyin.' } });
    }

    res.json({
      datasetIds: dataset.datasetIds,
      datasetCount: dataset.dataset_count,
      selectedDatasetCount: dataset.selected_dataset_count,
      excludedFilenames: dataset.excluded_filenames,
      datasetFilename: dataset.filename,
      summary: buildDatasetSummary(dataset.file_content, dataset.filename)
    });
  } catch (err) {
    next(err);
  }
}

async function analysisGroupHandler(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const dataset = await getCombinedUserDataset(req.organization!.organization_id);
    if (!dataset) {
      return res.json({
        datasetIds: [],
        datasetCount: 0,
        selectedDatasetCount: 0,
        excludedFilenames: [],
        filename: null,
        rowCount: 0,
        columnCount: 0
      });
    }
    res.json({
      datasetIds: dataset.datasetIds,
      datasetCount: dataset.dataset_count,
      selectedDatasetCount: dataset.selected_dataset_count,
      excludedFilenames: dataset.excluded_filenames,
      filename: dataset.filename,
      rowCount: dataset.row_count,
      columnCount: dataset.column_count
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

    const changed = await setActiveDataset(req.organization!.organization_id, id);
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

    const deleted = await deleteDataset(req.organization!.organization_id, id);
    if (!deleted) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Dataset bulunamadı.' } });

    logger.info('Dataset silindi.', { id });
    res.json({ message: 'Dataset silindi.' });
  } catch (err) {
    next(err);
  }
}

async function deleteActiveHandler(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const deleted = await deleteActiveDataset(req.organization!.organization_id);
    if (!deleted) return res.status(404).json({ error: { code: 'NO_DATASET', message: 'Silinecek aktif dataset yok.' } });
    res.json({ message: 'Aktif dataset silindi.' });
  } catch (err) {
    next(err);
  }
}

async function analysisScopeHandler(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Veri seti ve kapsam seçimi geçersiz.' } });
    }
    const changed = await setDatasetAnalysisScope(req.organization!.organization_id, id, req.body.enabled);
    if (!changed) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Dataset bulunamadı.' } });
    res.json({ id, include_in_analysis: req.body.enabled ? 1 : 0 });
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
router.get('/dataset/analysis-group', analysisGroupHandler);
router.get('/datasets/analysis-group', analysisGroupHandler);

router.patch('/dataset/:id/analysis-scope', requireRoles('admin', 'analyst'), analysisScopeHandler);
router.patch('/datasets/:id/analysis-scope', requireRoles('admin', 'analyst'), analysisScopeHandler);

router.delete('/dataset', requireRoles('admin', 'analyst'), deleteActiveHandler);

router.post('/dataset/:id/active', requireRoles('admin', 'analyst'), activateHandler);
router.put('/dataset/:id/active', requireRoles('admin', 'analyst'), activateHandler);
router.post('/datasets/:id/active', requireRoles('admin', 'analyst'), activateHandler);
router.put('/datasets/:id/active', requireRoles('admin', 'analyst'), activateHandler);

router.delete('/dataset/:id', requireRoles('admin', 'analyst'), deleteByIdHandler);
router.delete('/datasets/:id', requireRoles('admin', 'analyst'), deleteByIdHandler);

export { router as datasetRouter };
