import { Router, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../index';
import { getCombinedUserDataset } from '../datasets/combined';
import {
  buildAutomaticInsights,
  buildDataProfile,
  buildDatasetSummary,
  buildMlInsights,
  recommendWidgets
} from '../ml/pipeline';

const router = Router();

async function dynamicHandler(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const dataset = await getCombinedUserDataset(req.user!.email);
    if (!dataset) {
      return res.json({
        emptyState: 'Veri arttıkça burada içgörüler görünecek. Başlamak için CSV dosyası yükleyin.',
        profile: null,
        widgets: []
      });
    }

    const profile = buildDataProfile(dataset.file_content);
    const ml = buildMlInsights(dataset.file_content, dataset.filename);
    const summary = buildDatasetSummary(dataset.file_content, dataset.filename);
    const widgets = recommendWidgets(profile, ml, summary);

    res.json({
      datasetIds: dataset.datasetIds,
      datasetCount: dataset.dataset_count,
      datasetFilename: dataset.filename,
      emptyState: widgets.length === 0 ? 'Veri arttıkça burada içgörüler görünecek.' : null,
      profile,
      ml,
      widgets
    });
  } catch (err) {
    next(err);
  }
}

async function autoInsightsHandler(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const dataset = await getCombinedUserDataset(req.user!.email);
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

export default router;
