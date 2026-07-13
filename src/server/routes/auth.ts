import crypto from 'node:crypto';
import { Router, Response, NextFunction } from 'express';
import { AuthenticatedRequest, authenticateJWT } from '../index';
import { addAuditLog, createUser, findUserByEmail, updateUser, revokeUserTokens, deleteUser, LastAdminError } from '../../lib/db';
import {
  AuthConfigurationError,
  generateToken,
  hashPassword,
  isAuthConfigured,
  passwordHashNeedsUpgrade,
  verifyPassword
} from '../../lib/auth';
import logger from '../../lib/logger';

const router = Router();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type AttemptEntry = { count: number; resetAt: number };
const emailLoginAttempts = new Map<string, AttemptEntry>();
const ipLoginAttempts = new Map<string, AttemptEntry>();
const DUMMY_PASSWORD_HASH = hashPassword('not-a-real-user-password');
const LOGIN_WINDOW_MS = 15 * 60_000;
const EMAIL_LOGIN_LIMIT = 5;
const MAX_ATTEMPT_KEYS = 10_000;

function actorReference(email: string): string {
  return crypto.createHash('sha256').update(email).digest('hex').slice(0, 12);
}

function registrationEnabled(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.ALLOW_PUBLIC_REGISTRATION === 'true';
}

function validPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 12 && password.length <= 128 &&
    /[A-Za-zÇĞİÖŞÜçğıöşü]/.test(password) && /\d/.test(password);
}

function clientIp(req: AuthenticatedRequest): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function configuredIpLoginLimit(): number {
  const value = Number(process.env.LOGIN_IP_MAX_ATTEMPTS || 30);
  return Number.isInteger(value) ? Math.max(5, Math.min(value, 300)) : 30;
}

function cleanupAttempts(store: Map<string, AttemptEntry>, now: number): void {
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
  while (store.size >= MAX_ATTEMPT_KEYS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

function isRateLimited(store: Map<string, AttemptEntry>, key: string, limit: number): boolean {
  const entry = store.get(key);
  if (!entry) return false;
  if (Date.now() >= entry.resetAt) {
    store.delete(key);
    return false;
  }
  return entry.count >= limit;
}

function recordAttempt(store: Map<string, AttemptEntry>, key: string): void {
  const now = Date.now();
  cleanupAttempts(store, now);
  const current = store.get(key);
  store.set(key, {
    count: (current?.count ?? 0) + 1,
    resetAt: current?.resetAt ?? now + LOGIN_WINDOW_MS
  });
}

function releaseAttempt(store: Map<string, AttemptEntry>, key: string): void {
  const current = store.get(key);
  if (!current) return;
  if (current.count <= 1) store.delete(key);
  else store.set(key, { ...current, count: current.count - 1 });
}

function constantTimeSecretMatch(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

router.post('/register', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { email, name, password } = req.body;
    if (!registrationEnabled()) {
      return res.status(403).json({ error: { code: 'REGISTRATION_DISABLED', message: 'Yeni kullanıcı kaydı yönetici tarafından kapatılmıştır.' } });
    }
    if (!email || !name || !password)
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'İsim, e-posta ve şifre zorunludur.' } });

    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedName = String(name).trim();
    if (!EMAIL_PATTERN.test(normalizedEmail) || normalizedEmail.length > 254)
      return res.status(400).json({ error: { code: 'INVALID_EMAIL', message: 'Geçerli bir e-posta adresi girin.' } });
    if (normalizedName.length < 2 || normalizedName.length > 100)
      return res.status(400).json({ error: { code: 'INVALID_NAME', message: 'İsim 2-100 karakter arasında olmalıdır.' } });
    if (!validPassword(password))
      return res.status(400).json({ error: { code: 'WEAK_PASSWORD', message: 'Şifre en az 12 karakter olmalı ve harf ile rakam içermelidir.' } });

    if (await findUserByEmail(normalizedEmail))
      return res.status(409).json({ error: { code: 'USER_EXISTS', message: 'Bu e-posta ile kayıtlı kullanıcı var.' } });

    const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
    const wantsBootstrapAdmin = Boolean(bootstrapEmail && normalizedEmail === bootstrapEmail);
    if (wantsBootstrapAdmin) {
      const expectedToken = process.env.BOOTSTRAP_ADMIN_TOKEN?.trim() || '';
      const presentedToken = String(req.headers['x-bootstrap-token'] || '');
      if (expectedToken.length < 32) {
        return res.status(503).json({ error: { code: 'BOOTSTRAP_NOT_CONFIGURED', message: 'İlk yönetici kaydı için bootstrap token yapılandırılmalıdır.' } });
      }
      if (!constantTimeSecretMatch(presentedToken, expectedToken)) {
        return res.status(403).json({ error: { code: 'INVALID_BOOTSTRAP_TOKEN', message: 'İlk yönetici kaydı yetkilendirilemedi.' } });
      }
    }
    const role = wantsBootstrapAdmin ? 'admin' : 'analyst';
    await createUser(normalizedEmail, normalizedName, await hashPassword(password), role);
    logger.info('Kullanıcı kaydı oluşturuldu.', { actor: actorReference(normalizedEmail), role });
    res.status(201).json({ message: 'Kullanıcı oluşturuldu. Giriş yapabilirsiniz.' });
  } catch (err) { next(err); }
});

