import { NextFunction, Response, Router } from 'express';
import { AuthenticatedRequest, requireRoles } from '../index';
import {
  createKpiForOrganization,
  deleteKpiForOrganization,
  evaluateKpisForOrganization,
  getKpiColumnCatalog,
  getKpiHistoryForOrganization,
  getKpisForOrganization,
  KpiServiceError,
  updateKpiForOrganization,
  validateHistoryLimit,
  validateKpiId
} from '../kpis/service';

export const kpiRouter = Router();

function handleError(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof KpiServiceError) {
    return res.status(error.status).json({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof Error) {
    const structured = error as Error & { status?: number; code?: string };
    if (structured.status && structured.code && structured.status >= 400 && structured.status < 600) {
      return res.status(structured.status).json({
        error: { code: structured.code, message: structured.message || 'KPI işlemi tamamlanamadı.' }
      });
    }
  }
  return next(error);
}

kpiRouter.get('/columns', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await getKpiColumnCatalog(req.organization!.organization_id));
  } catch (error) {
    handleError(error, res, next);
  }
});

kpiRouter.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ items: await getKpisForOrganization(req.organization!.organization_id) });
  } catch (error) {
    handleError(error, res, next);
  }
});

kpiRouter.get('/:id/history', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const id = validateKpiId(req.params.id);
    const limit = validateHistoryLimit(req.query.limit);
    res.json({ items: await getKpiHistoryForOrganization(req.organization!.organization_id, id, limit) });
  } catch (error) {
    handleError(error, res, next);
  }
});

kpiRouter.post(
  '/',
  requireRoles('admin', 'analyst'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const item = await createKpiForOrganization(
        req.organization!.organization_id,
        req.user!.email,
        req.body,
        req.ip
      );
      res.status(201).json({ item });
    } catch (error) {
      handleError(error, res, next);
    }
  }
);

kpiRouter.patch(
  '/:id',
  requireRoles('admin', 'analyst'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = validateKpiId(req.params.id);
      const item = await updateKpiForOrganization(
        req.organization!.organization_id,
        req.user!.email,
        id,
        req.body,
        req.ip
      );
      res.json({ item });
    } catch (error) {
      handleError(error, res, next);
    }
  }
);

kpiRouter.delete(
  '/:id',
  requireRoles('admin', 'analyst'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = validateKpiId(req.params.id);
      await deleteKpiForOrganization(
        req.organization!.organization_id,
        req.user!.email,
        id,
        req.ip
      );
      res.json({ message: 'KPI tanımı ve değerlendirme geçmişi silindi.' });
    } catch (error) {
      handleError(error, res, next);
    }
  }
);

kpiRouter.post(
  '/evaluate',
  requireRoles('admin', 'analyst'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (req.body !== undefined && (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body))) {
        throw new KpiServiceError(400, 'INVALID_EVALUATION_REQUEST', 'Değerlendirme isteği geçerli bir nesne olmalıdır.');
      }
      const rawId = req.body?.id;
      const id = rawId === undefined ? undefined : validateKpiId(rawId);
      res.json(await evaluateKpisForOrganization(
        req.organization!.organization_id,
        req.user!.email,
        { id, ipAddress: req.ip }
      ));
    } catch (error) {
      handleError(error, res, next);
    }
  }
);

export default kpiRouter;
