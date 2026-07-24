import crypto from 'node:crypto';
import { database, QueryExecutor } from './database';
import { addNotification, databaseReady, DbUser, LastAdminError, listOrganizationAdminEmails } from './db';
import { getPlan, PLAN_DEFINITIONS, PlanKey, UsageMetric, usageLimit } from './plans';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  owner_email: string;
  plan_key: PlanKey;
  created_at: string;
  updated_at: string;
}

export interface OrganizationMember {
  email: string;
  name: string;
  role: DbUser['role'];
  status: 'active' | 'suspended';
  joined_at: string;
  last_login_at?: string | null;
}

export interface Invitation {
  id: string;
  organization_id: string;
  organization_name?: string;
  email: string;
  role: DbUser['role'];
  token_hash: string;
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

export class PlanQuotaError extends Error {
  code: 'PLAN_QUOTA_EXCEEDED' | 'AI_QUOTA_EXHAUSTED' | 'AI_USER_QUOTA_EXHAUSTED';
  details?: Record<string, unknown>;
  constructor(message: string, code: PlanQuotaError['code'] = 'PLAN_QUOTA_EXCEEDED', details?: Record<string, unknown>) {
    super(message);
    this.name = 'PlanQuotaError';
    this.code = code;
    this.details = details;
  }
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(18).toString('base64url')}`;
}

function organizationSlug(name: string, organizationId: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace';
  return `${base}-${organizationId.slice(-8).toLowerCase()}`;
}

function periodKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

function usagePeriod(date = new Date()) {
  const startsAt = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const endsAt = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { key: periodKey(date), startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), resetAt: endsAt.toISOString() };
}

export interface AiUsageSettings {
  perUserMonthlyLimit: number | null;
  autoUsePrepaidCredits: boolean;
  autoCreditBundle: 1000 | 5000;
}

async function ready(): Promise<void> {
  await databaseReady;
}

async function getOrganizationPlan(transaction: QueryExecutor, organizationId: string): Promise<PlanKey> {
  const organization = await transaction.get<{ plan_key: PlanKey }>('SELECT plan_key FROM saas_organizations WHERE id = ?', [organizationId]);
  return organization?.plan_key || 'starter';
}

export async function getOrganization(organizationId: string): Promise<Organization | null> {
  await ready();
  return database.get<Organization>('SELECT * FROM saas_organizations WHERE id = ?', [organizationId]);
}

export async function createOrganizationForUser(email: string, name: string): Promise<Organization> {
  await ready();
  const organizationId = id('org');
  await database.transaction(async (transaction) => {
    await transaction.run(
      `INSERT INTO saas_organizations (id, name, slug, owner_email, plan_key) VALUES (?, ?, ?, ?, 'starter')`,
      [organizationId, name, organizationSlug(name, organizationId), email]
    );
    await transaction.run(
      `INSERT INTO organization_members (organization_id, email, role, status) VALUES (?, ?, 'admin', 'active')`,
      [organizationId, email]
    );
  });
  return (await getOrganization(organizationId))!;
}

export async function updateOrganization(organizationId: string, name: string): Promise<boolean> {
  await ready();
  return (await database.run(
    'UPDATE saas_organizations SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [name, organizationId]
  )).changes > 0;
}

export async function listOrganizationMembers(organizationId: string): Promise<OrganizationMember[]> {
  await ready();
  return database.tenantTransaction(organizationId, (transaction) => transaction.all<OrganizationMember>(
    `SELECT m.email, COALESCE(u.name, m.email) AS name, m.role, m.status, m.joined_at,
       (SELECT MAX(a.created_at) FROM audit_logs a WHERE a.organization_id = m.organization_id AND a.email = m.email AND a.action = 'User Login') AS last_login_at
     FROM organization_members m LEFT JOIN users u ON u.email = m.email
     WHERE m.organization_id = ? ORDER BY m.joined_at ASC, m.email ASC`,
    [organizationId]
  ));
}

export async function createInvitation(
  organizationId: string,
  email: string,
  role: DbUser['role'],
  invitedBy: string,
  tokenHash: string,
  expiresAt: Date
): Promise<Invitation> {
  await ready();
  const normalizedEmail = email.trim().toLowerCase();
  return database.transaction(async (transaction) => {
    const existing = await transaction.get<{ email: string }>(
      `SELECT email FROM organization_members WHERE organization_id = ? AND email = ? AND status = 'active'`,
      [organizationId, normalizedEmail]
    );
    if (existing) throw Object.assign(new Error('Kullanıcı zaten organizasyon üyesi.'), { code: 'MEMBER_EXISTS' });

    const plan = getPlan(await getOrganizationPlan(transaction, organizationId));
    const counts = await transaction.get<{ members: string | number; pending: string | number }>(
      `SELECT
        (SELECT COUNT(*) FROM organization_members WHERE organization_id = ? AND status = 'active') AS members,
        (SELECT COUNT(*) FROM organization_invitations WHERE organization_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?) AS pending`,
      [organizationId, organizationId, new Date().toISOString()]
    );
    if (Number(counts?.members || 0) + Number(counts?.pending || 0) >= plan.limits.members) {
      throw new PlanQuotaError(`${plan.name} planında en fazla ${plan.limits.members} aktif üye ve davet bulunabilir.`);
    }

    await transaction.run(
      `UPDATE organization_invitations SET revoked_at = CURRENT_TIMESTAMP
       WHERE organization_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
      [organizationId, normalizedEmail]
    );
    const invitation: Invitation = {
      id: id('inv'),
      organization_id: organizationId,
      email: normalizedEmail,
      role,
      token_hash: tokenHash,
      invited_by: invitedBy,
      expires_at: expiresAt.toISOString(),
      accepted_at: null,
      revoked_at: null
    };
    await transaction.run(
      `INSERT INTO organization_invitations
       (id, organization_id, email, role, token_hash, invited_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [invitation.id, organizationId, normalizedEmail, role, tokenHash, invitedBy, invitation.expires_at]
    );
    return invitation;
  });
}

export async function getInvitationByHash(tokenHash: string): Promise<Invitation | null> {
  await ready();
  return database.get<Invitation>(
    `SELECT i.*, o.name AS organization_name FROM organization_invitations i
     JOIN saas_organizations o ON o.id = i.organization_id
     WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL`,
    [tokenHash]
  );
}

export async function acceptInvitation(tokenHash: string, email: string): Promise<string> {
  await ready();
  const normalizedEmail = email.trim().toLowerCase();
  return database.transaction(async (transaction) => {
    const invitation = await transaction.get<Invitation>(
      `SELECT * FROM organization_invitations WHERE token_hash = ? AND email = ?
       AND accepted_at IS NULL AND revoked_at IS NULL`,
      [tokenHash, normalizedEmail]
    );
    if (!invitation || new Date(invitation.expires_at).getTime() <= Date.now()) {
      throw Object.assign(new Error('Davet geçersiz veya süresi dolmuş.'), { code: 'INVALID_INVITATION' });
    }
    const plan = getPlan(await getOrganizationPlan(transaction, invitation.organization_id));
    const count = await transaction.get<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM organization_members WHERE organization_id = ? AND status = 'active'`,
      [invitation.organization_id]
    );
    if (Number(count?.count || 0) >= plan.limits.members) throw new PlanQuotaError('Organizasyon üye kotası dolu.');

    await transaction.run(
      `INSERT INTO organization_members (organization_id, email, role, status)
       VALUES (?, ?, ?, 'active')
       ON CONFLICT (organization_id, email) DO UPDATE SET role = excluded.role, status = 'active'`,
      [invitation.organization_id, normalizedEmail, invitation.role]
    );
    await transaction.run('UPDATE organization_invitations SET accepted_at = CURRENT_TIMESTAMP WHERE id = ?', [invitation.id]);
    return invitation.organization_id;
  });
}

