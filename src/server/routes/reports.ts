import { Router, Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../index';
import { getCombinedUserDataset } from '../datasets/combined';
import { buildAutomaticInsights, buildDataProfile, buildDatasetSummary, buildExportPayload, buildMlInsights } from '../ml/pipeline';

const router = Router();

function sendFile(res: Response, payload: ReturnType<typeof buildExportPayload>) {
  const buf = Buffer.from(payload.base64Content, 'base64');
  res.setHeader('Content-Type', payload.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${payload.fileName}"`);
  res.setHeader('Content-Length', buf.length.toString());
  res.send(buf);
}

router.get('/download', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { verifyToken } = await import('../../lib/auth');
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const decoded = token ? verifyToken(token) : null;
    if (!decoded) return res.status(401).json({ error: 'Rapor indirmek icin giris yapin.' });

    const type = typeof req.query.type === 'string' ? req.query.type : 'dashboard';
    const dataset = await getCombinedUserDataset(decoded.email);

    if (type === 'insights' && dataset) {
      const profile = buildDataProfile(dataset.file_content);
      const ml = buildMlInsights(dataset.file_content, dataset.filename);
      const summary = buildDatasetSummary(dataset.file_content, dataset.filename);
      const insights = buildAutomaticInsights(profile, ml, summary);
      return sendFile(
        res,
        buildExportPayload(
          'Otomatik Icgöru Raporu',
          insights.items.map((item) => ({ metric: `${item.title} (${item.severity})`, value: item.description }))
        )
      );
    }

    if (type === 'dashboard' && dataset) {
      const summary = buildDatasetSummary(dataset.file_content, dataset.filename);
      return sendFile(res, buildExportPayload(`Dashboard Raporu - ${dataset.filename}`, [
        { metric: 'Dosya Sayisi', value: dataset.dataset_count },
        { metric: 'Dosyalar', value: dataset.filenames.join(', ') },
        { metric: 'Toplam Deger', value: summary.totalRevenue },
        { metric: 'Toplam Maliyet', value: summary.totalCost },
        { metric: 'Risk / Kayip Orani', value: `${summary.churnRate.toFixed(1)}%` },
        { metric: 'Brut Kar Orani', value: `${summary.grossMargin.toFixed(1)}%` },
        { metric: 'Satir Sayisi', value: summary.rowCount },
        { metric: 'Kolon Sayisi', value: summary.columnCount }
      ]));
    }

    sendFile(res, buildExportPayload('Dashboard Raporu', [{ metric: 'Durum', value: 'Henuz veri yuklenmedi.' }]));
  } catch (err) {
    next(err);
  }
});

router.post('/export', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { title, rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Rapor icin veri bulunamadi.' });
    }
    res.json(buildExportPayload(String(title || 'Rapor'), rows));
  } catch (err) {
    next(err);
  }
});

export default router;
