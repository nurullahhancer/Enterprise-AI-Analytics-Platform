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
  saveUserDataset,
  listNotifications,
  addNotification,
  markNotificationsRead,
  StorageQuotaError,
  LastAdminError
} from '../../lib/db';
import { changeMemberRole } from '../../lib/saasDb';
import { listConnectorSyncRuns, updateConnectionSchedule } from '../../lib/connectorSyncDb';
import logger from '../../lib/logger';
import {
  decryptConnectorConfig,
  encryptConnectorConfig,
  isConnectorEncryptionConfigured,
  publicConnectorConfig
} from '../../lib/secrets';
import { getCombinedUserDataset } from '../datasets/combined';
import { transformCsv } from '../etl/transform';
import { ConnectorSynchronizationError, synchronizeConnector } from '../connectors/sync';
import { parsePostgresConnectorConfig } from '../connectors/postgres';
import { deliverBusinessAlert, validateBusinessWebhook } from '../../lib/notificationChannels';
import { BUSINESS_ALERT_EVENTS, BusinessAlertEvent, getNotificationSettings, saveNotificationSettings } from '../../lib/notificationSettingsDb';
import { applyDataRetentionPolicy, exportOrganizationData, getDataRetentionPolicy, saveDataRetentionPolicy } from '../../lib/governanceDb';

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
    const connections = await listConnections(req.organization!.organization_id);
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
    if (!['api', 'postgresql'].includes(type)) {
      return res.status(422).json({ error: { code: 'CONNECTOR_NOT_SUPPORTED', message: 'REST JSON veya PostgreSQL konnektörü seçin.' } });
    }
    if (!isConnectorEncryptionConfigured()) {
      return res.status(503).json({ error: { code: 'ENCRYPTION_NOT_CONFIGURED', message: 'Konnektör şifreleme anahtarı henüz yapılandırılmadı.' } });
    }
    const safeName = String(name).trim();
    if (safeName.length < 2 || safeName.length > 100 || typeof config !== 'object' || Array.isArray(config)) {
      return res.status(400).json({ error: { code: 'INVALID_CONNECTOR', message: 'Konnektör adı veya yapılandırması geçersiz.' } });
    }
    const email = req.user!.email;
    const organizationId = req.organization!.organization_id;
    let storedConfig: Record<string, unknown>;
    if (type === 'postgresql') {
      try {
        storedConfig = { ...parsePostgresConnectorConfig(config) };
      } catch (error) {
        return res.status(400).json({ error: { code: 'INVALID_SQL_CONNECTOR', message: error instanceof Error ? error.message : 'PostgreSQL yapılandırması geçersiz.' } });
      }
    } else {
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
      storedConfig = { url: rawUrl, method: 'GET' };
    }
    const configStr = encryptConnectorConfig(JSON.stringify(storedConfig));
    const id = await createConnection(organizationId, type, safeName, configStr, email);

    await persistSideEffects([
      addAuditLog(organizationId, 'Connector Created', `Yeni ${type === 'postgresql' ? 'PostgreSQL' : 'REST'} bağlantısı oluşturuldu: ${safeName}`, req.ip, email),
      addNotification(organizationId, 'Yeni Konnektör Eklendi', `"${safeName}" ${type === 'postgresql' ? 'PostgreSQL' : 'REST'} bağlantısı güvenli biçimde kaydedildi.`, email)
    ]);
    
    res.status(201).json({ id, name: safeName, type, config: publicConnectorConfig(storedConfig) });
  } catch (err) { next(err); }
});

router.delete('/connections/:id', requireRoles('admin'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const email = req.user!.email;
    const organizationId = req.organization!.organization_id;
    
    const conn = await getConnection(organizationId, id);
    if (!conn) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bağlantı bulunamadı.' } });
    
    await deleteConnection(organizationId, id);
    await persistSideEffects([
      addAuditLog(organizationId, 'Connector Deleted', `Bağlantı silindi: ${conn.name}`, req.ip, email),
      addNotification(organizationId, 'Konnektör Kaldırıldı', `"${conn.name}" bağlantısı silindi.`, email)
    ]);
    
    res.json({ message: 'Bağlantı silindi.' });
  } catch (err) { next(err); }
});

