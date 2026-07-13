import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import logger from './src/lib/logger';
import { authenticateJWT } from './src/server/index';
import { checkDatabase, closeDatabase, databaseReady } from './src/lib/db';
import { isAuthConfigured } from './src/lib/auth';

// Route modules
import authRouter from './src/server/routes/auth';
import { datasetRouter } from './src/server/routes/dataset';
import dashboardRouter from './src/server/routes/dashboard';
import mlRouter from './src/server/routes/ml';
import reportsRouter from './src/server/routes/reports';
import chatRouter from './src/server/routes/chat';
import enterpriseRouter from './src/server/routes/enterprise';

async function startServer() {
  await databaseReady;
  const app = express();
  const PORT = Number(process.env.PORT || 3010);
  const production = process.env.NODE_ENV === 'production';
  const allowedOrigins = new Set(
    [process.env.APP_URL, ...(process.env.ALLOWED_ORIGINS || '').split(',')]
      .map((value) => value?.trim().replace(/\/+$/, ''))
      .filter((value): value is string => Boolean(value))
  );
  if (!production) {
    ['http://localhost:5173', 'http://127.0.0.1:5173', 'capacitor://localhost'].forEach((origin) => allowedOrigins.add(origin));
  }

  app.disable('x-powered-by');
  const trustProxy = Number(process.env.TRUST_PROXY_HOPS || 0);
  if (Number.isInteger(trustProxy) && trustProxy > 0) app.set('trust proxy', trustProxy);

  // ── Middleware ─────────────────────────────────────────────────────────────
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"
    );
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    const origin = req.headers.origin?.replace(/\/+$/, '');
    if (origin) {
      if (!allowedOrigins.has(origin)) {
        return res.status(403).json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Bu origin için erişim izni yok.' } });
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, X-Bootstrap-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/reports')) {
      res.setHeader('Cache-Control', 'no-store, private');
      res.setHeader('Pragma', 'no-cache');
    }
    next();
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    logger.info('HTTP request', { method: req.method, path: req.path });
    next();
  });

  // ── Public routes ──────────────────────────────────────────────────────────
  app.get('/api/health', async (_req, res) => {
    const [database, mlService] = await Promise.all([
      checkDatabase(),
      process.env.NODE_ENV === 'test' ? Promise.resolve(true) : (async () => {
        try {
          const baseUrl = (process.env.ML_SERVICE_URL || 'http://ml-service:8000').replace(/\/+$/, '');
          const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
          return response.ok;
        } catch {
          return false;
        }
      })()
    ]);
    const auth = isAuthConfigured();
    res.status(database && mlService && auth ? 200 : 503).json({
      status: database && mlService && auth ? 'ok' : 'degraded',
      checks: {
        database: database ? 'ok' : 'error',
        mlService: mlService ? 'ok' : 'error',
        authentication: auth ? 'ok' : 'configuration-required',
        ai: process.env.GEMINI_API_KEY ? 'configured' : 'optional-key-missing'
      }
    });
  });
  app.get('/api/config', (_req, res) => res.json({
    registrationEnabled: process.env.NODE_ENV === 'test' || process.env.ALLOW_PUBLIC_REGISTRATION === 'true',
    aiEnabled: Boolean(process.env.GEMINI_API_KEY)
  }));
  app.use('/api', authRouter);                          // /api/register, /api/login

  // ── Protected routes ───────────────────────────────────────────────────────
  app.use('/api',           authenticateJWT, datasetRouter);   // /api/upload, /api/dataset/*
  app.use('/api/dashboard', authenticateJWT, dashboardRouter); // /api/dashboard/dynamic
  app.use('/api/insights',  authenticateJWT, dashboardRouter); // /api/insights/auto
  app.use('/api/ml',        authenticateJWT, mlRouter);        // /api/ml/forecast, /api/ml/insights, /api/ml/analyze
  app.use('/reports',       authenticateJWT, reportsRouter);   // /reports/export, /reports/download
  app.use('/api/chat',      authenticateJWT, chatRouter);
  app.use('/api/enterprise', authenticateJWT, enterpriseRouter);

  app.use(['/api', '/reports'], (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint bulunamadı.' } });
  });

  // ── Frontend ───────────────────────────────────────────────────────────────
  if (!production) {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  // ── Error handler ──────────────────────────────────────────────────────────
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    logger.error('Sunucu hatası.', { error: err, path: req.path, code: err.code });
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    let message = 'Sunucu tarafında beklenmeyen bir hata oluştu.';
    if (err.status === 429 || err.message?.includes('Quota exceeded') || err.message?.includes('429'))
      message = 'Gemini API kotanız doldu. Lütfen 1 dakika bekleyip tekrar deneyin.';
    else if (err.message?.includes('API key not valid'))
      message = 'Geçersiz Gemini API anahtarı.';
    res.status(status).json({ error: { code: err.code || 'INTERNAL_SERVER_ERROR', message } });
  });

  if (process.env.NODE_ENV !== 'test') {
    const httpServer = app.listen(PORT, '0.0.0.0', () => logger.info('HTTP sunucusu hazır.', { port: PORT, environment: process.env.NODE_ENV || 'development' }));
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('Sunucu kontrollü olarak kapatılıyor.', { signal });
      const forcedExit = setTimeout(() => process.exit(1), 15_000);
      forcedExit.unref();
      httpServer.close(() => {
        closeDatabase()
          .then(() => process.exit(0))
          .catch((error) => {
            logger.error('Veritabanı kapatılırken hata oluştu.', { error });
            process.exit(1);
          });
      });
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  }

  return app;
}

export const serverAppPromise = startServer();
