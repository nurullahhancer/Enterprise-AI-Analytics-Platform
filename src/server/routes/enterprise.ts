import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { PDFParse } from 'pdf-parse';
import { AuthenticatedRequest, requireRoles } from '../index';
import {
  listConnections,
  createConnection,
  deleteConnection,
  getConnection,
  listDocuments,
  saveDocument,
  deleteDocument,
  listAuditLogs,
  addAuditLog,
  listOrganizations,
  getUserRole,
  changeUserRole,
  saveUserDataset,
  listNotifications,
  addNotification,
  markNotificationsRead,
  StorageQuotaError
} from '../../lib/db';
import logger from '../../lib/logger';
import {
  decryptConnectorConfig,
  encryptConnectorConfig,
  isConnectorEncryptionConfigured,
  publicConnectorConfig
} from '../../lib/secrets';
import { fetchPublicJson } from '../../lib/safeFetch';
import { getCombinedUserDataset } from '../datasets/combined';
import { transformCsv } from '../etl/transform';

const router = Router();

async function persistSideEffects(tasks: Array<Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failed = results.filter((result) => result.status === 'rejected').length;
  if (failed > 0) logger.warn('İkincil audit/bildirim kaydı tamamlanamadı.', { failed });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const lowerName = file.originalname.toLowerCase();
    const ok = lowerName.endsWith('.pdf') || lowerName.endsWith('.txt');
    ok ? cb(null, true) : cb(new Error('Sadece PDF veya TXT dosyası yüklenebilir.'));
  }
});

const docUploadMiddleware = upload.single('file');

// ── 1. Connections ────────────────────────────────────────────────────────
router.get('/connections', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const connections = await listConnections(req.user!.email);
    res.json(connections.map((connection) => {
      try {
        const parsed = JSON.parse(decryptConnectorConfig(connection.config));
        return { ...connection, config: JSON.stringify(publicConnectorConfig(parsed)), encryptionStatus: 'encrypted' };
      } catch {
        return { id: connection.id, type: connection.type, name: connection.name, created_at: connection.created_at, config: '{}', encryptionStatus: 'unavailable' };
      }
    }));
  } catch (err) { next(err); }
});

router.post('/connections', requireRoles('admin'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { name, type, config } = req.body;
    if (!name || !type || !config) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'İsim, tip ve konfigürasyon alanları zorunludur.' } });
    }
    if (type !== 'api') {
      return res.status(422).json({ error: { code: 'CONNECTOR_NOT_SUPPORTED', message: 'Bu sürümde yalnızca allowlist ile korunan REST JSON konnektörü destekleniyor.' } });
    }
    if (!isConnectorEncryptionConfigured()) {
      return res.status(503).json({ error: { code: 'ENCRYPTION_NOT_CONFIGURED', message: 'Konnektör şifreleme anahtarı henüz yapılandırılmadı.' } });
    }
    const safeName = String(name).trim();
    if (safeName.length < 2 || safeName.length > 100 || typeof config !== 'object' || Array.isArray(config)) {
      return res.status(400).json({ error: { code: 'INVALID_CONNECTOR', message: 'Konnektör adı veya yapılandırması geçersiz.' } });
    }
    const rawUrl = typeof config.url === 'string' ? config.url.trim() : '';
    if (!rawUrl || rawUrl.length > 2_000) {
      return res.status(400).json({ error: { code: 'INVALID_URL', message: 'Geçerli bir REST endpoint adresi girin.' } });
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return res.status(400).json({ error: { code: 'INVALID_URL', message: 'Geçerli bir REST endpoint adresi girin.' } });
    }
    if (parsedUrl.username || parsedUrl.password) {
      return res.status(400).json({ error: { code: 'URL_CREDENTIAL_NOT_ALLOWED', message: 'URL içinde kullanıcı adı veya parola kullanılamaz.' } });
    }
    const sensitiveQueryName = /(^|[_-])(api[_-]?key|access[_-]?token|token|secret|password|passwd|credential|signature|sig|auth)($|[_-])/i;
    if ([...parsedUrl.searchParams.keys()].some((key) => sensitiveQueryName.test(key))) {
      return res.status(400).json({ error: { code: 'URL_CREDENTIAL_NOT_ALLOWED', message: 'Kimlik bilgileri URL query parametresinde taşınamaz.' } });
    }

    const email = req.user!.email;
    const storedConfig = { url: rawUrl, method: 'GET' };
    const configStr = encryptConnectorConfig(JSON.stringify(storedConfig));
    const id = await createConnection(email, type, safeName, configStr);

    await persistSideEffects([
      addAuditLog(email, 'Connector Created', `Yeni REST bağlantısı oluşturuldu: ${safeName}`, req.ip),
      addNotification(email, 'Yeni Konnektör Eklendi', `"${safeName}" REST bağlantısı güvenli biçimde kaydedildi.`)
    ]);
    
    res.status(201).json({ id, name: safeName, type, config: publicConnectorConfig(storedConfig) });
  } catch (err) { next(err); }
});

