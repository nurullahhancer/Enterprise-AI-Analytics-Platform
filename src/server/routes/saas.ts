import crypto from 'node:crypto';
import { Router, Response, NextFunction } from 'express';
import { authenticateJWT, AuthenticatedRequest, requireRoles } from '../index';
import { addAuditLog, LastAdminError, listMemberships } from '../../lib/db';
import {
  acceptInvitation,
  changeMemberRole,
  allocateAiCredits,
  completeAiCreditPurchase,
  completeBillingCheckout,
  createAiCreditPurchase,
  createBillingCheckout,
  createInvitation,
  createOrganizationForUser,
  deactivateSubscription,
  getBillingCheckout,
  getBillingCheckoutByProviderToken,
  getAiCreditPurchase,
  getAiCreditPurchaseByToken,
  getAiUsageSettings,
  getInvitationByHash,
  getOrganization,
  getSubscription,
  getSubscriptionByProviderReference,
  getUsage,
  failAiCreditPurchase,
  listOrganizationMembers,
  listPendingInvitations,
  PlanQuotaError,
  publicPlans,
  recordBillingEvent,
  releaseBillingEvent,
  removeMember,
  revokeInvitation,
  updateOrganization,
  updateAiUsageSettings,
  upsertSubscription
} from '../../lib/saasDb';
import { appLink, isEmailConfigured, sendTransactionalEmail } from '../../lib/email';
import { createOpaqueToken, hashOpaqueToken } from '../../lib/securityTokens';
import { getAiCreditPackages, getBillingProvider, getIyzicoBillingConfiguration, resolveIyzicoPlanReferenceCode } from '../../lib/billing';
import { isPlanKey, PlanKey } from '../../lib/plans';
import logger from '../../lib/logger';
import { deliverBusinessAlert } from '../../lib/notificationChannels';

const router = Router();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLE_VALUES = new Set(['admin', 'analyst', 'viewer']);

function applicationUrl(pathname = '/'): string {
  return new URL(pathname, `${(process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '')}/`).toString();
}

function organizationMatchesRequest(req: AuthenticatedRequest): boolean {
  const supplied = String(req.body?.organizationId || req.query.organizationId || '').trim();
  return !supplied || supplied === req.organization?.organization_id;
}

function providerPlan(referenceCode: string): PlanKey | null {
  for (const plan of ['professional', 'enterprise'] as PlanKey[]) {
    try {
      if (resolveIyzicoPlanReferenceCode(plan) === referenceCode) return plan;
    } catch {
      // A non-configured plan cannot match a provider event.
    }
  }
  return null;
}

function plansForClient() {
  const billing = getIyzicoBillingConfiguration();
  return publicPlans().map((plan) => ({
    ...plan,
    checkoutAvailable: plan.key !== 'starter' && billing.configured && billing.configuredPlans.includes(plan.key)
  }));
}