export async function revokeInvitation(organizationId: string, invitationId: string): Promise<boolean> {
  await ready();
  return (await database.run(
    `UPDATE organization_invitations SET revoked_at = CURRENT_TIMESTAMP
     WHERE id = ? AND organization_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
    [invitationId, organizationId]
  )).changes > 0;
}

export async function listPendingInvitations(organizationId: string): Promise<Array<Omit<Invitation, 'token_hash'>>> {
  await ready();
  return database.all(
    `SELECT id, organization_id, email, role, invited_by, expires_at, accepted_at, revoked_at
     FROM organization_invitations WHERE organization_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [organizationId]
  );
}

export async function changeMemberRole(organizationId: string, email: string, role: DbUser['role']): Promise<'updated' | 'not_found'> {
  await ready();
  return database.transaction(async (transaction) => {
    const member = await transaction.get<{ role: DbUser['role'] }>(
      'SELECT role FROM organization_members WHERE organization_id = ? AND email = ? AND status = \'active\'',
      [organizationId, email]
    );
    if (!member) return 'not_found';
    if (member.role === 'admin' && role !== 'admin') {
      const admins = await transaction.get<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM organization_members WHERE organization_id = ? AND role = 'admin' AND status = 'active'`,
        [organizationId]
      );
      if (Number(admins?.count || 0) <= 1) throw new LastAdminError();
    }
    await transaction.run(
      'UPDATE organization_members SET role = ? WHERE organization_id = ? AND email = ?',
      [role, organizationId, email]
    );
    return 'updated';
  });
}

export async function removeMember(organizationId: string, email: string): Promise<boolean> {
  await ready();
  return database.transaction(async (transaction) => {
    const member = await transaction.get<{ role: DbUser['role'] }>(
      `SELECT role FROM organization_members WHERE organization_id = ? AND email = ? AND status = 'active'`,
      [organizationId, email]
    );
    if (!member) return false;
    if (member.role === 'admin') {
      const admins = await transaction.get<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM organization_members WHERE organization_id = ? AND role = 'admin' AND status = 'active'`,
        [organizationId]
      );
      if (Number(admins?.count || 0) <= 1) throw new LastAdminError();
    }
    return (await transaction.run(
      'DELETE FROM organization_members WHERE organization_id = ? AND email = ?', [organizationId, email]
    )).changes > 0;
  });
}