router.delete('/connections/:id', requireRoles('admin'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const email = req.user!.email;
    
    const conn = await getConnection(email, id);
    if (!conn) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bağlantı bulunamadı.' } });
    
    await deleteConnection(email, id);
    await persistSideEffects([
      addAuditLog(email, 'Connector Deleted', `Bağlantı silindi: ${conn.name}`),
      addNotification(email, 'Konnektör Kaldırıldı', `"${conn.name}" bağlantısı silindi.`)
    ]);
    
    res.json({ message: 'Bağlantı silindi.' });
  } catch (err) { next(err); }
});

router.post('/connections/:id/ingest', requireRoles('admin', 'analyst'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const email = req.user!.email;
    const conn = await getConnection(email, id);
    if (!conn) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bağlantı bulunamadı.' } });

    if (conn.type !== 'api') {
      return res.status(501).json({ error: { code: 'CONNECTOR_NOT_IMPLEMENTED', message: 'SQL ingest bu sürümde etkin değildir.' } });
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(decryptConnectorConfig(conn.config));
    } catch {
      return res.status(503).json({ error: { code: 'CONNECTOR_CONFIG_UNAVAILABLE', message: 'Konnektör yapılandırması çözülemedi; bağlantıyı yeniden oluşturun.' } });
    }

    const json = await fetchPublicJson(String(config.url || ''));
    const items = (Array.isArray(json) ? json : [json]).slice(0, 1_000);
    if (items.length === 0 || items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
      return res.status(422).json({ error: { code: 'UNSUPPORTED_RESPONSE', message: 'REST yanıtı nesne veya nesne listesi olmalıdır.' } });
    }
    const headers = [...new Set(items.flatMap((item) => Object.keys(item as Record<string, unknown>)))].slice(0, 100);
    const csvCell = (value: unknown) => {
      const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csvContent = [
      headers.map(csvCell).join(','),
      ...items.map((item) => headers.map((header) => csvCell((item as Record<string, unknown>)[header])).join(','))
    ].join('\n');
    const filename = `${conn.name.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 80)}_ingest.csv`;

    const rowCount = items.length;
    const colCount = headers.length;

    const datasetId = await saveUserDataset(email, filename, csvContent, '', rowCount, colCount);
    await persistSideEffects([
      addAuditLog(email, 'Data Ingested', `REST konnektöründen veri çekildi: ${conn.name} (Dataset ID: ${datasetId})`, req.ip),
      addNotification(email, 'Veri Eşitleme Tamamlandı', `"${conn.name}" konnektöründen çekilen veriler "${filename}" adıyla analize eklendi.`)
    ]);

    res.json({
      message: 'Veri başarıyla içeri aktarıldı ve aktif veri kümesi olarak ayarlandı.',
      dataset: { id: datasetId, filename, rowCount, columnCount: colCount }
    });
  } catch (err) {
    if (err instanceof StorageQuotaError) {
      return res.status(413).json({ error: { code: err.code, message: err.message } });
    }
    logger.warn('REST ingest başarısız.', { reason: err instanceof Error ? err.message : 'unknown' });
    return res.status(502).json({ error: { code: 'REST_INGEST_FAILED', message: err instanceof Error ? err.message : 'REST servisine bağlanılamadı.' } });
  }
});

