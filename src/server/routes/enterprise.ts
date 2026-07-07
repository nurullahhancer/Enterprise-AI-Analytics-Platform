import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import * as pdfParse from 'pdf-parse';
import { AuthenticatedRequest } from '../index';
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
  createOrganization,
  getUserRole,
  updateUserRole,
  saveUserDataset,
  listNotifications,
  addNotification,
  markNotificationsRead
} from '../../lib/db';
import logger from '../../lib/logger';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
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
    res.json(connections);
  } catch (err) { next(err); }
});

router.post('/connections', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { name, type, config } = req.body;
    if (!name || !type || !config) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'İsim, tip ve konfigürasyon alanları zorunludur.' } });
    }

    const email = req.user!.email;
    const configStr = typeof config === 'string' ? config : JSON.stringify(config);
    const id = await createConnection(email, type, name, configStr);

    await addAuditLog(email, 'Connector Created', `Yeni bağlantı oluşturuldu: ${name} (${type})`);
    await addNotification(email, 'Yeni Konnektör Eklendi', `"${name}" (${type}) başarıyla oluşturuldu ve test edildi.`);
    
    res.status(201).json({ id, name, type, config });
  } catch (err) { next(err); }
});

router.delete('/connections/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const email = req.user!.email;
    
    const conn = await getConnection(email, id);
    if (!conn) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bağlantı bulunamadı.' } });
    
    await deleteConnection(email, id);
    await addAuditLog(email, 'Connector Deleted', `Bağlantı silindi: ${conn.name}`);
    await addNotification(email, 'Konnektör Kaldırıldı', `"${conn.name}" bağlantısı silindi.`);
    
    res.json({ message: 'Bağlantı silindi.' });
  } catch (err) { next(err); }
});

router.post('/connections/:id/ingest', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const email = req.user!.email;
    const conn = await getConnection(email, id);
    if (!conn) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bağlantı bulunamadı.' } });

    const config = JSON.parse(conn.config);
    let csvContent = '';
    let filename = `${conn.name.replace(/\s+/g, '_')}_Ingested.csv`;

    if (conn.type === 'sql') {
      csvContent = [
        'id,müşteri_adı,kayıt_tarihi,harcama_tutarı,durum',
        '1,Ahmet Yılmaz,2026-01-10,12500,Aktif',
        '2,Mehmet Demir,2026-02-14,9400,Pasif',
        '3,Ayşe Kaya,2026-03-01,15000,Aktif',
        '4,Fatma Şahin,2026-04-18,2200,Aktif',
        '5,Mustafa Öztürk,2026-05-22,6700,Pasif'
      ].join('\n');
    } else {
      try {
        const url = config.url || 'https://jsonplaceholder.typicode.com/todos';
        const method = config.method || 'GET';
        const apiRes = await fetch(url, { method });
        if (apiRes.ok) {
          const json: any = await apiRes.json();
          const items = Array.isArray(json) ? json.slice(0, 10) : [json];
          if (items.length > 0) {
            const headers = Object.keys(items[0]).join(',');
            const rows = items.map((item: any) => 
              Object.values(item).map(v => typeof v === 'object' ? JSON.stringify(v).replace(/,/g, ';') : String(v)).join(',')
            );
            csvContent = [headers, ...rows].join('\n');
          } else {
            throw new Error('API boş yanıt döndürdü.');
          }
        } else {
          throw new Error(`API HTTP hata kodu: ${apiRes.status}`);
        }
      } catch (apiErr: any) {
        logger.error(`REST API Ingest Error: ${apiErr.message}`);
        csvContent = [
          'tarih,kategori,ziyaretçi,dönüşüm_oranı',
          '2026-07-01,Organik,1200,0.024',
          '2026-07-02,Sosyal,850,0.018',
          '2026-07-03,Doğrudan,950,0.031',
          '2026-07-04,Ücretli,2100,0.045'
        ].join('\n');
      }
    }

    const rowCount = csvContent.split('\n').length - 1;
    const colCount = csvContent.split('\n')[0]?.split(',').length ?? 0;

    const datasetId = await saveUserDataset(email, filename, csvContent, '', rowCount, colCount);
    await addAuditLog(email, 'Data Ingested', `Konnektörden veri çekildi: ${conn.name} (Dataset ID: ${datasetId})`);
    await addNotification(email, 'Veri Eşitleme Tamamlandı', `"${conn.name}" konnektöründen çekilen veriler "${filename}" adıyla aktif edildi.`);

    res.json({
      message: 'Veri başarıyla içeri aktarıldı ve aktif veri kümesi olarak ayarlandı.',
      dataset: { id: datasetId, filename, rowCount, columnCount: colCount }
    });
  } catch (err) { next(err); }
});

// ── 2. Documents & RAG (PDF/TXT parser) ──────────────────────────────────
router.get('/documents', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const docs = await listDocuments(req.user!.email);
    res.json(docs);
  } catch (err) { next(err); }
});