router.patch('/connections/:id/schedule', requireRoles('admin'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const enabled = req.body?.enabled;
    const intervalMinutes = Number(req.body?.intervalMinutes);
    if (!Number.isInteger(id) || id <= 0 || typeof enabled !== 'boolean' || !Number.isInteger(intervalMinutes) || intervalMinutes < 15 || intervalMinutes > 1_440) {
      return res.status(400).json({
        error: { code: 'INVALID_SYNC_SCHEDULE', message: 'Yenileme aralığı 15–1440 dakika arasında tam sayı olmalıdır.' }
      });
    }
    const organizationId = req.organization!.organization_id;
    const connection = await updateConnectionSchedule(organizationId, id, enabled, intervalMinutes);
    if (!connection) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bağlantı bulunamadı.' } });
    await addAuditLog(
      organizationId,
      enabled ? 'Connector Schedule Enabled' : 'Connector Schedule Disabled',
      enabled ? `Veri bağlantısı ${intervalMinutes} dakikada bir yenilenecek: ${connection.name}` : `Otomatik yenileme kapatıldı: ${connection.name}`,
      req.ip,
      req.user!.email
    );
    res.json({
      id: connection.id,
      scheduleEnabled: Boolean(connection.schedule_enabled),
      scheduleIntervalMinutes: connection.schedule_interval_minutes,
      nextSyncAt: connection.next_sync_at
    });
  } catch (err) { next(err); }
});

router.get('/connections/:id/sync-runs', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Bağlantı veya limit değeri geçersiz.' } });
    }
    const connection = await getConnection(req.organization!.organization_id, id);
    if (!connection) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bağlantı bulunamadı.' } });
    const items = await listConnectorSyncRuns(req.organization!.organization_id, id, limit);
    res.json({ items });
  } catch (err) { next(err); }
});

router.post('/connections/:id/ingest', requireRoles('admin', 'analyst'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Bağlantı kimliği geçersiz.' } });
    }
    const email = req.user!.email;
    const organizationId = req.organization!.organization_id;
    const result = await synchronizeConnector({ organizationId, connectionId: id, actorEmail: email, trigger: 'manual', ipAddress: req.ip });

    res.json({
      message: 'Veri kaynağının güncel snapshot verisi başarıyla eşitlendi.',
      dataset: result.dataset
    });
  } catch (err) {
    if (err instanceof ConnectorSynchronizationError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    logger.warn('Konnektör ingest başarısız.', { reason: err instanceof Error ? err.message : 'unknown' });
    next(err);
  }
});

// ── Organization notification channels ──────────────────────────────────
router.get('/notification-settings', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await getNotificationSettings(req.organization!.organization_id));
  } catch (err) { next(err); }
});

router.put('/notification-settings', requireRoles('admin'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const emailEnabled = req.body?.emailEnabled;
    const rawEvents = req.body?.events;
    if (typeof emailEnabled !== 'boolean' || !Array.isArray(rawEvents) || rawEvents.some((event) => !BUSINESS_ALERT_EVENTS.includes(event))) {
      return res.status(400).json({ error: { code: 'INVALID_NOTIFICATION_SETTINGS', message: 'Bildirim kanalı veya olay seçimi geçersiz.' } });
    }
    const events = [...new Set(rawEvents)] as BusinessAlertEvent[];
    const slackWebhook = req.body?.slackWebhook === undefined || req.body?.slackWebhook === '' ? undefined : validateBusinessWebhook('slack', req.body.slackWebhook);
    const teamsWebhook = req.body?.teamsWebhook === undefined || req.body?.teamsWebhook === '' ? undefined : validateBusinessWebhook('teams', req.body.teamsWebhook);
    if ((slackWebhook || teamsWebhook) && !isConnectorEncryptionConfigured()) {
      return res.status(503).json({ error: { code: 'ENCRYPTION_NOT_CONFIGURED', message: 'Webhook adreslerini saklamak için veri şifreleme anahtarı yapılandırılmalıdır.' } });
    }
    const settings = await saveNotificationSettings({
      organizationId: req.organization!.organization_id,
      actorEmail: req.user!.email,
      emailEnabled,
      events,
      slackWebhook,
      teamsWebhook,
      removeSlack: req.body?.removeSlack === true,
      removeTeams: req.body?.removeTeams === true
    });
    await addAuditLog(req.organization!.organization_id, 'Notification Settings Updated', 'E-posta/Slack/Teams iş bildirimleri güncellendi.', req.ip, req.user!.email);
    res.json(settings);
  } catch (err) {
    if (err instanceof Error && /webhook|Slack|Teams/.test(err.message)) {
      return res.status(400).json({ error: { code: 'INVALID_WEBHOOK', message: err.message } });
    }
    next(err);
  }
});

