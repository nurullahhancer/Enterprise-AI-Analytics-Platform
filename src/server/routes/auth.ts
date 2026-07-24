import crypto from 'node:crypto';
import { Router, Response, NextFunction } from 'express';
import { AuthenticatedRequest, authenticateJWT } from '../index';
import {
  addAuditLog,
  createUserWithOrganization,
  findUserByEmail,
  getActiveMembership,
  listMemberships,
  markEmailVerified,
  updateUser,
  revokeUserTokens,
  deleteUser,
  LastAdminError,
  replacePassword
} from '../../lib/db';
import {
  AuthConfigurationError,
  generateToken,
  hashPassword,
  isAuthConfigured,
  passwordHashNeedsUpgrade,
  verifyPassword
} from '../../lib/auth';
import logger from '../../lib/logger';
import { appLink, isEmailConfigured, sendTransactionalEmail } from '../../lib/email';
import { createOpaqueToken, hashOpaqueToken } from '../../lib/securityTokens';
import { acceptInvitation, consumeAuthActionToken, createAuthActionToken, getInvitationByHash } from '../../lib/saasDb';
import { clearSessionCookie, setSessionCookie, shouldReturnBearerToken } from '../../lib/session';

const router = Router();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type AttemptEntry = { count: number; resetAt: number };
const emailLoginAttempts = new Map<string, AttemptEntry>();
const ipLoginAttempts = new Map<string, AttemptEntry>();
const emailActionAttempts = new Map<string, AttemptEntry>();
const DUMMY_PASSWORD_HASH = hashPassword('not-a-real-user-password');
const LOGIN_WINDOW_MS = 15 * 60_000;
const EMAIL_LOGIN_LIMIT = 5;
const EMAIL_ACTION_LIMIT = 5;
const EMAIL_ACTION_WINDOW_MS = 60 * 60_000;
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

function recordAttempt(store: Map<string, AttemptEntry>, key: string, windowMs = LOGIN_WINDOW_MS): void {
  const now = Date.now();
  cleanupAttempts(store, now);
  const current = store.get(key);
  store.set(key, {
    count: (current?.count ?? 0) + 1,
    resetAt: current?.resetAt ?? now + windowMs
  });
}

function allowEmailAction(req: AuthenticatedRequest, purpose: string, email: string): boolean {
  const key = `${purpose}:${clientIp(req)}:${actorReference(email || 'invalid')}`;
  if (isRateLimited(emailActionAttempts, key, EMAIL_ACTION_LIMIT)) return false;
  recordAttempt(emailActionAttempts, key, EMAIL_ACTION_WINDOW_MS);
  return true;
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
    const { email, name, password, invitationToken, organizationName } = req.body;
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

    const invitation = typeof invitationToken === 'string' && invitationToken.length >= 30
      ? await getInvitationByHash(hashOpaqueToken(invitationToken))
      : null;
    if (!registrationEnabled() && (!invitation || invitation.email !== normalizedEmail)) {
      return res.status(403).json({ error: { code: 'REGISTRATION_DISABLED', message: 'Yeni kullanıcı kaydı yalnızca geçerli bir ekip davetiyle yapılabilir.' } });
    }
    if (invitationToken && (!invitation || invitation.email !== normalizedEmail || new Date(invitation.expires_at).getTime() <= Date.now())) {
      return res.status(400).json({ error: { code: 'INVALID_INVITATION', message: 'Davet geçersiz, süresi dolmuş veya farklı bir e-posta adresine ait.' } });
    }

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
    const requiresVerification = process.env.REQUIRE_EMAIL_VERIFICATION === 'true';
    if (requiresVerification && !isEmailConfigured()) {
      return res.status(503).json({ error: { code: 'EMAIL_NOT_CONFIGURED', message: 'E-posta doğrulama servisi henüz yapılandırılmadı.' } });
    }
    const role = wantsBootstrapAdmin ? 'admin' : 'analyst';
    const organizationId = await createUserWithOrganization(normalizedEmail, normalizedName, await hashPassword(password), {
      globalRole: role,
      organizationName: typeof organizationName === 'string' && organizationName.trim().length >= 2
        ? organizationName.trim().slice(0, 100)
        : undefined,
      emailVerified: !requiresVerification
    });
    let invitedOrganizationId: string | null = null;
    if (invitation) invitedOrganizationId = await acceptInvitation(invitation.token_hash, normalizedEmail);
    if (requiresVerification) {
      const verification = createOpaqueToken();
      await createAuthActionToken(normalizedEmail, 'verify_email', verification.hash, new Date(Date.now() + 24 * 60 * 60_000));
      await sendTransactionalEmail({
        to: normalizedEmail,
        subject: 'ReAi e-posta doğrulama',
        text: `E-posta adresinizi 24 saat içinde doğrulayın: ${appLink('/', { verifyEmail: verification.token })}`,
        idempotencyKey: `verify-registration-${normalizedEmail}-${Date.now()}`
      });
    }
    logger.info('Kullanıcı kaydı oluşturuldu.', { actor: actorReference(normalizedEmail), role });
    res.status(201).json({
      message: requiresVerification ? 'Hesap oluşturuldu. E-posta adresinize gönderilen bağlantıyı doğrulayın.' : 'Kullanıcı ve çalışma alanı oluşturuldu. Giriş yapabilirsiniz.',
      organizationId: invitedOrganizationId || organizationId,
      verificationRequired: requiresVerification
    });
  } catch (err) { next(err); }
});