// ── 2. Documents & RAG (PDF/TXT parser) ──────────────────────────────────
router.get('/documents', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const docs = await listDocuments(req.user!.email);
    res.json(docs.map(({ content: _content, ...metadata }) => metadata));
  } catch (err) { next(err); }
});

router.post('/documents', requireRoles('admin', 'analyst'), async (req: AuthenticatedRequest, res: Response) => {
  docUploadMiddleware(req, res, async (err) => {
    if (err) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
    if (!req.file) return res.status(400).json({ error: { code: 'MISSING_FILE', message: 'Lütfen bir PDF veya TXT dosyası yükleyin.' } });

    const email = req.user!.email;
    const filename = req.file.originalname.replace(/[\r\n\0]/g, '').slice(0, 200);

    try {
      let content = '';
      if (filename.toLowerCase().endsWith('.pdf')) {
        if (!req.file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
          return res.status(400).json({ error: { code: 'INVALID_PDF', message: 'Dosya geçerli bir PDF değil.' } });
        }
        const parser = new PDFParse({ data: req.file.buffer });
        try {
          const parsed = await parser.getText();
          content = parsed.text;
        } finally {
          await parser.destroy();
        }
      } else {
        content = req.file.buffer.toString('utf-8');
      }

      content = content.replace(/\0/g, '').trim();
      if (!content) return res.status(422).json({ error: { code: 'EMPTY_DOCUMENT', message: 'Dokümanda okunabilir metin bulunamadı.' } });
      const maxDocumentChars = Math.min(Number(process.env.MAX_DOCUMENT_CHARS || 500_000), 1_000_000);
      if (content.length > maxDocumentChars) {
        return res.status(413).json({ error: { code: 'DOCUMENT_TOO_LARGE', message: 'Doküman metni izin verilen boyutu aşıyor.' } });
      }

      const chunksCount = Math.max(1, Math.ceil(content.length / 500));
      const id = await saveDocument(email, filename, content, chunksCount);

      await persistSideEffects([
        addAuditLog(email, 'Document Indexed', `Doküman yerel metin araması için hazırlandı: ${filename}`, req.ip),
        addNotification(email, 'Doküman Hazır', `"${filename}" dosyası okundu ve ${chunksCount} metin parçasına ayrıldı.`)
      ]);
      
      res.status(201).json({ id, filename, chunksCount, status: 'ready' });
    } catch (parseErr: any) {
      if (parseErr instanceof StorageQuotaError) {
        return res.status(413).json({ error: { code: parseErr.code, message: parseErr.message } });
      }
      logger.error(`Document parsing failure: ${parseErr.message}`);
      res.status(500).json({ error: { code: 'PARSE_ERROR', message: 'Doküman okunamadı veya ayrıştırılamadı.' } });
    }
  });
});

router.delete('/documents/:id', requireRoles('admin'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const email = req.user!.email;
    const deleted = await deleteDocument(email, id);
    if (!deleted) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Doküman bulunamadı.' } });
    await persistSideEffects([
      addAuditLog(email, 'Document Deleted', `RAG Dokümanı silindi (ID: ${id})`),
      addNotification(email, 'Doküman Silindi', `ID'si ${id} olan RAG belgesi sistemden kaldırıldı.`)
    ]);
    
    res.json({ message: 'Doküman silindi.' });
  } catch (err) { next(err); }
});

// ── 3. Audit Logs ────────────────────────────────────────────────────────
router.get('/audit-logs', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const logs = await listAuditLogs(req.user!.email);
    res.json(logs);
  } catch (err) { next(err); }
});

// ── 4. Tenants ───────────────────────────────────────────────────────────
router.get('/tenants', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgs = await listOrganizations(req.user!.email);
    res.json(orgs);
  } catch (err) { next(err); }
});

