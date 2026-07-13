import { Router, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../index';
import { getCombinedUserDataset } from '../datasets/combined';
import {
  buildAutomaticInsights,
  buildDataProfile,
  buildDatasetSummary,
  buildExportPayload,
  buildMlForecast,
  buildMlInsights
} from '../ml/pipeline';

const router = Router();

function sendFile(res: Response, payload: ReturnType<typeof buildExportPayload>) {
  const buf = Buffer.from(payload.base64Content, 'base64');
  res.setHeader('Content-Type', payload.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${payload.fileName}"`);
  res.setHeader('Content-Length', buf.length.toString());
  res.send(buf);
}

router.get('/download', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const type = typeof req.query.type === 'string' ? req.query.type : 'dashboard';
    if (!['dashboard', 'insights', 'prediction', 'quality'].includes(type)) {
      return res.status(400).json({ error: { code: 'INVALID_REPORT_TYPE', message: 'Geçersiz rapor tipi.' } });
    }
    const dataset = await getCombinedUserDataset(req.user!.email);
    if (!dataset) {
      return res.status(404).json({
        error: { code: 'NO_DATASET', message: 'Rapor oluşturmak için önce veri yükleyin.' }
      });
    }

    if (type === 'insights') {
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

    if (type === 'dashboard') {
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

    if (type === 'prediction') {
      const forecast = buildMlForecast(dataset.file_content, dataset.filename);
      const rows: Array<{ metric: string; value: string | number }> = [
        { metric: 'Hedef Kolon', value: forecast.targetColumn || 'Sayısal hedef bulunamadı' },
        { metric: 'Model', value: forecast.model },
        { metric: 'Eğitim Satırı', value: forecast.trainRows },
        { metric: 'Test Satırı', value: forecast.testRows },
        { metric: 'Heuristik Uyum Skoru', value: `${forecast.accuracy.toFixed(1)}%` },
        { metric: 'Skor Türü', value: 'Eğitim verisi uyumu; holdout doğruluğu değildir' },
        { metric: 'MAE', value: forecast.metrics.mae },
        { metric: 'RMSE', value: forecast.metrics.rmse },
        { metric: 'R²', value: forecast.metrics.r2 },
        { metric: 'Anomali Sayısı', value: forecast.anomalies.length }
      ];
      forecast.forecast.slice(0, 24).forEach((point) => {
        rows.push({ metric: `Tahmin ${point.row}`, value: point.predicted });
      });
      return sendFile(res, buildExportPayload(`Tahmin ve Anomali Raporu - ${dataset.filename}`, rows));
    }

    const profile = buildDataProfile(dataset.file_content);
    const qualityRows: Array<{ metric: string; value: string | number }> = [
      { metric: 'Dosya Sayısı', value: dataset.dataset_count },
      { metric: 'Satır Sayısı', value: profile.rowCount },
      { metric: 'Kolon Sayısı', value: profile.columnCount },
      { metric: 'Veri Türü', value: profile.datasetType }
    ];
    profile.columns.forEach((column) => {
      qualityRows.push({
        metric: `${column.name} / kalite`,
        value: `tür=${column.type}; boş=%${column.nullRate}; benzersiz=${column.uniqueCount}`
      });
    });
    return sendFile(res, buildExportPayload(`Veri Kalite Raporu - ${dataset.filename}`, qualityRows));
  } catch (err) {
    next(err);
  }
});

router.post('/export', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { title, rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 10_000) {
      return res.status(400).json({ error: 'Rapor icin veri bulunamadi.' });
    }
    res.json(buildExportPayload(String(title || 'Rapor'), rows));
  } catch (err) {
    next(err);
  }
});

export default router;