router.get('/invitation/preview', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const token = String(req.query.token || '');
    if (token.length < 30 || token.length > 100) return res.status(400).json({ error: { code: 'INVALID_INVITATION', message: 'Davet kodu geçersiz.' } });
    const invitation = await getInvitationByHash(hashOpaqueToken(token));
    if (!invitation || new Date(invitation.expires_at).getTime() <= Date.now()) {
      return res.status(404).json({ error: { code: 'INVALID_INVITATION', message: 'Davet bulunamadı veya süresi doldu.' } });
    }
    res.json({ invitation: { email: invitation.email, role: invitation.role, organizationName: invitation.organization_name, expiresAt: invitation.expires_at } });
  } catch (error) { next(error); }
});

router.post('/verify-email', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const token = String(req.body?.token || '');
    if (token.length < 30 || token.length > 100) return res.status(400).json({ error: { code: 'INVALID_TOKEN', message: 'Doğrulama kodu geçersiz.' } });
    const email = await consumeAuthActionToken(hashOpaqueToken(token), 'verify_email');
    if (!email) return res.status(400).json({ error: { code: 'INVALID_TOKEN', message: 'Doğrulama bağlantısı geçersiz veya süresi dolmuş.' } });
    await markEmailVerified(email);
    res.json({ success: true, message: 'E-posta adresi doğrulandı. Giriş yapabilirsiniz.' });
  } catch (error) { next(error); }
});

router.post('/verification/resend', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!isEmailConfigured()) {
      return res.status(503).json({ error: { code: 'EMAIL_NOT_CONFIGURED', message: 'E-posta servisi henüz yapılandırılmadı.' } });
    }
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!allowEmailAction(req, 'verify', email)) {
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Çok fazla istek gönderildi. Daha sonra tekrar deneyin.' } });
    }
    const user = EMAIL_PATTERN.test(email) ? await findUserByEmail(email) : null;
    if (user && !user.email_verified_at) {
      const verification = createOpaqueToken();
      await createAuthActionToken(email, 'verify_email', verification.hash, new Date(Date.now() + 24 * 60 * 60_000));
      await sendTransactionalEmail({
        to: email,
        subject: 'ReAi e-posta doğrulama',
        text: `E-posta adresinizi 24 saat içinde doğrulayın: ${appLink('/', { verifyEmail: verification.token })}`,
        idempotencyKey: `verify-resend-${email}-${Date.now()}`
      });
    }
    res.json({ message: 'Hesap uygunsa doğrulama e-postası gönderildi.' });
  } catch (error) { next(error); }
});

router.post('/forgot-password', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!isEmailConfigured()) {
      return res.status(503).json({ error: { code: 'EMAIL_NOT_CONFIGURED', message: 'E-posta servisi henüz yapılandırılmadı.' } });
    }
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!allowEmailAction(req, 'password-reset', email)) {
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Çok fazla istek gönderildi. Daha sonra tekrar deneyin.' } });
    }
    const user = EMAIL_PATTERN.test(email) ? await findUserByEmail(email) : null;
    if (user) {
      const reset = createOpaqueToken();
      await createAuthActionToken(email, 'reset_password', reset.hash, new Date(Date.now() + 60 * 60_000));
      await sendTransactionalEmail({
        to: email,
        subject: 'ReAi şifre yenileme',
        text: `Şifrenizi 60 dakika içinde yenileyin: ${appLink('/', { resetPassword: reset.token })}`,
        idempotencyKey: `password-reset-${email}-${Date.now()}`
      });
    }
    res.json({ message: 'Hesap uygunsa şifre yenileme e-postası gönderildi.' });
  } catch (error) { next(error); }
});

