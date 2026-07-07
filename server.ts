import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import logger from './src/lib/logger';
import { authenticateJWT } from './src/server/index';

// Route modules
import authRouter from './src/server/routes/auth';
import { datasetRouter } from './src/server/routes/dataset';
import dashboardRouter from './src/server/routes/dashboard';
import mlRouter from './src/server/routes/ml';
import reportsRouter from './src/server/routes/reports';
import chatRouter from './src/server/routes/chat';
import enterpriseRouter from './src/server/routes/enterprise';

if (!process.env.GEMINI_API_KEY) {
  logger.error('GEMINI_API_KEY eksik — sunucu başlatılamadı.');
  process.exit(1);
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3010);

  // ── Middleware ─────────────────────────────────────────────────────────────
  app.use(express.json({ limit: '10mb' }));

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, ngrok-skip-browser-warning');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    logger.info(`${req.method} ${req.url}`);
    next();
  });

  // ── Public routes ──────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api', authRouter);                          // /api/register, /api/login

  // ── Protected routes ───────────────────────────────────────────────────────
  app.use('/api',           authenticateJWT, datasetRouter);   // /api/upload, /api/dataset/*
  app.use('/api/dashboard', authenticateJWT, dashboardRouter); // /api/dashboard/dynamic
  app.use('/api/insights',  authenticateJWT, dashboardRouter); // /api/insights/auto
  app.use('/api/ml',        authenticateJWT, mlRouter);        // /api/ml/forecast, /api/ml/insights, /api/ml/analyze
  app.use('/reports',       authenticateJWT, reportsRouter);   // /reports/export, /reports/export/download
  app.use('/api/chat',      authenticateJWT, chatRouter);
  app.use('/api/enterprise', authenticateJWT, enterpriseRouter);

  // ── Frontend ───────────────────────────────────────────────────────────────
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  // ── Error handler ──────────────────────────────────────────────────────────
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    logger.error('Sunucu hatası:', { message: err.message, path: req.path });
    const status = err.status || 500;
    let message = 'Sunucu tarafında beklenmeyen bir hata oluştu.';
    if (err.status === 429 || err.message?.includes('Quota exceeded') || err.message?.includes('429'))
      message = 'Gemini API kotanız doldu. Lütfen 1 dakika bekleyip tekrar deneyin.';
    else if (err.message?.includes('API key not valid'))
      message = 'Geçersiz Gemini API anahtarı.';
    res.status(status).json({ error: { code: err.code || 'INTERNAL_SERVER_ERROR', message } });
  });

  if (process.env.NODE_ENV !== 'test') {
    app.listen(PORT, '0.0.0.0', () => logger.info(`Server: http://localhost:${PORT}`));
  }

  return app;
}

export const serverAppPromise = startServer();