router.post('/tenants', requireRoles('admin'), (_req: AuthenticatedRequest, res: Response) => {
  return res.status(501).json({ error: { code: 'TENANCY_NOT_ENABLED', message: 'Paylaşımlı organizasyon üyeliği tamamlanmadan tenant oluşturma etkinleştirilemez.' } });
});

// ── 5. User Roles (RBAC) ────────────────────────────────────────────────
router.get('/roles', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const role = await getUserRole(req.user!.email);
    res.json({ role });
  } catch (err) { next(err); }
});

router.put('/roles', requireRoles('admin'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { role, email: targetEmail } = req.body;
    if (typeof role !== 'string' || !['admin', 'analyst', 'viewer'].includes(role.toLowerCase())) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Geçersiz yetki rolü.' } });
    }
    const normalizedRole = role.toLowerCase() as 'admin' | 'analyst' | 'viewer';
    const normalizedTarget = String(targetEmail || '').trim().toLowerCase();
    const result = await changeUserRole(normalizedTarget, normalizedRole);
    if (result === 'not_found') return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Kullanıcı bulunamadı.' } });
    if (result === 'last_admin') {
      return res.status(409).json({ error: { code: 'LAST_ADMIN', message: 'Son yönetici rolü düşürülemez.' } });
    }
    await persistSideEffects([
      addAuditLog(req.user!.email, 'Role Changed', `Kullanıcı rolü güncellendi: ${normalizedTarget} -> ${normalizedRole}`, req.ip),
      addNotification(normalizedTarget, 'Erişim Yetkisi Güncellendi', `Erişim rolünüz "${normalizedRole.toUpperCase()}" olarak güncellendi.`)
    ]);
    
    res.json({ success: true, email: normalizedTarget, role: normalizedRole });
  } catch (err) { next(err); }
});

// ── 6. Advanced ETL Transformation ──────────────────────────────────────
router.post('/etl/run', requireRoles('admin', 'analyst'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { operations } = req.body;
    const email = req.user!.email;
    if (!Array.isArray(operations)) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'ETL adımları liste olarak gönderilmelidir.' } });
    const dataset = await getCombinedUserDataset(email);
    if (!dataset) return res.status(404).json({ error: { code: 'NO_DATASET', message: 'ETL çalıştırmadan önce veri yükleyin.' } });

    const result = transformCsv(dataset.file_content, operations.map(String));
    const operationsStr = result.operations.join(', ');
    await persistSideEffects([addAuditLog(email, 'ETL Job Started', `ETL dönüşümü başlatıldı: [${operationsStr}]`, req.ip)]);

    const filename = `ETL_Pipeline_Transformation_${Date.now()}.csv`;
    const newId = await saveUserDataset(email, filename, result.csv, '', result.rowCount, result.columnCount);
    await persistSideEffects([
      addAuditLog(email, 'ETL Job Completed', `ETL işi tamamlandı. Yeni temiz veri seti yüklendi: ${filename}`),
      addNotification(email, 'ETL Pipeline Başarılı', 'Veri temizleme pipeline iş akışı tamamlandı. Temizlenmiş veri seti analize eklendi.')
    ]);

    res.json({
      message: 'ETL Dönüşüm akışı başarıyla tamamlandı. Temizlenmiş veri seti aktif edildi.',
      dataset: { id: newId, filename, rowCount: result.rowCount, columnCount: result.columnCount },
      stats: { filledCells: result.filledCells, removedRows: result.removedRows, operations: result.operations }
    });
  } catch (err) {
    if (err instanceof StorageQuotaError) {
      return res.status(413).json({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof Error) {
      return res.status(422).json({ error: { code: 'ETL_VALIDATION_ERROR', message: err.message } });
    }
    next(err);
  }
});

// ── 7. Notifications API ────────────────────────────────────────────────
router.get('/notifications', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const notifications = await listNotifications(req.user!.email);
    res.json(notifications);
  } catch (err) { next(err); }
});

router.post('/notifications/read', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await markNotificationsRead(req.user!.email);
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