router.post('/reset-password', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const token = String(req.body?.token || '');
    const password = req.body?.password;
    if (token.length < 30 || token.length > 100) return res.status(400).json({ error: { code: 'INVALID_TOKEN', message: 'Şifre yenileme kodu geçersiz.' } });
    if (!validPassword(password)) return res.status(400).json({ error: { code: 'WEAK_PASSWORD', message: 'Şifre en az 12 karakter olmalı ve harf ile rakam içermelidir.' } });
    const email = await consumeAuthActionToken(hashOpaqueToken(token), 'reset_password');
    if (!email) return res.status(400).json({ error: { code: 'INVALID_TOKEN', message: 'Şifre yenileme bağlantısı geçersiz veya süresi dolmuş.' } });
    await replacePassword(email, await hashPassword(password));
    clearSessionCookie(res);
    res.json({ success: true, message: 'Şifreniz yenilendi. Yeni şifrenizle giriş yapabilirsiniz.' });
  } catch (error) { next(error); }
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

    if (process.env.REQUIRE_EMAIL_VERIFICATION === 'true' && !user.email_verified_at) {
      releaseAttempt(ipLoginAttempts, ipKey);
      ipReservation = null;
      return res.status(403).json({ error: { code: 'EMAIL_NOT_VERIFIED', message: 'Giriş yapmadan önce e-posta adresinizi doğrulayın.' } });
    }

    emailLoginAttempts.delete(attemptKey);
    releaseAttempt(ipLoginAttempts, ipKey);
    ipReservation = null;
    if (passwordHashNeedsUpgrade(user.password_hash)) {
      await updateUser(user.email, user.name, await hashPassword(password));
      user = (await findUserByEmail(user.email))!;
    }

    const token = generateToken(user.email, user.token_version);
    const requestedOrganizationId = String(req.headers['x-organization-id'] || '').trim() || undefined;
    const membership = await getActiveMembership(user.email, requestedOrganizationId);
    if (!membership) return res.status(403).json({ error: { code: 'ORGANIZATION_ACCESS_DENIED', message: 'Etkin bir çalışma alanı üyeliği bulunamadı.' } });
    setSessionCookie(res, token);
    await addAuditLog(membership.organization_id, 'User Login', 'Kullanıcı sisteme giriş yaptı.', req.ip, user.email)
      .catch(() => logger.warn('Giriş audit kaydı yazılamadı.'));
    logger.info('Kullanıcı girişi başarılı.', { actor: actorReference(user.email) });
    res.json({
      ...(shouldReturnBearerToken(req) ? { token } : {}),
      user: { id: user.email, name: user.name, email: user.email, role: membership.role, tenantId: membership.organization_id },
      organization: membership
    });
  } catch (err) {
    if (ipReservation) releaseAttempt(ipLoginAttempts, ipReservation);
    next(err);
  }
});

router.get('/me', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    res.json({
      user: { id: user.email, email: user.email, name: user.name, role: user.role, tenantId: req.organization!.organization_id },
      organization: req.organization,
      organizations: await listMemberships(user.email)
    });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const email = req.user!.email;
    await revokeUserTokens(email);
    await addAuditLog(req.organization!.organization_id, 'User Logout', 'Kullanıcı oturumunu sonlandırdı.', req.ip, email)
      .catch(() => logger.warn('Çıkış audit kaydı yazılamadı.'));
    clearSessionCookie(res);
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
    if (token) setSessionCookie(res, token);
    logger.info('Kullanıcı profili güncellendi.', { actor: actorReference(email), passwordChanged: Boolean(passwordHash) });
    res.json({
      message: 'Profil başarıyla güncellendi.',
      user: { email, name: normalizedName, id: email, role: req.user!.role, tenantId: req.organization!.organization_id },
      ...(token && shouldReturnBearerToken(req) ? { token } : {})
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
    clearSessionCookie(res);
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