router.post('/notification-settings/test', requireRoles('admin'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await deliverBusinessAlert(req.organization!.organization_id, 'billing', 'Test bildirimi', 'ReAi kurum bildirim kanalları başarıyla doğrulandı.');
    await addAuditLog(req.organization!.organization_id, 'Notification Channels Tested', 'Harici bildirim kanalları için test gönderimi başlatıldı.', req.ip, req.user!.email);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.get('/data-governance', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try { res.json(await getDataRetentionPolicy(req.organization!.organization_id)); } catch (err) { next(err); }
});

router.put('/data-governance', requireRoles('admin'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const enabled = req.body?.enabled;
    const retentionDays = Number(req.body?.retentionDays);
    if (typeof enabled !== 'boolean' || !Number.isInteger(retentionDays) || retentionDays < 30 || retentionDays > 3_650) {
      return res.status(400).json({ error: { code: 'INVALID_RETENTION_POLICY', message: 'Saklama süresi 30-3650 gün arasında tam sayı olmalıdır.' } });
    }
    const policy = await saveDataRetentionPolicy(req.organization!.organization_id, req.user!.email, enabled, retentionDays);
    await addAuditLog(req.organization!.organization_id, 'Data Retention Policy Updated', `Saklama politikası: ${enabled ? 'etkin' : 'kapalı'}, ${retentionDays} gün.`, req.ip, req.user!.email);
    res.json(policy);
  } catch (err) { next(err); }
});

router.post('/data-governance/apply', requireRoles('admin'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const deleted = await applyDataRetentionPolicy(req.organization!.organization_id, true);
    await addAuditLog(req.organization!.organization_id, 'Data Retention Applied', `Saklama politikası manuel uygulandı: ${JSON.stringify(deleted)}`, req.ip, req.user!.email);
    res.json({ deleted });
  } catch (err) { next(err); }
});

router.get('/data-governance/export', requireRoles('admin'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const payload = await exportOrganizationData(req.organization!.organization_id);
    const filename = `reai-kurum-verisi-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(payload));
  } catch (err) { next(err); }
});

// ── 2. Documents & RAG (PDF/TXT parser) ──────────────────────────────────
router.get('/documents', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const docs = await listDocuments(req.organization!.organization_id);
    res.json(docs.map(({ content: _content, ...metadata }) => metadata));
  } catch (err) { next(err); }
});

router.post('/documents', requireRoles('admin', 'analyst'), async (req: AuthenticatedRequest, res: Response) => {
  docUploadMiddleware(req, res, async (err) => {
    if (err) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
    if (!req.file) return res.status(400).json({ error: { code: 'MISSING_FILE', message: 'Lütfen bir PDF veya TXT dosyası yükleyin.' } });

    const email = req.user!.email;
    const organizationId = req.organization!.organization_id;
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
      const id = await saveDocument(organizationId, filename, content, chunksCount, email);

      await persistSideEffects([
        addAuditLog(organizationId, 'Document Indexed', `Doküman yerel metin araması için hazırlandı: ${filename}`, req.ip, email),
        addNotification(organizationId, 'Doküman Hazır', `"${filename}" dosyası okundu ve ${chunksCount} metin parçasına ayrıldı.`, email)
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
    const organizationId = req.organization!.organization_id;
    const deleted = await deleteDocument(organizationId, id);
    if (!deleted) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Doküman bulunamadı.' } });
    await persistSideEffects([
      addAuditLog(organizationId, 'Document Deleted', `RAG Dokümanı silindi (ID: ${id})`, req.ip, email),
      addNotification(organizationId, 'Doküman Silindi', `ID'si ${id} olan RAG belgesi sistemden kaldırıldı.`, email)
    ]);
    
    res.json({ message: 'Doküman silindi.' });
  } catch (err) { next(err); }
});

