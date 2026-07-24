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
import { getAnalysisRun } from '../../lib/analysisDb';

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
    if (!['dashboard', 'insights', 'prediction', 'quality', 'analysis'].includes(type)) {
      return res.status(400).json({ error: { code: 'INVALID_REPORT_TYPE', message: 'Geçersiz rapor tipi.' } });
    }
    if (type === 'analysis') {
      const analysisId = typeof req.query.analysisId === 'string' ? req.query.analysisId : '';
      if (!analysisId) {
        return res.status(400).json({ error: { code: 'ANALYSIS_ID_REQUIRED', message: 'Analiz raporu için analiz kimliği gereklidir.' } });
      }
      const run = await getAnalysisRun(req.organization!.organization_id, analysisId);
      if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Analiz kaydı bulunamadı.' } });
      const result = run.result as Record<string, any>;
      const forecast = result.forecast as Record<string, any> | null | undefined;
      const rows: Array<{ metric: string; value: string | number }> = [
        { metric: 'Analiz Kimliği', value: run.id },
        { metric: 'Veri Kapsamı', value: run.datasetFilename },
        { metric: 'Veri Seti Kimlikleri', value: run.datasetIds.join(', ') },
        { metric: 'Hedef Kolon', value: run.targetColumn || result.target_column || 'Otomatik' },
        { metric: 'Tahmin Ufku', value: run.periods },
        { metric: 'Model', value: forecast?.model || 'Tahmin modeli üretilemedi' },
        { metric: 'Seçilen Model', value: forecast?.metrics?.selected_model || 'Model karşılaştırması uygulanmadı' },
        { metric: 'Model Seçim Ölçütü', value: forecast?.metrics?.selection_metric || 'Yok' },
        { metric: 'Doğrulama Güveni', value: `${(Number(forecast?.confidence || 0) * 100).toFixed(1)}%` },
        { metric: 'Doğrulama Yöntemi', value: forecast?.metrics?.validation_method || 'Yok' },
        { metric: 'Eğitim Satırı', value: forecast?.metrics?.train_rows ?? 0 },
        { metric: 'Test Satırı', value: forecast?.metrics?.test_rows ?? 0 },
        { metric: 'MAE', value: forecast?.metrics?.mae ?? 'Hesaplanamadı' },
        { metric: 'RMSE', value: forecast?.metrics?.rmse ?? 'Hesaplanamadı' },
        { metric: 'R²', value: forecast?.metrics?.r2 ?? 'Hesaplanamadı' },
        { metric: 'SMAPE', value: forecast?.metrics?.smape ?? 'Hesaplanamadı' },
        { metric: 'Anomali Sayısı', value: result.anomalies?.metrics?.anomaly_count ?? 0 },
        { metric: 'Segment Sayısı', value: result.segments?.metrics?.segments ?? 0 }
      ];
      (Array.isArray(forecast?.metrics?.candidate_metrics) ? forecast.metrics.candidate_metrics : []).slice(0, 10).forEach((candidate: Record<string, unknown>) => {
        rows.push({
          metric: `Model Adayı #${String(candidate.rank ?? '')} ${String(candidate.label || candidate.model || '')}`,
          value: `MAE=${String(candidate.mae ?? '')}; RMSE=${String(candidate.rmse ?? '')}; SMAPE=${String(candidate.smape ?? '')}; seçildi=${candidate.selected === true ? 'evet' : 'hayır'}`
        });
      });
      (Array.isArray(result.warnings) ? result.warnings : []).slice(0, 20).forEach((warning: unknown, index: number) => {
        rows.push({ metric: `Veri/Model Uyarısı ${index + 1}`, value: String(warning) });
      });
      (Array.isArray(forecast?.data) ? forecast.data : []).slice(0, 24).forEach((point: Record<string, unknown>) => {
        rows.push({
          metric: `Tahmin ${String(point.date || point.row || '')}`,
          value: `değer=${String(point.predicted ?? '')}; alt=${String(point.lower ?? '')}; üst=${String(point.upper ?? '')}`
        });
      });
      if (run.interpretation) rows.push({ metric: 'AI Yorumu', value: run.interpretation });
      return sendFile(res, buildExportPayload(`Dogrulanmis Analiz Raporu - ${run.datasetFilename}`, rows));
    }
    const dataset = await getCombinedUserDataset(req.organization!.organization_id);
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
