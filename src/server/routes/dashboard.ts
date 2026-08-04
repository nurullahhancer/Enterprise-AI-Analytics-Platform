import { Router, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../index';
import { getCombinedUserDataset } from '../datasets/combined';
import { getDashboardPreference, saveDashboardPreference } from '../../lib/dashboardPreferencesDb';
import {
  buildAutomaticInsights,
  buildDataProfile,
  buildDatasetSummary,
  buildMlInsights,
  detectDashboardTemplate,
  extractNlpComplaints,
  recommendWidgets
} from '../ml/pipeline';
import { BIEngine } from '../bi/engine';

const router = Router();

async function dynamicHandler(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const dataset = await getCombinedUserDataset(req.organization!.organization_id);
    if (!dataset) {
      return res.json({
        emptyState: 'Veri arttıkça burada içgörüler görünecek. Başlamak için CSV dosyası yükleyin.',
        profile: null,
        widgets: [],
        nlp: { hasComments: false, totalComments: 0, topComplaint: null, clusters: [] },
        biResult: BIEngine.evaluate({})
      });
    }

    const profile = buildDataProfile(dataset.file_content);
    const ml = buildMlInsights(dataset.file_content, dataset.filename);
    const summary = buildDatasetSummary(dataset.file_content, dataset.filename);
    const widgets = recommendWidgets(profile, ml, summary);
    const nlp = extractNlpComplaints(dataset.file_content);

    const biResult = BIEngine.evaluate({
      returnRatePct: summary.churnRate ? summary.churnRate / 100 : undefined,
      profitMarginPct: summary.grossMargin ? summary.grossMargin / 100 : undefined,
      nlpTopComplaint: nlp.topComplaint ? {
        topic: nlp.topComplaint.topic,
        count: nlp.topComplaint.count,
        percentage: nlp.topComplaint.percentage
      } : undefined
    });

    res.json({
      datasetIds: dataset.datasetIds,
      datasetCount: dataset.dataset_count,
      datasetFilename: dataset.filename,
      emptyState: widgets.length === 0 ? 'Veri arttıkça burada içgörüler görünecek.' : null,
      profile,
      template: detectDashboardTemplate(profile),
      ml,
      widgets,
      nlp,
      biResult,
      preference: await getDashboardPreference(req.organization!.organization_id, req.user!.email)
    });
  } catch (err) {
    next(err);
  }
}

async function autoInsightsHandler(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const dataset = await getCombinedUserDataset(req.organization!.organization_id);
    if (!dataset) {
      return res.json({
        generatedAt: new Date().toISOString(),
        datasetType: null,
        rowCount: 0,
        summary: 'Otomatik içgörü üretmek için veri yükleyin.',
        items: []
      });
    }

    const profile = buildDataProfile(dataset.file_content);
    const ml = buildMlInsights(dataset.file_content, dataset.filename);
    const summary = buildDatasetSummary(dataset.file_content, dataset.filename);
    res.json(buildAutomaticInsights(profile, ml, summary));
  } catch (err) {
    next(err);
  }
}

router.get('/dynamic', dynamicHandler);
router.get('/auto', autoInsightsHandler);
router.get('/preference', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try { res.json(await getDashboardPreference(req.organization!.organization_id, req.user!.email)); } catch (error) { next(error); }
});
router.put('/preference', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try { res.json(await saveDashboardPreference(req.organization!.organization_id, req.user!.email, req.body)); }
  catch (error) {
    if (error instanceof Error && /Dashboard/.test(error.message)) return res.status(400).json({ error: { code: 'INVALID_DASHBOARD_PREFERENCE', message: error.message } });
    next(error);
  }
});

export default router;