export async function createAuthActionToken(email: string, purpose: 'verify_email' | 'reset_password', tokenHash: string, expiresAt: Date): Promise<string> {
  await ready();
  const tokenId = id('auth');
  await database.transaction(async (transaction) => {
    await transaction.run(
      `UPDATE auth_action_tokens SET consumed_at = CURRENT_TIMESTAMP
       WHERE email = ? AND purpose = ? AND consumed_at IS NULL`, [email, purpose]
    );
    await transaction.run(
      `INSERT INTO auth_action_tokens (id, email, purpose, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)`,
      [tokenId, email, purpose, tokenHash, expiresAt.toISOString()]
    );
  });
  return tokenId;
}

export async function consumeAuthActionToken(tokenHash: string, purpose: 'verify_email' | 'reset_password'): Promise<string | null> {
  await ready();
  return database.transaction(async (transaction) => {
    const token = await transaction.get<{ id: string; email: string; expires_at: string }>(
      `SELECT id, email, expires_at FROM auth_action_tokens
       WHERE token_hash = ? AND purpose = ? AND consumed_at IS NULL`,
      [tokenHash, purpose]
    );
    if (!token || new Date(token.expires_at).getTime() <= Date.now()) return null;
    const updated = await transaction.run(
      'UPDATE auth_action_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = ? AND consumed_at IS NULL', [token.id]
    );
    return updated.changes > 0 ? token.email : null;
  });
}

async function aiSettings(executor: QueryExecutor, organizationId: string): Promise<AiUsageSettings> {
  const row = await executor.get<{ per_user_monthly_limit: number | string | null; auto_use_prepaid_credits: number | string; auto_credit_bundle: number | string }>(
    'SELECT per_user_monthly_limit, auto_use_prepaid_credits, auto_credit_bundle FROM organization_ai_settings WHERE organization_id = ?',
    [organizationId]
  );
  return {
    perUserMonthlyLimit: row?.per_user_monthly_limit == null ? null : Number(row.per_user_monthly_limit),
    autoUsePrepaidCredits: Number(row?.auto_use_prepaid_credits || 0) === 1,
    autoCreditBundle: Number(row?.auto_credit_bundle) === 5000 ? 5000 : 1000
  };
}

export async function getAiUsageSettings(organizationId: string): Promise<AiUsageSettings> {
  await ready();
  return aiSettings(database, organizationId);
}