function checkoutHtml(content: string): string {
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ReAi Güvenli Ödeme</title>
  <style>body{margin:0;background:#0e0e0e;color:#f4f4f5;font-family:Arial,sans-serif}.shell{max-width:760px;margin:0 auto;padding:32px 16px}.brand{font-size:18px;font-weight:800;margin-bottom:20px}.note{font-size:13px;color:#a1a1aa;margin-bottom:18px}</style>
</head>
<body><main class="shell"><div class="brand">ReAi</div><p class="note">Ödeme alanı iyzico tarafından güvenli biçimde sunulur.</p><div id="iyzipay-checkout-form" class="responsive"></div>${content}</main></body>
</html>`;
}

router.get('/billing/checkout-page/:id', async (req, res, next) => {
  try {
    const checkoutId = String(req.params.id || '');
    if (!/^checkout_[A-Za-z0-9_-]{20,80}$/.test(checkoutId)) return res.sendStatus(404);
    const checkout = await getBillingCheckout(checkoutId);
    if (!checkout || new Date(checkout.expires_at).getTime() <= Date.now()) return res.status(410).send('Ödeme oturumunun süresi doldu.');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src data: https://*.iyzipay.com https://*.iyzico.com; style-src 'unsafe-inline' https://*.iyzipay.com https://*.iyzico.com; script-src 'unsafe-inline' https://*.iyzipay.com https://*.iyzico.com; connect-src https://*.iyzipay.com https://*.iyzico.com; frame-src https://*.iyzipay.com https://*.iyzico.com; form-action https://*.iyzipay.com https://*.iyzico.com"
    );
    res.type('html').send(checkoutHtml(checkout.checkout_form_content));
  } catch (error) {
    next(error);
  }
});

router.get('/billing/ai-credit-page/:id', async (req, res, next) => {
  try {
    const purchaseId = String(req.params.id || '');
    if (!/^credit_[A-Za-z0-9_-]{20,80}$/.test(purchaseId)) return res.sendStatus(404);
    const purchase = await getAiCreditPurchase(purchaseId);
    if (!purchase || new Date(purchase.expires_at).getTime() <= Date.now()) return res.status(410).send('Ödeme oturumunun süresi doldu.');
    res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src data: https://*.iyzipay.com https://*.iyzico.com; style-src 'unsafe-inline' https://*.iyzipay.com https://*.iyzico.com; script-src 'unsafe-inline' https://*.iyzipay.com https://*.iyzico.com; connect-src https://*.iyzipay.com https://*.iyzico.com; frame-src https://*.iyzipay.com https://*.iyzico.com; form-action https://*.iyzipay.com https://*.iyzico.com");
    res.type('html').send(checkoutHtml(purchase.checkout_form_content));
  } catch (error) { next(error); }
});

router.all('/billing/callback', async (req, res) => {
  const failureUrl = applicationUrl('/?billing=failed');
  try {
    const token = String(req.body?.token || req.query.token || '').trim();
    if (!token) return res.redirect(303, failureUrl);
    const checkout = await getBillingCheckoutByProviderToken(token);
    if (!checkout || new Date(checkout.expires_at).getTime() <= Date.now()) return res.redirect(303, failureUrl);

    const result = await getBillingProvider().retrieveHostedSubscriptionResult({ token });
    if (result.conversationId && result.conversationId !== checkout.conversation_id) throw new Error('BILLING_CONVERSATION_MISMATCH');
    const planKey = providerPlan(result.pricingPlanReferenceCode);
    if (!planKey || planKey !== checkout.plan_key) throw new Error('BILLING_PLAN_MISMATCH');
    const active = result.subscriptionStatus === 'ACTIVE';
    await upsertSubscription({
      organizationId: checkout.organization_id,
      provider: 'iyzico',
      planKey,
      status: result.subscriptionStatus.toLowerCase(),
      customerReference: result.customerReferenceCode,
      subscriptionReference: result.referenceCode,
      currentPeriodStart: result.startDate ? new Date(result.startDate).toISOString() : null,
      currentPeriodEnd: result.endDate ? new Date(result.endDate).toISOString() : null
    });
    await completeBillingCheckout(checkout.id);
    await addAuditLog(checkout.organization_id, 'Subscription Checkout Verified', `${planKey} abonelik sonucu sağlayıcıdan doğrulandı.`, 'billing-callback', checkout.requested_by);
    void deliverBusinessAlert(checkout.organization_id, 'billing', 'Abonelik sonucu doğrulandı', `${planKey} planı için ödeme sonucu ${result.subscriptionStatus} olarak doğrulandı.`)
      .catch((error) => logger.warn('Abonelik bildirimi gönderilemedi.', { error, organizationId: checkout.organization_id }));
    return res.redirect(303, applicationUrl(active ? '/?billing=success' : '/?billing=pending'));
  } catch (error) {
    logger.error('Ödeme dönüşü doğrulanamadı.', { error });
    return res.redirect(303, failureUrl);
  }
});

router.all('/billing/ai-credit-callback', async (req, res) => {
  const failureUrl = applicationUrl('/?aiCredits=failed');
  try {
    const token = String(req.body?.token || req.query.token || '').trim();
    if (!token) return res.redirect(303, failureUrl);
    const purchase = await getAiCreditPurchaseByToken(token);
    if (!purchase || purchase.status !== 'initialized' || new Date(purchase.expires_at).getTime() <= Date.now()) return res.redirect(303, failureUrl);
    const result = await getBillingProvider().retrieveAiCreditCheckoutResult({ token, conversationId: purchase.conversation_id });
    const expectedBasketId = `AI-${purchase.organization_id}-${purchase.quantity}`;
    if (result.conversationId !== purchase.conversation_id || result.basketId !== expectedBasketId || result.priceMinor !== Number(purchase.amount_minor) || result.paidPriceMinor < Number(purchase.amount_minor)) {
      throw new Error('AI_CREDIT_PAYMENT_MISMATCH');
    }
    const completed = await completeAiCreditPurchase(purchase.id, result.paymentId);
    if (completed) {
      await addAuditLog(purchase.organization_id, 'AI Credits Purchased', `${Number(purchase.quantity).toLocaleString('tr-TR')} ek yapay zekâ hakkı ödeme sağlayıcısından doğrulanarak bakiyeye eklendi.`, 'billing-callback', purchase.requested_by);
      void deliverBusinessAlert(purchase.organization_id, 'billing', 'Ek yapay zekâ hakkı alındı', `${Number(purchase.quantity).toLocaleString('tr-TR')} ek hak ön ödemeli bakiyenize eklendi.`)
        .catch((error) => logger.warn('Ek hak bildirimi gönderilemedi.', { error, organizationId: purchase.organization_id }));
    }
    return res.redirect(303, applicationUrl('/?aiCredits=success'));
  } catch (error) {
    const token = String(req.body?.token || req.query.token || '').trim();
    const purchase = token ? await getAiCreditPurchaseByToken(token).catch(() => null) : null;
    if (purchase?.id) await failAiCreditPurchase(purchase.id).catch(() => undefined);
    logger.error('Ek hak ödemesi doğrulanamadı.', { error });
    return res.redirect(303, failureUrl);
  }
});

router.post('/billing/webhook', async (req, res, next) => {
  let claimedEventId: string | null = null;
  try {
    const provider = getBillingProvider();
    const verified = provider.verifySubscriptionWebhook(req.body, req.headers['x-iyz-signature-v3']);
    const existing = await getSubscriptionByProviderReference(verified.event.subscriptionReferenceCode);
    const fresh = await recordBillingEvent(
      verified.eventId,
      existing?.organization_id || null,
      verified.event.iyziEventType,
      verified.event
    );
    if (!fresh) return res.status(204).end();
    claimedEventId = verified.eventId;
    if (!existing) {
      logger.warn('Webhook bilinmeyen abonelik referansı için alındı.', { eventId: verified.eventId });
      await releaseBillingEvent(verified.eventId);
      claimedEventId = null;
      return res.status(503).json({ error: { code: 'SUBSCRIPTION_NOT_READY', message: 'Abonelik kaydı henüz hazır değil.' } });
    }
    if (verified.event.iyziEventType === 'subscription.order.failure') {
      await deactivateSubscription(existing.organization_id, 'unpaid');
      void deliverBusinessAlert(existing.organization_id, 'billing', 'Abonelik tahsilatı başarısız', 'iyzico yenileme tahsilatını başarısız bildirdi; çalışma alanı Starter plana geçirildi.')
        .catch((error) => logger.warn('Tahsilat hatası bildirimi gönderilemedi.', { error, organizationId: existing.organization_id }));
      return res.status(204).end();
    }
    const detail = await provider.getSubscriptionDetails(verified.event.subscriptionReferenceCode);
    const planKey = detail.pricingPlanReferenceCode ? providerPlan(detail.pricingPlanReferenceCode) : null;
    if (!planKey) throw new Error('BILLING_PLAN_MISMATCH');
    await upsertSubscription({
      organizationId: existing.organization_id,
      provider: 'iyzico',
      planKey,
      status: detail.subscriptionStatus.toLowerCase(),
      customerReference: detail.customerReferenceCode,
      subscriptionReference: detail.referenceCode,
      currentPeriodStart: detail.startDate ? new Date(detail.startDate).toISOString() : null,
      currentPeriodEnd: detail.endDate ? new Date(detail.endDate).toISOString() : null
    });
    void deliverBusinessAlert(existing.organization_id, 'billing', 'Abonelik yenilendi', `${planKey} aboneliği ${detail.subscriptionStatus} durumuyla güncellendi.`)
      .catch((error) => logger.warn('Abonelik yenileme bildirimi gönderilemedi.', { error, organizationId: existing.organization_id }));
    res.status(204).end();
  } catch (error) {
    if (claimedEventId) await releaseBillingEvent(claimedEventId).catch(() => undefined);
    next(error);
  }
});

router.use(authenticateJWT);

router.get('/organizations', async (req: AuthenticatedRequest, res, next) => {
  try {
    res.json({ organizations: await listMemberships(req.user!.email), activeOrganizationId: req.organization!.organization_id });
  } catch (error) { next(error); }
});

router.get('/context', async (req: AuthenticatedRequest, res, next) => {
  try {
    res.json({
      organizations: await listMemberships(req.user!.email),
      activeOrganizationId: req.organization!.organization_id,
      plans: plansForClient(),
      billing: getIyzicoBillingConfiguration()
    });
  } catch (error) { next(error); }
});

router.post('/organizations', async (req: AuthenticatedRequest, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (name.length < 2 || name.length > 100) return res.status(400).json({ error: { code: 'INVALID_NAME', message: 'Organizasyon adı 2-100 karakter arasında olmalıdır.' } });
    const organization = await createOrganizationForUser(req.user!.email, name);
    await addAuditLog(organization.id, 'Organization Created', 'Yeni çalışma alanı oluşturuldu.', req.ip, req.user!.email);
    res.status(201).json({ organization: { ...organization, role: 'admin' } });
  } catch (error) { next(error); }
});

router.put('/organizations', requireRoles('admin'), async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!organizationMatchesRequest(req)) return res.status(409).json({ error: { code: 'ORGANIZATION_CONTEXT_MISMATCH', message: 'Önce işlem yapılacak çalışma alanına geçin.' } });
    const name = String(req.body?.name || '').trim();
    if (name.length < 2 || name.length > 100) return res.status(400).json({ error: { code: 'INVALID_NAME', message: 'Organizasyon adı 2-100 karakter arasında olmalıdır.' } });
    await updateOrganization(req.organization!.organization_id, name);
    res.json({ success: true, name });
  } catch (error) { next(error); }
});

router.get('/organization', async (req: AuthenticatedRequest, res, next) => {
  try {
    const organization = await getOrganization(req.organization!.organization_id);
    res.json({ organization: { ...organization, role: req.user!.role } });
  } catch (error) { next(error); }
});

router.put('/organization', requireRoles('admin'), async (req: AuthenticatedRequest, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (name.length < 2 || name.length > 100) return res.status(400).json({ error: { code: 'INVALID_NAME', message: 'Organizasyon adı 2-100 karakter arasında olmalıdır.' } });
    await updateOrganization(req.organization!.organization_id, name);
    await addAuditLog(req.organization!.organization_id, 'Organization Updated', 'Organizasyon adı güncellendi.', req.ip, req.user!.email);
    res.json({ success: true, name });
  } catch (error) { next(error); }
});

router.get('/members', async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!organizationMatchesRequest(req)) return res.status(409).json({ error: { code: 'ORGANIZATION_CONTEXT_MISMATCH', message: 'Çalışma alanı bağlamı eşleşmiyor.' } });
    const [members, invitations] = await Promise.all([
      listOrganizationMembers(req.organization!.organization_id),
      req.user!.role === 'admin' ? listPendingInvitations(req.organization!.organization_id) : Promise.resolve([])
    ]);
    res.json({ members, invitations });
  } catch (error) { next(error); }
});

router.get('/invitations', async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!organizationMatchesRequest(req)) return res.status(409).json({ error: { code: 'ORGANIZATION_CONTEXT_MISMATCH', message: 'Çalışma alanı bağlamı eşleşmiyor.' } });
    res.json({ invitations: req.user!.role === 'admin' ? await listPendingInvitations(req.organization!.organization_id) : [] });
  } catch (error) { next(error); }
});

router.post('/invitations', requireRoles('admin'), async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!organizationMatchesRequest(req)) return res.status(409).json({ error: { code: 'ORGANIZATION_CONTEXT_MISMATCH', message: 'Önce işlem yapılacak çalışma alanına geçin.' } });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = String(req.body?.role || '').trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email) || !ROLE_VALUES.has(role)) return res.status(400).json({ error: { code: 'INVALID_INVITATION', message: 'Davet e-postası veya rolü geçersiz.' } });
    const opaque = createOpaqueToken();
    const invitation = await createInvitation(
      req.organization!.organization_id,
      email,
      role as 'admin' | 'analyst' | 'viewer',
      req.user!.email,
      opaque.hash,
      new Date(Date.now() + 72 * 60 * 60_000)
    );
    const link = appLink('/', { invite: opaque.token });
    const emailConfigured = isEmailConfigured();
    try {
      if (!emailConfigured) throw Object.assign(new Error('EMAIL_NOT_CONFIGURED'), { code: 'EMAIL_NOT_CONFIGURED' });
      await sendTransactionalEmail({
        to: email,
        subject: `${req.organization!.organization_name} çalışma alanına davet`,
        text: `${req.user!.name} sizi ReAi üzerindeki ${req.organization!.organization_name} çalışma alanına davet etti. Davet 72 saat geçerlidir: ${link}`,
        idempotencyKey: `invitation-${invitation.id}`
      });
    } catch (error: any) {
      if (emailConfigured) {
        await revokeInvitation(req.organization!.organization_id, invitation.id).catch(() => undefined);
        throw error;
      }
    }
    await addAuditLog(req.organization!.organization_id, 'Member Invited', `${email} adresine ${role} rolüyle davet gönderildi.`, req.ip, req.user!.email);
    res.status(201).json({
      invitation: { id: invitation.id, email, role, expiresAt: invitation.expires_at },
      delivery: emailConfigured ? 'email' : 'link',
      inviteUrl: emailConfigured ? undefined : link,
      message: emailConfigured
        ? 'Davet e-postası gönderildi.'
        : 'E-posta servisi bağlı olmadığı için güvenli davet bağlantısı oluşturuldu. Bağlantıyı davet ettiğiniz kişiyle paylaşın.'
    });
  } catch (error) {
    if (error instanceof PlanQuotaError) return res.status(409).json({ error: { code: error.code, message: error.message } });
    next(error);
  }
});

router.post('/invitations/accept', async (req: AuthenticatedRequest, res, next) => {
  try {
    const token = String(req.body?.token || '');
    if (token.length < 30 || token.length > 100) return res.status(400).json({ error: { code: 'INVALID_INVITATION', message: 'Davet kodu geçersiz.' } });
    const invitation = await getInvitationByHash(hashOpaqueToken(token));
    if (!invitation || invitation.email !== req.user!.email) return res.status(403).json({ error: { code: 'INVALID_INVITATION', message: 'Bu davet hesabınızla eşleşmiyor.' } });
    const organizationId = await acceptInvitation(invitation.token_hash, req.user!.email);
    res.json({ success: true, organizationId });
  } catch (error) { next(error); }
});

router.delete('/invitations/:id', requireRoles('admin'), async (req: AuthenticatedRequest, res, next) => {
  try {
    const revoked = await revokeInvitation(req.organization!.organization_id, String(req.params.id));
    if (!revoked) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Aktif davet bulunamadı.' } });
    res.status(204).end();
  } catch (error) { next(error); }
});

router.put('/members/:email', requireRoles('admin'), async (req: AuthenticatedRequest, res, next) => {
  try {
    const email = decodeURIComponent(String(req.params.email)).trim().toLowerCase();
    const role = String(req.body?.role || '').trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email) || !ROLE_VALUES.has(role)) return res.status(400).json({ error: { code: 'INVALID_MEMBER', message: 'Üye veya rol bilgisi geçersiz.' } });
    const result = await changeMemberRole(req.organization!.organization_id, email, role as 'admin' | 'analyst' | 'viewer');
    if (result === 'not_found') return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Üye bulunamadı.' } });
    await addAuditLog(req.organization!.organization_id, 'Member Role Changed', `${email} rolü ${role} olarak güncellendi.`, req.ip, req.user!.email);
    res.json({ success: true, email, role });
  } catch (error) {
    if (error instanceof LastAdminError) return res.status(409).json({ error: { code: 'LAST_ADMIN', message: error.message } });
    next(error);
  }
});

router.put('/members', requireRoles('admin'), async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!organizationMatchesRequest(req)) return res.status(409).json({ error: { code: 'ORGANIZATION_CONTEXT_MISMATCH', message: 'Önce işlem yapılacak çalışma alanına geçin.' } });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = String(req.body?.role || '').trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email) || !ROLE_VALUES.has(role)) return res.status(400).json({ error: { code: 'INVALID_MEMBER', message: 'Üye veya rol bilgisi geçersiz.' } });
    const result = await changeMemberRole(req.organization!.organization_id, email, role as 'admin' | 'analyst' | 'viewer');
    if (result === 'not_found') return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Üye bulunamadı.' } });
    res.json({ success: true, email, role });
  } catch (error) {
    if (error instanceof LastAdminError) return res.status(409).json({ error: { code: 'LAST_ADMIN', message: error.message } });
    next(error);
  }
});

router.delete('/members/:email', requireRoles('admin'), async (req: AuthenticatedRequest, res, next) => {
  try {
    const email = decodeURIComponent(String(req.params.email)).trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) return res.status(400).json({ error: { code: 'INVALID_MEMBER', message: 'Üye e-postası geçersiz.' } });
    const removed = await removeMember(req.organization!.organization_id, email);
    if (!removed) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Üye bulunamadı.' } });
    await addAuditLog(req.organization!.organization_id, 'Member Removed', `${email} organizasyondan kaldırıldı.`, req.ip, req.user!.email);
    res.status(204).end();
  } catch (error) {
    if (error instanceof LastAdminError) return res.status(409).json({ error: { code: 'LAST_ADMIN', message: error.message } });
    next(error);
  }
});

router.delete('/members', requireRoles('admin'), async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!organizationMatchesRequest(req)) return res.status(409).json({ error: { code: 'ORGANIZATION_CONTEXT_MISMATCH', message: 'Önce işlem yapılacak çalışma alanına geçin.' } });
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) return res.status(400).json({ error: { code: 'INVALID_MEMBER', message: 'Üye e-postası geçersiz.' } });
    const removed = await removeMember(req.organization!.organization_id, email);
    if (!removed) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Üye bulunamadı.' } });
    res.status(204).end();
  } catch (error) {
    if (error instanceof LastAdminError) return res.status(409).json({ error: { code: 'LAST_ADMIN', message: error.message } });
    next(error);
  }
});

router.get('/usage', async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!organizationMatchesRequest(req)) return res.status(409).json({ error: { code: 'ORGANIZATION_CONTEXT_MISMATCH', message: 'Çalışma alanı bağlamı eşleşmiyor.' } });
    const [usage, subscription] = await Promise.all([
      getUsage(req.organization!.organization_id, req.user!.email),
      getSubscription(req.organization!.organization_id)
    ]);
    const metricValues = { ...usage.resources, ...usage.counters };
    const limits = usage.plan.limits;
    const limitByMetric: Record<string, number> = {
      members: limits.members,
      datasets: limits.datasets,
      connectors: limits.connectors,
      documents: limits.documents,
      ai_requests: usage.ai.effectiveLimit,
      ml_runs: limits.mlRuns
    };
    res.json({
      ...usage,
      planKey: usage.plan.key,
      subscriptionStatus: subscription?.status || (usage.plan.key === 'starter' ? 'included' : 'inactive'),
      limits,
      meters: Object.entries(metricValues).map(([key, used]) => ({
        key,
        used,
        limit: limitByMetric[key],
        remaining: Math.max((limitByMetric[key] || 0) - used, 0)
      }))
    });
  } catch (error) { next(error); }
});

router.get('/ai-settings', async (req: AuthenticatedRequest, res, next) => {
  try {
    const [settings, usage] = await Promise.all([
      getAiUsageSettings(req.organization!.organization_id),
      getUsage(req.organization!.organization_id, req.user!.email)
    ]);
    res.json({ settings, ai: usage.ai, period: usage.period });
  } catch (error) { next(error); }
});

router.put('/ai-settings', requireRoles('admin'), async (req: AuthenticatedRequest, res, next) => {
  try {
    const rawLimit = req.body?.perUserMonthlyLimit;
    const perUserMonthlyLimit = rawLimit === null || rawLimit === '' || rawLimit === undefined ? null : Number(rawLimit);
    const autoCreditBundle = Number(req.body?.autoCreditBundle) === 5000 ? 5000 : 1000;
    const settings = await updateAiUsageSettings(req.organization!.organization_id, {
      perUserMonthlyLimit,
      autoUsePrepaidCredits: req.body?.autoUsePrepaidCredits === true,
      autoCreditBundle
    }, req.user!.email);
    await addAuditLog(req.organization!.organization_id, 'AI Usage Settings Updated', 'Yapay zekâ kullanım sınırları güncellendi.', req.ip, req.user!.email);
    res.json({ settings });
  } catch (error) { next(error); }
});

router.post('/ai-credits/allocate', requireRoles('admin'), async (req: AuthenticatedRequest, res, next) => {
  try {
    const quantity = Number(req.body?.quantity);
    if (quantity !== 1000 && quantity !== 5000) return res.status(400).json({ error: { code: 'INVALID_AI_CREDIT_PACKAGE', message: 'Ek hak miktarı 1.000 veya 5.000 olmalıdır.' } });
    const bonusCredits = await allocateAiCredits(req.organization!.organization_id, quantity, req.user!.email);
    await addAuditLog(req.organization!.organization_id, 'AI Credits Allocated', `${quantity.toLocaleString('tr-TR')} ön ödemeli hak bu aya aktarıldı.`, req.ip, req.user!.email);
    res.json({ success: true, bonusCredits });
  } catch (error: any) {
    if (error?.code === 'INSUFFICIENT_AI_CREDITS') return res.status(409).json({ error: { code: error.code, message: error.message } });
    next(error);
  }
});

router.post('/ai-credits/checkout', requireRoles('admin'), async (req: AuthenticatedRequest, res, next) => {
  try {
    const quantity = Number(req.body?.quantity);
    if (quantity !== 1000 && quantity !== 5000) return res.status(400).json({ error: { code: 'INVALID_AI_CREDIT_PACKAGE', message: 'Ek hak paketi geçersiz.' } });
    const selected = getAiCreditPackages().find((item) => item.quantity === quantity);
    if (!selected?.amountMinor) return res.status(503).json({ error: { code: 'AI_CREDIT_PRICE_NOT_CONFIGURED', message: 'Bu ek hak paketinin satış fiyatı henüz tanımlanmamış.' } });
    const fullName = String(req.user!.name || '').trim().split(/\s+/);
    const customer = {
      name: String(req.body?.customer?.name || fullName[0] || '').trim(),
      surname: String(req.body?.customer?.surname || fullName.slice(1).join(' ') || '-').trim(),
      email: req.user!.email,
      gsmNumber: String(req.body?.customer?.gsmNumber || '').trim(),
      identityNumber: String(req.body?.customer?.identityNumber || '').trim(),
      billingAddress: req.body?.customer?.billingAddress
    };
    const conversationId = `credit_${crypto.randomBytes(18).toString('base64url')}`;
    const checkout = await getBillingProvider().initializeAiCreditCheckout({
      quantity, amountMinor: selected.amountMinor,
      callbackUrl: applicationUrl('/api/saas/billing/ai-credit-callback'),
      conversationId, organizationId: req.organization!.organization_id,
      buyerIp: req.ip || '127.0.0.1', customer
    });
    const purchaseId = await createAiCreditPurchase({
      organizationId: req.organization!.organization_id, requestedBy: req.user!.email,
      quantity, amountMinor: selected.amountMinor, providerToken: checkout.token,
      conversationId, checkoutFormContent: checkout.checkoutFormContent,
      expiresAt: new Date(Date.now() + checkout.tokenExpireTime * 1000)
    });
    res.status(201).json({ checkoutUrl: applicationUrl(`/api/saas/billing/ai-credit-page/${purchaseId}`), expiresIn: checkout.tokenExpireTime });
  } catch (error) { next(error); }
});

router.get('/plans', (_req, res) => res.json({ plans: plansForClient(), billing: getIyzicoBillingConfiguration() }));

router.get('/billing', async (req: AuthenticatedRequest, res, next) => {
  try {
    res.json({ subscription: await getSubscription(req.organization!.organization_id), configuration: getIyzicoBillingConfiguration() });
  } catch (error) { next(error); }
});

router.post('/billing/checkout', requireRoles('admin'), async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!organizationMatchesRequest(req)) return res.status(409).json({ error: { code: 'ORGANIZATION_CONTEXT_MISMATCH', message: 'Önce işlem yapılacak çalışma alanına geçin.' } });
    const planKey = req.body?.planKey;
    if (!isPlanKey(planKey) || planKey === 'starter') return res.status(400).json({ error: { code: 'INVALID_PLAN', message: 'Ücretli plan seçimi geçersiz.' } });
    const fullName = String(req.user!.name || '').trim().split(/\s+/);
    const conversationId = `conv_${crypto.randomBytes(18).toString('base64url')}`;
    const customer = {
      name: String(req.body?.customer?.name || fullName[0] || '').trim(),
      surname: String(req.body?.customer?.surname || fullName.slice(1).join(' ') || '-').trim(),
      email: req.user!.email,
      gsmNumber: String(req.body?.customer?.gsmNumber || '').trim(),
      identityNumber: String(req.body?.customer?.identityNumber || '').trim(),
      billingAddress: req.body?.customer?.billingAddress,
      shippingAddress: req.body?.customer?.shippingAddress
    };
    const checkout = await getBillingProvider().initializeHostedSubscription({
      planCode: planKey,
      callbackUrl: applicationUrl('/api/saas/billing/callback'),
      conversationId,
      customer
    });
    const checkoutId = await createBillingCheckout({
      organizationId: req.organization!.organization_id,
      requestedBy: req.user!.email,
      planKey,
      providerToken: checkout.token,
      conversationId,
      checkoutFormContent: checkout.checkoutFormContent,
      expiresAt: new Date(Date.now() + checkout.tokenExpireTime * 1000)
    });
    res.status(201).json({ checkoutUrl: applicationUrl(`/api/saas/billing/checkout-page/${checkoutId}`), expiresIn: checkout.tokenExpireTime });
  } catch (error) { next(error); }
});

router.post('/billing/cancel', requireRoles('admin'), async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!organizationMatchesRequest(req)) return res.status(409).json({ error: { code: 'ORGANIZATION_CONTEXT_MISMATCH', message: 'Önce işlem yapılacak çalışma alanına geçin.' } });
    const subscription = await getSubscription(req.organization!.organization_id);
    if (!subscription?.provider_subscription_reference) return res.status(409).json({ error: { code: 'NO_ACTIVE_SUBSCRIPTION', message: 'İptal edilecek sağlayıcı aboneliği bulunamadı.' } });
    await getBillingProvider().cancelSubscription(subscription.provider_subscription_reference);
    await deactivateSubscription(req.organization!.organization_id, 'canceled');
    await addAuditLog(req.organization!.organization_id, 'Subscription Canceled', 'Abonelik sağlayıcı üzerinden iptal edildi.', req.ip, req.user!.email);
    void deliverBusinessAlert(req.organization!.organization_id, 'billing', 'Abonelik iptal edildi', 'Ücretli abonelik sağlayıcı üzerinden iptal edildi ve çalışma alanı Starter plana geçirildi.')
      .catch((error) => logger.warn('Abonelik iptal bildirimi gönderilemedi.', { error, organizationId: req.organization!.organization_id }));
    res.json({ success: true });
  } catch (error) { next(error); }
});

export default router;