router.post('/login', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  let ipReservation: string | null = null;
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'E-posta ve şifre zorunludur.' } });

    if (!isAuthConfigured()) {
      return res.status(503).json({ error: { code: 'AUTH_NOT_CONFIGURED', message: 'Kimlik doğrulama servisi henüz yapılandırılmadı.' } });
    }

    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!EMAIL_PATTERN.test(normalizedEmail) || normalizedEmail.length > 254 || typeof password !== 'string' || password.length < 1 || password.length > 128) {
      return res.status(400).json({ error: { code: 'INVALID_CREDENTIAL_FORMAT', message: 'E-posta veya şifre biçimi geçersiz.' } });
    }

    const ipKey = clientIp(req);
    const attemptKey = `${ipKey}:${normalizedEmail}`;
    cleanupAttempts(ipLoginAttempts, Date.now());
    cleanupAttempts(emailLoginAttempts, Date.now());
    if (isRateLimited(ipLoginAttempts, ipKey, configuredIpLoginLimit()) ||
        isRateLimited(emailLoginAttempts, attemptKey, EMAIL_LOGIN_LIMIT)) {
      res.setHeader('Retry-After', '900');
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Çok fazla hatalı deneme yapıldı. Lütfen daha sonra tekrar deneyin.' } });
    }
    recordAttempt(ipLoginAttempts, ipKey);
    ipReservation = ipKey;

    let user = await findUserByEmail(normalizedEmail);
    const passwordIsValid = await verifyPassword(password, user?.password_hash ?? await DUMMY_PASSWORD_HASH);
    if (!user || !passwordIsValid) {
      recordAttempt(emailLoginAttempts, attemptKey);
      ipReservation = null; // Failed attempts intentionally retain the IP reservation.
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'E-posta veya şifre hatalı.' } });
    }

    emailLoginAttempts.delete(attemptKey);
    releaseAttempt(ipLoginAttempts, ipKey);
    ipReservation = null;
    if (passwordHashNeedsUpgrade(user.password_hash)) {
      await updateUser(user.email, user.name, await hashPassword(password));
      user = (await findUserByEmail(user.email))!;
    }

    const token = generateToken(user.email, user.token_version);
    await addAuditLog(user.email, 'User Login', 'Kullanıcı sisteme giriş yaptı.', req.ip)
      .catch(() => logger.warn('Giriş audit kaydı yazılamadı.'));
    logger.info('Kullanıcı girişi başarılı.', { actor: actorReference(user.email) });
    res.json({ token, user: { id: user.email, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    if (ipReservation) releaseAttempt(ipLoginAttempts, ipReservation);
    next(err);
  }
});

router.get('/me', authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  const user = req.user!;
  res.json({ user: { id: user.email, email: user.email, name: user.name, role: user.role } });
});

router.post('/logout', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const email = req.user!.email;
    await revokeUserTokens(email);
    await addAuditLog(email, 'User Logout', 'Kullanıcı oturumunu sonlandırdı.', req.ip)
      .catch(() => logger.warn('Çıkış audit kaydı yazılamadı.'));
    logger.info('Kullanıcı çıkışı başarılı.', { actor: actorReference(email) });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.put('/user', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const email = req.user?.email;
    if (!email) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Kimlik doğrulaması başarısız.' } });

    const { name, password, currentPassword } = req.body;
    if (!name) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'İsim alanı zorunludur.' } });
    const normalizedName = String(name).trim();
    if (normalizedName.length < 2 || normalizedName.length > 100)
      return res.status(400).json({ error: { code: 'INVALID_NAME', message: 'İsim 2-100 karakter arasında olmalıdır.' } });

    let passwordHash: string | undefined;
    if (password && password.trim().length > 0) {
      if (!validPassword(password))
        return res.status(400).json({ error: { code: 'WEAK_PASSWORD', message: 'Şifre en az 12 karakter olmalı ve harf ile rakam içermelidir.' } });
      const currentUser = await findUserByEmail(email);
      if (!currentUser || !await verifyPassword(String(currentPassword || ''), currentUser.password_hash))
        return res.status(403).json({ error: { code: 'INVALID_CURRENT_PASSWORD', message: 'Mevcut şifre hatalı.' } });
      passwordHash = await hashPassword(password);
    }

    await updateUser(email, normalizedName, passwordHash);
    const updated = (await findUserByEmail(email))!;
    const token = passwordHash ? generateToken(updated.email, updated.token_version) : undefined;
    logger.info('Kullanıcı profili güncellendi.', { actor: actorReference(email), passwordChanged: Boolean(passwordHash) });
    res.json({
      message: 'Profil başarıyla güncellendi.',
      user: { email, name: normalizedName, id: email, role: updated.role },
      ...(token ? { token } : {})
    });
  } catch (err) { next(err); }
});

router.delete('/user', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const email = req.user?.email;
    if (!email) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Kimlik doğrulaması başarısız.' } });

    const { currentPassword } = req.body ?? {};
    const currentUser = await findUserByEmail(email);
    if (!currentUser || !await verifyPassword(String(currentPassword || ''), currentUser.password_hash))
      return res.status(403).json({ error: { code: 'INVALID_CURRENT_PASSWORD', message: 'Hesabı silmek için mevcut şifrenizi doğrulayın.' } });

    await deleteUser(email);
    logger.info('Kullanıcı hesabı silindi.', { actor: actorReference(email) });
    res.json({ message: 'Hesap başarıyla silindi.' });
  } catch (err) {
    if (err instanceof LastAdminError) {
      return res.status(409).json({ error: { code: 'LAST_ADMIN', message: err.message } });
    }
    if (err instanceof AuthConfigurationError) {
      return res.status(503).json({ error: { code: 'AUTH_NOT_CONFIGURED', message: err.message } });
    }
    next(err);
  }
});

export default router;