export async function updateAiUsageSettings(organizationId: string, input: AiUsageSettings, updatedBy: string): Promise<AiUsageSettings> {
  await ready();
  const perUserLimit = input.perUserMonthlyLimit;
  if (perUserLimit !== null && (!Number.isInteger(perUserLimit) || perUserLimit < 1 || perUserLimit > 1_000_000)) {
    throw Object.assign(new Error('Kişi başı aylık sınır 1 ile 1.000.000 arasında olmalıdır.'), { code: 'INVALID_AI_SETTINGS' });
  }
  if (input.autoCreditBundle !== 1000 && input.autoCreditBundle !== 5000) {
    throw Object.assign(new Error('Otomatik aktarım paketi geçersiz.'), { code: 'INVALID_AI_SETTINGS' });
  }
  await database.run(
    `INSERT INTO organization_ai_settings
     (organization_id, per_user_monthly_limit, auto_use_prepaid_credits, auto_credit_bundle, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (organization_id) DO UPDATE SET
       per_user_monthly_limit = excluded.per_user_monthly_limit,
       auto_use_prepaid_credits = excluded.auto_use_prepaid_credits,
       auto_credit_bundle = excluded.auto_credit_bundle,
       updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
    [organizationId, perUserLimit, input.autoUsePrepaidCredits ? 1 : 0, input.autoCreditBundle, updatedBy]
  );
  return getAiUsageSettings(organizationId);
}

export async function addAiCreditsToWallet(organizationId: string, quantity: number): Promise<number> {
  await ready();
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000) throw new Error('Geçersiz kredi miktarı.');
  return database.transaction(async (transaction) => {
    await transaction.run(
      `INSERT INTO organization_ai_credit_wallet (organization_id, balance, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (organization_id) DO UPDATE SET balance = organization_ai_credit_wallet.balance + excluded.balance, updated_at = CURRENT_TIMESTAMP`,
      [organizationId, quantity]
    );
    const row = await transaction.get<{ balance: number | string }>('SELECT balance FROM organization_ai_credit_wallet WHERE organization_id = ?', [organizationId]);
    return Number(row?.balance || 0);
  });
}

export async function allocateAiCredits(organizationId: string, quantity: 1000 | 5000, createdBy: string): Promise<number> {
  await ready();
  return database.transaction(async (transaction) => {
    const debit = await transaction.run(
      `UPDATE organization_ai_credit_wallet SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = ? AND balance >= ?`, [quantity, organizationId, quantity]
    );
    if (!debit.changes) throw Object.assign(new Error('Ön ödemeli yapay zekâ bakiyesi yetersiz.'), { code: 'INSUFFICIENT_AI_CREDITS' });
    await transaction.run(
      `INSERT INTO usage_bonus_allocations (id, organization_id, metric, period_key, quantity, source, created_by)
       VALUES (?, ?, 'ai_requests', ?, ?, 'manual', ?)`, [id('bonus'), organizationId, periodKey(), quantity, createdBy]
    );
    const total = await transaction.get<{ total: number | string }>(
      `SELECT COALESCE(SUM(quantity), 0) AS total FROM usage_bonus_allocations
       WHERE organization_id = ? AND metric = 'ai_requests' AND period_key = ?`, [organizationId, periodKey()]
    );
    return Number(total?.total || 0);
  });
}

export async function getUsage(organizationId: string, actorEmail?: string): Promise<{
  plan: ReturnType<typeof getPlan>;
  period: ReturnType<typeof usagePeriod>;
  counters: Record<UsageMetric, number>;
  resources: { members: number; datasets: number; connectors: number; documents: number };
  ai: { used: number; baseLimit: number; bonusCredits: number; effectiveLimit: number; remaining: number; userUsed: number; userLimit: number | null; userRemaining: number | null; creditBalance: number; settings: AiUsageSettings };
}> {
  await ready();
  const period = usagePeriod();
  const organization = await getOrganization(organizationId);
  const counters = await database.all<{ metric: UsageMetric; quantity: string | number }>(
    'SELECT metric, quantity FROM usage_counters WHERE organization_id = ? AND period_key = ?',
    [organizationId, period.key]
  );
  const [resources, settings, bonusRow, walletRow, userRow] = await Promise.all([
    database.tenantTransaction(organizationId, async (transaction) => transaction.get<{
    members: string | number; datasets: string | number; connectors: string | number; documents: string | number;
  }>(
    `SELECT
      (SELECT COUNT(*) FROM organization_members WHERE organization_id = ? AND status = 'active') AS members,
      (SELECT COUNT(*) FROM user_datasets_v2 WHERE organization_id = ?) AS datasets,
      (SELECT COUNT(*) FROM user_connections WHERE organization_id = ?) AS connectors,
      (SELECT COUNT(*) FROM user_documents WHERE organization_id = ?) AS documents`,
    [organizationId, organizationId, organizationId, organizationId]
    )),
    getAiUsageSettings(organizationId),
    database.get<{ total: number | string }>(`SELECT COALESCE(SUM(quantity), 0) AS total FROM usage_bonus_allocations WHERE organization_id = ? AND metric = 'ai_requests' AND period_key = ?`, [organizationId, period.key]),
    database.get<{ balance: number | string }>('SELECT balance FROM organization_ai_credit_wallet WHERE organization_id = ?', [organizationId]),
    actorEmail ? database.get<{ quantity: number | string }>(`SELECT quantity FROM user_usage_counters WHERE organization_id = ? AND email = ? AND metric = 'ai_requests' AND period_key = ?`, [organizationId, actorEmail.trim().toLowerCase(), period.key]) : Promise.resolve(null)
  ]);
  const plan = getPlan(organization?.plan_key);
  const aiUsed = Number(counters.find((item) => item.metric === 'ai_requests')?.quantity || 0);
  const bonusCredits = Number(bonusRow?.total || 0);
  const effectiveLimit = plan.limits.aiRequests + bonusCredits;
  const userUsed = Number(userRow?.quantity || 0);
  return {
    plan,
    period,
    counters: {
      ai_requests: aiUsed,
      ml_runs: Number(counters.find((item) => item.metric === 'ml_runs')?.quantity || 0)
    },
    resources: {
      members: Number(resources?.members || 0),
      datasets: Number(resources?.datasets || 0),
      connectors: Number(resources?.connectors || 0),
      documents: Number(resources?.documents || 0)
    },
    ai: {
      used: aiUsed,
      baseLimit: plan.limits.aiRequests,
      bonusCredits,
      effectiveLimit,
      remaining: Math.max(effectiveLimit - aiUsed, 0),
      userUsed,
      userLimit: settings.perUserMonthlyLimit,
      userRemaining: settings.perUserMonthlyLimit === null ? null : Math.max(settings.perUserMonthlyLimit - userUsed, 0),
      creditBalance: Number(walletRow?.balance || 0),
      settings
    }
  };
}

export async function consumeUsage(organizationId: string, metric: UsageMetric, quantity = 1, actorEmail?: string): Promise<number> {
  await ready();
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new Error('Geçersiz kullanım miktarı.');
  let thresholdReached = false;
  let notificationLimit = 0;
  let notificationUsed = 0;
  const consumed = await database.transaction(async (transaction) => {
    const planKey = await getOrganizationPlan(transaction, organizationId);
    const period = periodKey();
    let limit = usageLimit(planKey, metric);
    if (metric === 'ai_requests') {
      const settings = await aiSettings(transaction, organizationId);
      const normalizedEmail = actorEmail?.trim().toLowerCase();
      if (normalizedEmail && settings.perUserMonthlyLimit !== null) {
        const user = await transaction.get<{ quantity: number | string }>(`SELECT quantity FROM user_usage_counters WHERE organization_id = ? AND email = ? AND metric = 'ai_requests' AND period_key = ?`, [organizationId, normalizedEmail, period]);
        const used = Number(user?.quantity || 0);
        if (used + quantity > settings.perUserMonthlyLimit) {
          throw new PlanQuotaError('Bu ay için size ayrılan yapay zekâ kullanım hakkı doldu. Çalışma alanı yöneticiniz sınırı değiştirebilir.', 'AI_USER_QUOTA_EXHAUSTED', { metric, scope: 'user', used, limit: settings.perUserMonthlyLimit, resetAt: usagePeriod().resetAt });
        }
      }
      const bonus = await transaction.get<{ total: number | string }>(`SELECT COALESCE(SUM(quantity), 0) AS total FROM usage_bonus_allocations WHERE organization_id = ? AND metric = 'ai_requests' AND period_key = ?`, [organizationId, period]);
      limit += Number(bonus?.total || 0);
      const current = await transaction.get<{ quantity: number | string }>('SELECT quantity FROM usage_counters WHERE organization_id = ? AND metric = ? AND period_key = ?', [organizationId, metric, period]);
      if (Number(current?.quantity || 0) + quantity > limit && settings.autoUsePrepaidCredits) {
        const debit = await transaction.run(`UPDATE organization_ai_credit_wallet SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND balance >= ?`, [settings.autoCreditBundle, organizationId, settings.autoCreditBundle]);
        if (debit.changes) {
          await transaction.run(`INSERT INTO usage_bonus_allocations (id, organization_id, metric, period_key, quantity, source, created_by) VALUES (?, ?, 'ai_requests', ?, ?, 'automatic', 'system')`, [id('bonus'), organizationId, period, settings.autoCreditBundle]);
          limit += settings.autoCreditBundle;
        }
      }
    }
    const result = await transaction.run(
      `INSERT INTO usage_counters (organization_id, metric, period_key, quantity, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (organization_id, metric, period_key) DO UPDATE
       SET quantity = usage_counters.quantity + excluded.quantity, updated_at = CURRENT_TIMESTAMP
       WHERE usage_counters.quantity + excluded.quantity <= ?`,
      [organizationId, metric, period, quantity, limit]
    );
    if (result.changes === 0) {
      const current = await transaction.get<{ quantity: number | string }>('SELECT quantity FROM usage_counters WHERE organization_id = ? AND metric = ? AND period_key = ?', [organizationId, metric, period]);
      const used = Number(current?.quantity || 0);
      if (metric === 'ai_requests') {
        const wallet = await transaction.get<{ balance: number | string }>('SELECT balance FROM organization_ai_credit_wallet WHERE organization_id = ?', [organizationId]);
        throw new PlanQuotaError('Bu ayki yapay zekâ kullanım hakkı doldu. Yeni dönem başlayınca haklar yenilenir; yöneticiniz ek hak da alabilir.', 'AI_QUOTA_EXHAUSTED', { metric, scope: 'organization', used, limit, resetAt: usagePeriod().resetAt, creditBalance: Number(wallet?.balance || 0) });
      }
      throw new PlanQuotaError(`${getPlan(planKey).name} planı için aylık analiz çalıştırma hakkı doldu.`);
    }
    if (metric === 'ai_requests' && actorEmail) {
      await transaction.run(`INSERT INTO user_usage_counters (organization_id, email, metric, period_key, quantity, updated_at) VALUES (?, ?, 'ai_requests', ?, ?, CURRENT_TIMESTAMP) ON CONFLICT (organization_id, email, metric, period_key) DO UPDATE SET quantity = user_usage_counters.quantity + excluded.quantity, updated_at = CURRENT_TIMESTAMP`, [organizationId, actorEmail.trim().toLowerCase(), period, quantity]);
    }
    const row = await transaction.get<{ quantity: string | number }>(
      'SELECT quantity FROM usage_counters WHERE organization_id = ? AND metric = ? AND period_key = ?',
      [organizationId, metric, period]
    );
    const used = Number(row?.quantity || quantity);
    if (metric === 'ai_requests' && used * 100 >= limit * 80) {
      const claimed = await transaction.run(`INSERT INTO usage_threshold_events (organization_id, metric, period_key, threshold) VALUES (?, ?, ?, 80) ON CONFLICT (organization_id, metric, period_key, threshold) DO NOTHING`, [organizationId, metric, period]);
      thresholdReached = claimed.changes > 0;
      notificationUsed = used;
      notificationLimit = limit;
    }
    return used;
  });
  if (thresholdReached) {
    const admins = await listOrganizationAdminEmails(organizationId);
    await Promise.all(admins.map((email) => addNotification(organizationId, 'Yapay zekâ hakkının %80’i kullanıldı', `Bu ay ${notificationLimit.toLocaleString('tr-TR')} hakkın ${notificationUsed.toLocaleString('tr-TR')} adedi kullanıldı. Gerekirse Paketim bölümünden ek hak alabilirsiniz.`, email)));
  }
  return consumed;
}

export async function refundUsage(organizationId: string, metric: UsageMetric, quantity = 1, actorEmail?: string): Promise<number> {
  await ready();
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new Error('Geçersiz iade miktarı.');
  return database.transaction(async (transaction) => {
    const period = periodKey();
    await transaction.run(
      `UPDATE usage_counters
       SET quantity = CASE WHEN quantity > ? THEN quantity - ? ELSE 0 END,
           updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = ? AND metric = ? AND period_key = ?`,
      [quantity, quantity, organizationId, metric, period]
    );
    if (metric === 'ai_requests' && actorEmail) {
      await transaction.run(`UPDATE user_usage_counters SET quantity = CASE WHEN quantity > ? THEN quantity - ? ELSE 0 END, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND email = ? AND metric = 'ai_requests' AND period_key = ?`, [quantity, quantity, organizationId, actorEmail.trim().toLowerCase(), period]);
    }
    const row = await transaction.get<{ quantity: string | number }>(
      'SELECT quantity FROM usage_counters WHERE organization_id = ? AND metric = ? AND period_key = ?',
      [organizationId, metric, period]
    );
    return Number(row?.quantity || 0);
  });
}

export async function createBillingCheckout(input: {
  organizationId: string;
  requestedBy: string;
  planKey: PlanKey;
  providerToken: string;
  conversationId: string;
  checkoutFormContent: string;
  expiresAt: Date;
}): Promise<string> {
  await ready();
  const checkoutId = id('checkout');
  await database.run(
    `INSERT INTO billing_checkouts
     (id, organization_id, requested_by, plan_key, provider_token, conversation_id, checkout_form_content, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [checkoutId, input.organizationId, input.requestedBy, input.planKey, input.providerToken, input.conversationId, input.checkoutFormContent, input.expiresAt.toISOString()]
  );
  return checkoutId;
}

export async function createAiCreditPurchase(input: {
  organizationId: string;
  requestedBy: string;
  quantity: 1000 | 5000;
  amountMinor: number;
  providerToken: string;
  conversationId: string;
  checkoutFormContent: string;
  expiresAt: Date;
}): Promise<string> {
  await ready();
  const purchaseId = id('credit');
  await database.run(
    `INSERT INTO ai_credit_purchases
     (id, organization_id, requested_by, quantity, amount_minor, provider_token, conversation_id, checkout_form_content, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [purchaseId, input.organizationId, input.requestedBy, input.quantity, input.amountMinor, input.providerToken, input.conversationId, input.checkoutFormContent, input.expiresAt.toISOString()]
  );
  return purchaseId;
}

export async function getAiCreditPurchase(purchaseId: string): Promise<any | null> {
  await ready();
  return database.get('SELECT * FROM ai_credit_purchases WHERE id = ? AND status = \'initialized\'', [purchaseId]);
}

export async function getAiCreditPurchaseByToken(providerToken: string): Promise<any | null> {
  await ready();
  return database.get('SELECT * FROM ai_credit_purchases WHERE provider_token = ?', [providerToken]);
}

export async function completeAiCreditPurchase(purchaseId: string, paymentId: string): Promise<boolean> {
  await ready();
  return database.transaction(async (transaction) => {
    const purchase = await transaction.get<{ organization_id: string; quantity: number | string; status: string }>('SELECT organization_id, quantity, status FROM ai_credit_purchases WHERE id = ?', [purchaseId]);
    if (!purchase || purchase.status === 'paid') return false;
    const updated = await transaction.run(`UPDATE ai_credit_purchases SET status = 'paid', payment_id = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'initialized'`, [paymentId, purchaseId]);
    if (!updated.changes) return false;
    await transaction.run(`INSERT INTO organization_ai_credit_wallet (organization_id, balance, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT (organization_id) DO UPDATE SET balance = organization_ai_credit_wallet.balance + excluded.balance, updated_at = CURRENT_TIMESTAMP`, [purchase.organization_id, Number(purchase.quantity)]);
    return true;
  });
}

export async function failAiCreditPurchase(purchaseId: string): Promise<void> {
  await ready();
  await database.run(`UPDATE ai_credit_purchases SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'initialized'`, [purchaseId]);
}

export async function getBillingCheckout(checkoutId: string): Promise<any | null> {
  await ready();
  return database.get(
    'SELECT * FROM billing_checkouts WHERE id = ? AND completed_at IS NULL', [checkoutId]
  );
}

export async function getBillingCheckoutByProviderToken(providerToken: string): Promise<any | null> {
  await ready();
  return database.get(
    'SELECT * FROM billing_checkouts WHERE provider_token = ? AND completed_at IS NULL', [providerToken]
  );
}

export async function completeBillingCheckout(checkoutId: string): Promise<boolean> {
  await ready();
  return (await database.run(
    'UPDATE billing_checkouts SET completed_at = CURRENT_TIMESTAMP WHERE id = ? AND completed_at IS NULL', [checkoutId]
  )).changes > 0;
}

export async function upsertSubscription(input: {
  organizationId: string;
  provider: string;
  planKey: PlanKey;
  status: string;
  customerReference?: string | null;
  subscriptionReference?: string | null;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
}): Promise<void> {
  await ready();
  await database.transaction(async (transaction) => {
    await transaction.run(
      `INSERT INTO organization_subscriptions
       (organization_id, provider, provider_customer_reference, provider_subscription_reference, plan_key, status,
        current_period_start, current_period_end, cancel_at_period_end, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (organization_id) DO UPDATE SET
        provider = excluded.provider,
        provider_customer_reference = COALESCE(excluded.provider_customer_reference, organization_subscriptions.provider_customer_reference),
        provider_subscription_reference = COALESCE(excluded.provider_subscription_reference, organization_subscriptions.provider_subscription_reference),
        plan_key = excluded.plan_key, status = excluded.status,
        current_period_start = COALESCE(excluded.current_period_start, organization_subscriptions.current_period_start),
        current_period_end = COALESCE(excluded.current_period_end, organization_subscriptions.current_period_end),
        cancel_at_period_end = excluded.cancel_at_period_end, updated_at = CURRENT_TIMESTAMP`,
      [input.organizationId, input.provider, input.customerReference || null, input.subscriptionReference || null,
        input.planKey, input.status, input.currentPeriodStart || null, input.currentPeriodEnd || null, input.cancelAtPeriodEnd ? 1 : 0]
    );
    if (['active', 'trialing'].includes(input.status)) {
      await transaction.run(
        'UPDATE saas_organizations SET plan_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [input.planKey, input.organizationId]
      );
    }
  });
}

export async function getSubscription(organizationId: string): Promise<any | null> {
  await ready();
  return database.get('SELECT * FROM organization_subscriptions WHERE organization_id = ?', [organizationId]);
}

export async function getSubscriptionByProviderReference(referenceCode: string): Promise<any | null> {
  await ready();
  return database.get(
    'SELECT * FROM organization_subscriptions WHERE provider_subscription_reference = ?', [referenceCode]
  );
}

export async function deactivateSubscription(organizationId: string, status = 'canceled'): Promise<void> {
  await ready();
  await database.transaction(async (transaction) => {
    await transaction.run(
      `UPDATE organization_subscriptions SET status = ?, cancel_at_period_end = 0, updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = ?`,
      [status, organizationId]
    );
    await transaction.run(
      `UPDATE saas_organizations SET plan_key = 'starter', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [organizationId]
    );
  });
}

export async function recordBillingEvent(eventKey: string, organizationId: string | null, eventType: string, payload: unknown): Promise<boolean> {
  await ready();
  try {
    await database.run(
      'INSERT INTO billing_events (event_key, organization_id, event_type, payload_json) VALUES (?, ?, ?, ?)',
      [eventKey, organizationId, eventType, JSON.stringify(payload)]
    );
    return true;
  } catch (error: any) {
    if (String(error?.code) === '23505' || String(error?.message).includes('UNIQUE constraint failed')) return false;
    throw error;
  }
}

export async function releaseBillingEvent(eventKey: string): Promise<void> {
  await ready();
  await database.run('DELETE FROM billing_events WHERE event_key = ?', [eventKey]);
}

export function publicPlans() {
  return Object.values(PLAN_DEFINITIONS).map((plan) => ({ ...plan, billingPlanEnv: undefined }));
}