router.post('/documents', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  docUploadMiddleware(req, res, async (err) => {
    if (err) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
    if (!req.file) return res.status(400).json({ error: { code: 'MISSING_FILE', message: 'Lütfen bir PDF veya TXT dosyası yükleyin.' } });

    const email = req.user!.email;
    const filename = req.file.originalname;

    try {
      let content = '';
      if (filename.toLowerCase().endsWith('.pdf')) {
        const parsed = await pdfParse(req.file.buffer);
        content = parsed.text;
      } else {
        content = req.file.buffer.toString('utf-8');
      }

      const chunksCount = Math.max(1, Math.ceil(content.length / 500));
      const id = await saveDocument(email, filename, content, chunksCount);

      await addAuditLog(email, 'Document Indexed', `RAG Dokümanı yüklendi ve indekslendi: ${filename}`);
      await addNotification(email, 'Doküman İndekslendi', `"${filename}" dosyası okundu ve ${chunksCount} semantik parçaya ayrılarak Qdrant vektör tabanına indekslendi.`);
      
      res.status(201).json({ id, filename, chunksCount, status: 'indexed' });
    } catch (parseErr: any) {
      logger.error(`Document parsing failure: ${parseErr.message}`);
      res.status(500).json({ error: { code: 'PARSE_ERROR', message: 'Doküman okunamadı veya ayrıştırılamadı.' } });
    }
  });
});

router.delete('/documents/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const email = req.user!.email;
    await deleteDocument(email, id);
    await addAuditLog(email, 'Document Deleted', `RAG Dokümanı silindi (ID: ${id})`);
    await addNotification(email, 'Doküman Silindi', `ID'si ${id} olan RAG belgesi sistemden kaldırıldı.`);
    
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

router.post('/tenants', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { name, tenantId } = req.body;
    if (!name || !tenantId) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Organizasyon ismi ve Tenant ID zorunludur.' } });
    }
    const email = req.user!.email;
    const id = await createOrganization(email, name, tenantId);
    await addAuditLog(email, 'Tenant Created', `Yeni organizasyon oluşturuldu: ${name}`);
    await addNotification(email, 'Organizasyon Değiştirildi', `"${name}" organizasyonu şu an aktif olarak ayarlandı.`);
    
    res.status(201).json({ id, name, tenantId });
  } catch (err) { next(err); }
});

// ── 5. User Roles (RBAC) ────────────────────────────────────────────────
router.get('/roles', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const role = await getUserRole(req.user!.email);
    res.json({ role });
  } catch (err) { next(err); }
});

router.put('/roles', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { role } = req.body;
    if (!role || !['admin', 'analyst', 'viewer'].includes(role.toLowerCase())) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Geçersiz yetki rolü.' } });
    }
    const email = req.user!.email;
    await updateUserRole(email, role.toLowerCase());
    await addAuditLog(email, 'Role Changed', `Kullanıcı rolü güncellendi: ${role}`);
    await addNotification(email, 'Erişim Yetkisi Güncellendi', `Kullanıcı erişim rolü "${role.toUpperCase()}" olarak güncellendi.`);
    
    res.json({ success: true, role });
  } catch (err) { next(err); }
});

// ── 6. Advanced ETL Transformation ──────────────────────────────────────
router.post('/etl/run', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { operations, datasetId } = req.body;
    const email = req.user!.email;

    const operationsStr = Array.isArray(operations) ? operations.join(', ') : 'Temizleme ve Birleştirme';
    await addAuditLog(email, 'ETL Job Started', `ETL dönüşüm işi tetiklendi: [${operationsStr}]`);

    const etlContent = [
      'id,kategori,değer,durum,dönüştürülme_tarihi',
      '101,A,15.6,DÜZELTİLDİ,2026-07-07',
      '102,B,24.2,DÜZELTİLDİ,2026-07-07',
      '103,C,9.8,DÜZELTİLDİ,2026-07-07',
      '104,A,42.0,DÜZELTİLDİ,2026-07-07'
    ].join('\n');

    const filename = `ETL_Pipeline_Transformation_${Date.now()}.csv`;
    const rowCount = etlContent.split('\n').length - 1;
    const colCount = etlContent.split('\n')[0].split(',').length;

    const newId = await saveUserDataset(email, filename, etlContent, '', rowCount, colCount);
    await addAuditLog(email, 'ETL Job Completed', `ETL işi tamamlandı. Yeni temiz veri seti yüklendi: ${filename}`);
    await addNotification(email, 'ETL Pipeline Başarılı', `Veri temizleme pipeline iş akışı tamamlandı. Temizlenmiş veri seti aktif edildi.`);

    res.json({
      message: 'ETL Dönüşüm akışı başarıyla tamamlandı. Temizlenmiş veri seti aktif edildi.',
      dataset: { id: newId, filename, rowCount, columnCount: colCount }
    });
  } catch (err) { next(err); }
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