// ── 3. Audit Logs ────────────────────────────────────────────────────────
router.get('/audit-logs', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const logs = await listAuditLogs(req.organization!.organization_id);
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
    res.json({ role: req.user!.role });
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
    const organizationId = req.organization!.organization_id;
    const result = await changeMemberRole(organizationId, normalizedTarget, normalizedRole);
    if (result === 'not_found') return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Kullanıcı bulunamadı.' } });
    await persistSideEffects([
      addAuditLog(organizationId, 'Role Changed', `Kullanıcı rolü güncellendi: ${normalizedTarget} -> ${normalizedRole}`, req.ip, req.user!.email),
      addNotification(organizationId, 'Erişim Yetkisi Güncellendi', `Erişim rolünüz "${normalizedRole.toUpperCase()}" olarak güncellendi.`, normalizedTarget)
    ]);
    
    res.json({ success: true, email: normalizedTarget, role: normalizedRole });
  } catch (err) {
    if (err instanceof LastAdminError) return res.status(409).json({ error: { code: 'LAST_ADMIN', message: err.message } });
    next(err);
  }
});

// ── 6. Advanced ETL Transformation ──────────────────────────────────────
router.post('/etl/run', requireRoles('admin', 'analyst'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { operations } = req.body;
    const email = req.user!.email;
    const organizationId = req.organization!.organization_id;
    if (!Array.isArray(operations)) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'ETL adımları liste olarak gönderilmelidir.' } });
    const dataset = await getCombinedUserDataset(organizationId);
    if (!dataset) return res.status(404).json({ error: { code: 'NO_DATASET', message: 'ETL çalıştırmadan önce veri yükleyin.' } });

    const result = transformCsv(dataset.file_content, operations.map(String));
    const operationsStr = result.operations.join(', ');
    await persistSideEffects([addAuditLog(organizationId, 'ETL Job Started', `ETL dönüşümü başlatıldı: [${operationsStr}]`, req.ip, email)]);

    const filename = `ETL_Pipeline_Transformation_${Date.now()}.csv`;
    const newId = await saveUserDataset(
      organizationId,
      filename,
      result.csv,
      '',
      result.rowCount,
      result.columnCount,
      email,
      { sourceType: 'etl', disableDatasetIds: dataset.datasetIds }
    );
    await persistSideEffects([
      addAuditLog(organizationId, 'ETL Job Completed', `ETL işi tamamlandı. Yeni temiz veri seti yüklendi: ${filename}`, req.ip, email),
      addNotification(organizationId, 'ETL Pipeline Başarılı', 'Temizlenmiş veri seti analiz kapsamına alındı; kaynak kopyalar çift sayımı önlemek için kapsam dışında bırakıldı.', email)
    ]);

    res.json({
      message: 'ETL tamamlandı. Temizlenmiş çıktı analiz kapsamına alındı; kaynaklar çift sayımı önlemek için kapsam dışında bırakıldı.',
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
    const notifications = await listNotifications(req.organization!.organization_id, req.user!.email);
    res.json(notifications);
  } catch (err) { next(err); }
});

router.post('/notifications/read', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await markNotificationsRead(req.organization!.organization_id, req.user!.email);
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
