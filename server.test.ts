import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import { serverAppPromise } from './server';
import { Express } from 'express';
import {
  changeUserRole,
  createConnection,
  deleteUser,
  findUserByEmail,
  getActiveMembership,
  getLatestDataset,
  LastAdminError,
  listUsers,
  listUserDatasets,
  saveDataset,
  updateUserRole
} from './src/lib/db';
import { buildExportPayload } from './src/server/ml/pipeline';
import {
  acceptInvitation,
  changeMemberRole,
  addAiCreditsToWallet,
  consumeUsage,
  createAuthActionToken,
  createInvitation,
  getUsage,
  PlanQuotaError,
  refundUsage,
  updateAiUsageSettings
} from './src/lib/saasDb';
import { createOpaqueToken } from './src/lib/securityTokens';

// Mock GoogleGenAI
vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = {
      generateContent: vi.fn().mockResolvedValue({
        text: 'Mocked Gemini Response'
      })
    };
  }
  return { GoogleGenAI };
});

describe('Express JWT Authentication & Registration Integration Tests', () => {
  let app: Express;

  beforeAll(async () => {
    app = await serverAppPromise;
  });

  it('GET /api/health returns 200 and status ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('POST /api/register creates a user account', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({
        email: 'new-user@enterprise.com',
        name: 'New User',
        password: 'securePassword123'
      });
    
    // Might return 201 Created or 400 if user exists from previous local runs
    expect([201, 400]).toContain(res.status);
    
    const dbUser = await findUserByEmail('new-user@enterprise.com');
    expect(dbUser).toBeDefined();
    expect(dbUser?.name).toBe('New User');
  });

  it('POST /api/login with valid credentials returns JWT token', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({
        email: 'new-user@enterprise.com',
        password: 'securePassword123'
      });
    
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe('new-user@enterprise.com');
  });

  it('POST /api/login with invalid credentials returns 401', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({
        email: 'new-user@enterprise.com',
        password: 'wrongPassword'
      });
    
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects weak registration data and protects authenticated endpoints', async () => {
    const weak = await request(app)
      .post('/api/register')
      .send({ email: 'invalid', name: 'X', password: 'short' });
    const unauthorized = await request(app).get('/api/dataset/list');

    expect(weak.status).toBe(400);
    expect(unauthorized.status).toBe(401);
  });

  it('restores a valid session through GET /api/me', async () => {
    const login = await request(app)
      .post('/api/login')
      .send({ email: 'new-user@enterprise.com', password: 'securePassword123' });
    const me = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${login.body.token}`);

    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('new-user@enterprise.com');
    expect(me.body.user.role).toBe('admin');
    expect(me.body.organization.organization_id).toBe(me.body.user.tenantId);
  });

  it('reports the free package clearly when a workspace has no paid subscription', async () => {
    const login = await request(app)
      .post('/api/login')
      .send({ email: 'new-user@enterprise.com', password: 'securePassword123' });
    const usage = await request(app)
      .get('/api/saas/usage')
      .set('Authorization', `Bearer ${login.body.token}`);

    expect(usage.status).toBe(200);
    expect(usage.body).toMatchObject({ planKey: 'starter', subscriptionStatus: 'included' });
  });

  it('revokes the current JWT on logout', async () => {
    const login = await request(app)
      .post('/api/login')
      .send({ email: 'new-user@enterprise.com', password: 'securePassword123' });
    const token = login.body.token;

    const logout = await request(app)
      .post('/api/logout')
      .set('Authorization', `Bearer ${token}`);
    const reusedToken = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`);

    expect(logout.status).toBe(204);
    expect(reusedToken.status).toBe(401);
  });

  it('uses an HttpOnly cookie for same-origin web sessions', async () => {
    const agent = request.agent(app);
    const email = 'cookie-session@enterprise.com';
    await agent.post('/api/register').send({ email, name: 'Cookie Session', password: 'securePassword123' });
    const login = await agent
      .post('/api/login')
      .set('X-Client-Type', 'web')
      .send({ email, password: 'securePassword123' });

    expect(login.status).toBe(200);
    // Test clients also receive a bearer token, while the browser path still establishes the cookie.
    expect(login.body.token).toBeDefined();
    expect(login.headers['set-cookie']?.[0]).toContain('HttpOnly');
    expect(login.headers['set-cookie']?.[0]).toContain('SameSite=Lax');

    const me = await agent.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);

    await agent.post('/api/logout');
    expect((await agent.get('/api/me')).status).toBe(401);
  });

  it('rejects cross-organization identifiers even with a valid JWT', async () => {
    const first = `idor-a-${Date.now()}@enterprise.com`;
    const second = `idor-b-${Date.now()}@enterprise.com`;
    await request(app).post('/api/register').send({ email: first, name: 'Tenant A', password: 'securePassword123' });
    await request(app).post('/api/register').send({ email: second, name: 'Tenant B', password: 'securePassword123' });
    const firstLogin = await request(app).post('/api/login').send({ email: first, password: 'securePassword123' });
    const secondLogin = await request(app).post('/api/login').send({ email: second, password: 'securePassword123' });
    const firstOrganizationId = firstLogin.body.organization.organization_id;

    const forbidden = await request(app)
      .get('/api/dataset/list')
      .set('Authorization', `Bearer ${secondLogin.body.token}`)
      .set('X-Organization-Id', firstOrganizationId);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('ORGANIZATION_ACCESS_DENIED');
  });

  it('enforces organization viewer write restrictions on the server', async () => {
    const ownerEmail = 'viewer-owner@enterprise.com';
    const email = 'viewer-user@enterprise.com';
    await request(app)
      .post('/api/register')
      .send({ email: ownerEmail, name: 'Viewer Owner', password: 'securePassword123' });
    await request(app)
      .post('/api/register')
      .send({ email, name: 'Viewer User', password: 'securePassword123' });
    const ownerOrganization = (await getActiveMembership(ownerEmail))!;
    const ownerLogin = await request(app)
      .post('/api/login')
      .send({ email: ownerEmail, password: 'securePassword123' });
    await request(app)
      .post('/api/upload')
      .set('X-Organization-Id', ownerOrganization.organization_id)
      .set('Authorization', `Bearer ${ownerLogin.body.token}`)
      .attach('file', Buffer.from('name,value\nShared,1'), 'shared.csv');
    const invitation = createOpaqueToken();
    await createInvitation(ownerOrganization.organization_id, email, 'viewer', ownerEmail, invitation.hash, new Date(Date.now() + 60_000));
    await acceptInvitation(invitation.hash, email);
    const login = await request(app)
      .post('/api/login')
      .send({ email, password: 'securePassword123' });
    const organizationHeader = { 'X-Organization-Id': ownerOrganization.organization_id };

    const read = await request(app)
      .get('/api/dataset/list')
      .set(organizationHeader)
      .set('Authorization', `Bearer ${login.body.token}`);
    const write = await request(app)
      .delete('/api/dataset')
      .set(organizationHeader)
      .set('Authorization', `Bearer ${login.body.token}`);
    const selfEscalation = await request(app)
      .put('/api/enterprise/roles')
      .set(organizationHeader)
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ email, role: 'admin' });

    expect(read.status).toBe(200);
    expect(read.body).toHaveLength(1);
    expect(read.body[0].filename).toBe('shared.csv');
    expect(write.status).toBe(403);
    expect(selfEscalation.status).toBe(403);
  });

  it('supports the authorized dataset upload, ordering, activation and deletion lifecycle', async () => {
    const email = 'dataset-lifecycle@enterprise.com';
    await request(app)
      .post('/api/register')
      .send({ email, name: 'Dataset Lifecycle', password: 'securePassword123' });
    const login = await request(app)
      .post('/api/login')
      .send({ email, password: 'securePassword123' });
    const authorization = `Bearer ${login.body.token}`;

    const invalid = await request(app)
      .post('/api/upload')
      .set('Authorization', authorization)
      .attach('file', Buffer.from('name,value\nA,1'), 'not-csv.txt');
    const first = await request(app)
      .post('/api/upload')
      .set('Authorization', authorization)
      .attach('file', Buffer.from('name,value\nA,1'), 'first.csv');
    const second = await request(app)
      .post('/api/upload')
      .set('Authorization', authorization)
      .attach('file', Buffer.from('name,value\nB,2'), 'second.csv');
    const listed = await request(app)
      .get('/api/dataset/list')
      .set('Authorization', authorization);

    expect(invalid.status).toBe(400);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(listed.body.map((dataset: { filename: string }) => dataset.filename)).toEqual(['second.csv', 'first.csv']);

    const activated = await request(app)
      .put(`/api/dataset/${first.body.id}/active`)
      .set('Authorization', authorization);
    const deleted = await request(app)
      .delete(`/api/dataset/${second.body.id}`)
      .set('Authorization', authorization);
    const remaining = await request(app)
      .get('/api/dataset/list')
      .set('Authorization', authorization);

    expect(activated.status).toBe(200);
    expect(deleted.status).toBe(200);
    expect(remaining.body).toHaveLength(1);
    expect(remaining.body[0]).toMatchObject({ id: first.body.id, filename: 'first.csv', is_active: 1 });
  });

  it('accepts a data file larger than the former 10 MB upload limit', async () => {
    const email = `large-dataset-${Date.now()}@enterprise.com`;
    await request(app)
      .post('/api/register')
      .send({ email, name: 'Large Dataset', password: 'securePassword123' });
    const login = await request(app)
      .post('/api/login')
      .send({ email, password: 'securePassword123' });
    const authorization = `Bearer ${login.body.token}`;
    const content = Buffer.from(`note\n${'x'.repeat((10 * 1024 * 1024) + 1_024)}\n`);

    const uploaded = await request(app)
      .post('/api/upload')
      .set('Authorization', authorization)
      .attach('file', content, 'buyuk-veri.csv');

    expect(uploaded.status).toBe(200);
    expect(uploaded.body).toMatchObject({ filename: 'buyuk-veri.csv', rowCount: 1, columnCount: 1 });

    await request(app)
      .delete(`/api/dataset/${uploaded.body.id}`)
      .set('Authorization', authorization)
      .expect(200);
  }, 15_000);

  it('configures bounded automatic REST schedules and exposes sync history', async () => {
    const email = `connector-schedule-${Date.now()}@enterprise.com`;
    await request(app)
      .post('/api/register')
      .send({ email, name: 'Connector Schedule', password: 'securePassword123' });
    const login = await request(app)
      .post('/api/login')
      .send({ email, password: 'securePassword123' });
    const organizationId = login.body.organization.organization_id as string;
    const connectionId = await createConnection(organizationId, 'api', 'Scheduled Source', 'encrypted-test-value', email);
    const authorization = `Bearer ${login.body.token}`;

    const invalid = await request(app)
      .patch(`/api/enterprise/connections/${connectionId}/schedule`)
      .set('Authorization', authorization)
      .send({ enabled: true, intervalMinutes: 5 });
    const enabled = await request(app)
      .patch(`/api/enterprise/connections/${connectionId}/schedule`)
      .set('Authorization', authorization)
      .send({ enabled: true, intervalMinutes: 30 });
    const history = await request(app)
      .get(`/api/enterprise/connections/${connectionId}/sync-runs`)
      .set('Authorization', authorization);

    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_SYNC_SCHEDULE');
    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({
      id: connectionId,
      scheduleEnabled: true,
      scheduleIntervalMinutes: 30
    });
    expect(new Date(enabled.body.nextSyncAt).getTime()).toBeGreaterThan(Date.now());
    expect(history.status).toBe(200);
    expect(history.body.items).toEqual([]);
  });

  it('persists tenant-scoped business notification preferences', async () => {
    const email = `notifications-${Date.now()}@enterprise.com`;
    await request(app).post('/api/register').send({ email, name: 'Notification Admin', password: 'securePassword123' });
    const login = await request(app).post('/api/login').send({ email, password: 'securePassword123' });
    const authorization = `Bearer ${login.body.token}`;
    const updated = await request(app)
      .put('/api/enterprise/notification-settings')
      .set('Authorization', authorization)
      .send({ emailEnabled: true, events: ['kpi_breach', 'billing'] });
    const fetched = await request(app)
      .get('/api/enterprise/notification-settings')
      .set('Authorization', authorization);

    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ emailEnabled: true, slackConfigured: false, teamsConfigured: false, events: ['kpi_breach', 'billing'] });
    expect(fetched.status).toBe(200);
    expect(fetched.body.events).toEqual(['kpi_breach', 'billing']);
  });

  it('persists dashboard layout and provides tenant data governance controls', async () => {
    const email = `governance-${Date.now()}@enterprise.com`;
    await request(app).post('/api/register').send({ email, name: 'Governance Admin', password: 'securePassword123' });
    const login = await request(app).post('/api/login').send({ email, password: 'securePassword123' });
    const authorization = `Bearer ${login.body.token}`;

    const layout = await request(app)
      .put('/api/dashboard/preference')
      .set('Authorization', authorization)
      .send({ order: ['trend', 'kpi-revenue', 'unknown'], hidden: ['profile'] });
    const savedLayout = await request(app)
      .get('/api/dashboard/preference')
      .set('Authorization', authorization);
    const policy = await request(app)
      .put('/api/enterprise/data-governance')
      .set('Authorization', authorization)
      .send({ enabled: true, retentionDays: 365 });
    const exported = await request(app)
      .get('/api/enterprise/data-governance/export')
      .set('Authorization', authorization);

    expect(layout.status).toBe(200);
    expect(layout.body).toMatchObject({ order: ['trend', 'kpi-revenue'], hidden: ['profile'] });
    expect(savedLayout.body).toMatchObject({ order: ['trend', 'kpi-revenue'], hidden: ['profile'] });
    expect(policy.status).toBe(200);
    expect(policy.body).toMatchObject({ enabled: true, retentionDays: 365 });
    expect(exported.status).toBe(200);
    expect(exported.headers['content-disposition']).toContain('reai-kurum-verisi-');
    expect(exported.body.organization.owner_email).toBe(email);
  });

  it('imports JSON and lets users curate the analysis scope without deleting sources', async () => {
    const email = `scope-${Date.now()}@enterprise.com`;
    await request(app).post('/api/register').send({
      email,
      name: 'Scope User',
      password: 'securePassword123'
    });
    const login = await request(app).post('/api/login').send({ email, password: 'securePassword123' });
    const authorization = `Bearer ${login.body.token}`;

    const jsonUpload = await request(app)
      .post('/api/upload')
      .set('Authorization', authorization)
      .attach('file', Buffer.from(JSON.stringify({ items: [
        { category: 'A', revenue: 10 },
        { category: 'B', revenue: 20 }
      ] })), 'source.json');
    const csvUpload = await request(app)
      .post('/api/upload')
      .set('Authorization', authorization)
      .attach('file', Buffer.from('category,revenue\nC,30'), 'source.csv');

    expect(jsonUpload.status).toBe(200);
    expect(jsonUpload.body).toMatchObject({ rowCount: 2, columnCount: 2, sourceType: 'json' });
    expect(csvUpload.status).toBe(200);

    const excluded = await request(app)
      .patch(`/api/dataset/${csvUpload.body.id}/analysis-scope`)
      .set('Authorization', authorization)
      .send({ enabled: false });
    const listed = await request(app).get('/api/dataset/list').set('Authorization', authorization);
    const summary = await request(app).get('/api/dataset/summary').set('Authorization', authorization);

    expect(excluded.status).toBe(200);
    expect(listed.body).toHaveLength(2);
    expect(listed.body.find((item: { id: number }) => item.id === csvUpload.body.id).include_in_analysis).toBe(0);
    expect(summary.status).toBe(200);
    expect(summary.body.datasetIds).toEqual([jsonUpload.body.id]);
    expect(summary.body.summary).toMatchObject({ rowCount: 2, totalRevenue: 30 });
  });

  it('keeps heterogeneous uploads usable by grouping sources around the active dataset', async () => {
    const email = `schema-group-${Date.now()}@enterprise.com`;
    await request(app).post('/api/register').send({
      email,
      name: 'Schema Group User',
      password: 'securePassword123'
    });
    const login = await request(app).post('/api/login').send({ email, password: 'securePassword123' });
    const authorization = `Bearer ${login.body.token}`;

    const commerce = await request(app)
      .post('/api/upload')
      .set('Authorization', authorization)
      .attach('file', Buffer.from('siparis_id,tarih,kategori,urun_adi,bolge,satis_kanali,adet,birim_fiyat,toplam_tutar,musteri_memnuniyet_skoru,iade_edildi\n1,2026-01-01,A,Urun,A,Web,2,10,20,5,hayir'), 'eticaret.csv');
    const sales = await request(app)
      .post('/api/upload')
      .set('Authorization', authorization)
      .attach('file', Buffer.from('IslemID,Tarih,Kategori,Bolge,Musteri_Skoru,Satis_Miktari,Kar_Orani\n2,2026-01-02,B,B,4,30,0.2'), 'satis.csv');

    const relatedGroup = await request(app).get('/api/dataset/analysis-group').set('Authorization', authorization);
    expect(commerce.status).toBe(200);
    expect(sales.status).toBe(200);
    expect(relatedGroup.status).toBe(200);
    expect(relatedGroup.body.datasetIds).toEqual([commerce.body.id, sales.body.id]);
    expect(relatedGroup.body.excludedFilenames).toEqual([]);

    const staff = await request(app)
      .post('/api/upload')
      .set('Authorization', authorization)
      .attach('file', Buffer.from('calisan,departman,izin_gunu\nAyse,Finans,3'), 'personel.csv');
    const separateGroup = await request(app).get('/api/dataset/analysis-group').set('Authorization', authorization);
    const staffColumns = await request(app).get('/api/kpis/columns').set('Authorization', authorization);

    expect(staff.status).toBe(200);
    expect(separateGroup.status).toBe(200);
    expect(separateGroup.body.datasetIds).toEqual([staff.body.id]);
    expect(separateGroup.body.excludedFilenames).toEqual(expect.arrayContaining(['eticaret.csv', 'satis.csv']));
    expect(staffColumns.status).toBe(200);
    expect(staffColumns.body.allColumns).toEqual(expect.arrayContaining(['calisan', 'departman', 'izin_gunu']));

    await request(app)
      .put(`/api/dataset/${sales.body.id}/active`)
      .set('Authorization', authorization);
    const restoredGroup = await request(app).get('/api/dataset/analysis-group').set('Authorization', authorization);
    expect(restoredGroup.body.datasetIds).toEqual([commerce.body.id, sales.body.id]);
    expect(restoredGroup.body.excludedFilenames).toEqual(['personel.csv']);
  });

  it('atomically preserves one administrator during concurrent demotion and deletion', async () => {
    const first = 'atomic-admin-a@enterprise.com';
    const second = 'atomic-admin-b@enterprise.com';
    await request(app).post('/api/register').send({ email: first, name: 'Admin A', password: 'securePassword123' });
    await request(app).post('/api/register').send({ email: second, name: 'Admin B', password: 'securePassword123' });
    await updateUserRole(first, 'admin');
    await updateUserRole(second, 'admin');

    const results = await Promise.all([
      changeUserRole(first, 'analyst'),
      changeUserRole(second, 'analyst')
    ]);
    expect(results.sort()).toEqual(['last_admin', 'updated']);

    const admins = (await listUsers()).filter((user) => user.role === 'admin');
    expect(admins).toHaveLength(1);
    await expect(deleteUser(admins[0].email)).resolves.toBeUndefined();
    expect(await findUserByEmail(admins[0].email)).toBeNull();
  });

  it('preserves the final administrator inside each organization', async () => {
    const email = `last-org-admin-${Date.now()}@enterprise.com`;
    await request(app).post('/api/register').send({ email, name: 'Last Org Admin', password: 'securePassword123' });
    const membership = (await getActiveMembership(email))!;

    await expect(changeMemberRole(membership.organization_id, email, 'analyst')).rejects.toBeInstanceOf(LastAdminError);
  });

  it('enforces persistent monthly plan usage atomically', async () => {
    const email = `usage-quota-${Date.now()}@enterprise.com`;
    await request(app).post('/api/register').send({ email, name: 'Usage Quota', password: 'securePassword123' });
    const membership = (await getActiveMembership(email))!;

    expect(await consumeUsage(membership.organization_id, 'ml_runs', 25)).toBe(25);
    await expect(consumeUsage(membership.organization_id, 'ml_runs')).rejects.toBeInstanceOf(PlanQuotaError);
  });

  it('enforces per-person AI limits, refunds failed requests and automatically uses prepaid credits', async () => {
    const email = `ai-quota-${Date.now()}@enterprise.com`;
    await request(app).post('/api/register').send({ email, name: 'AI Quota', password: 'securePassword123' });
    const membership = (await getActiveMembership(email))!;
    await updateAiUsageSettings(membership.organization_id, { perUserMonthlyLimit: 2, autoUsePrepaidCredits: false, autoCreditBundle: 1000 }, email);
    expect(await consumeUsage(membership.organization_id, 'ai_requests', 2, email)).toBe(2);
    await expect(consumeUsage(membership.organization_id, 'ai_requests', 1, email)).rejects.toMatchObject({ code: 'AI_USER_QUOTA_EXHAUSTED' });
    expect(await refundUsage(membership.organization_id, 'ai_requests', 1, email)).toBe(1);
    expect(await consumeUsage(membership.organization_id, 'ai_requests', 1, email)).toBe(2);

    await updateAiUsageSettings(membership.organization_id, { perUserMonthlyLimit: null, autoUsePrepaidCredits: true, autoCreditBundle: 1000 }, email);
    await addAiCreditsToWallet(membership.organization_id, 1000);
    await consumeUsage(membership.organization_id, 'ai_requests', 98, email);
    expect(await consumeUsage(membership.organization_id, 'ai_requests', 1, email)).toBe(101);
    const usage = await getUsage(membership.organization_id, email);
    expect(usage.ai).toMatchObject({ used: 101, effectiveLimit: 1100, bonusCredits: 1000, creditBalance: 0 });
  });

  it('creates a shareable invitation when transactional e-mail is not configured', async () => {
    const email = `invite-owner-${Date.now()}@enterprise.com`;
    await request(app).post('/api/register').send({ email, name: 'Invite Owner', password: 'securePassword123' });
    const login = await request(app).post('/api/login').send({ email, password: 'securePassword123' });
    const invitedEmail = `invited-${Date.now()}@enterprise.com`;
    const response = await request(app).post('/api/saas/invitations').set('Authorization', `Bearer ${login.body.token}`).send({ email: invitedEmail, role: 'viewer' });
    expect(response.status).toBe(201);
    expect(response.body.delivery).toBe('link');
    expect(response.body.inviteUrl).toContain('invite=');
    expect(response.body.invitation.role).toBe('viewer');
  });

  it('consumes password reset tokens once and revokes old sessions', async () => {
    const email = `password-reset-${Date.now()}@enterprise.com`;
    await request(app).post('/api/register').send({ email, name: 'Password Reset', password: 'securePassword123' });
    const reset = createOpaqueToken();
    await createAuthActionToken(email, 'reset_password', reset.hash, new Date(Date.now() + 60_000));

    const changed = await request(app)
      .post('/api/reset-password')
      .send({ token: reset.token, password: 'newSecurePassword456' });
    const reused = await request(app)
      .post('/api/reset-password')
      .send({ token: reset.token, password: 'anotherSecurePassword789' });
    const oldLogin = await request(app).post('/api/login').send({ email, password: 'securePassword123' });
    const newLogin = await request(app).post('/api/login').send({ email, password: 'newSecurePassword456' });

    expect(changed.status).toBe(200);
    expect(reused.status).toBe(400);
    expect(oldLogin.status).toBe(401);
    expect(newLogin.status).toBe(200);
  });

  it('requires and validates a separate bootstrap token for the configured first admin email', async () => {
    const previousEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
    const previousToken = process.env.BOOTSTRAP_ADMIN_TOKEN;
    const bootstrapEmail = 'bootstrap-admin@enterprise.com';
    const bootstrapToken = 'test-only-bootstrap-token-at-least-32-characters';
    const registration = {
      email: bootstrapEmail,
      name: 'Bootstrap Admin',
      password: 'securePassword123'
    };
    process.env.BOOTSTRAP_ADMIN_EMAIL = bootstrapEmail;
    delete process.env.BOOTSTRAP_ADMIN_TOKEN;
    try {
      const notConfigured = await request(app)
        .post('/api/register')
        .send(registration);
      expect(notConfigured.status).toBe(503);
      expect(notConfigured.body.error.code).toBe('BOOTSTRAP_NOT_CONFIGURED');

      process.env.BOOTSTRAP_ADMIN_TOKEN = bootstrapToken;
      const wrongToken = await request(app)
        .post('/api/register')
        .set('X-Bootstrap-Token', 'wrong-test-bootstrap-token-at-least-32-chars')
        .send(registration);
      expect(wrongToken.status).toBe(403);
      expect(wrongToken.body.error.code).toBe('INVALID_BOOTSTRAP_TOKEN');

      const created = await request(app)
        .post('/api/register')
        .set('X-Bootstrap-Token', bootstrapToken)
        .send(registration);
      expect(created.status).toBe(201);
      expect((await findUserByEmail(bootstrapEmail))?.role).toBe('admin');
    } finally {
      if (await findUserByEmail(bootstrapEmail)) {
        await updateUserRole(bootstrapEmail, 'analyst');
        await deleteUser(bootstrapEmail);
      }
      if (previousEmail === undefined) delete process.env.BOOTSTRAP_ADMIN_EMAIL;
      else process.env.BOOTSTRAP_ADMIN_EMAIL = previousEmail;
      if (previousToken === undefined) delete process.env.BOOTSTRAP_ADMIN_TOKEN;
      else process.env.BOOTSTRAP_ADMIN_TOKEN = previousToken;
    }
  });

  it('runs ETL against the uploaded dataset instead of returning fixed rows', async () => {
    const email = 'etl-user@enterprise.com';
    await request(app)
      .post('/api/register')
      .send({ email, name: 'ETL User', password: 'securePassword123' });
    const login = await request(app)
      .post('/api/login')
      .send({ email, password: 'securePassword123' });
    await saveDataset(email, 'source.csv', 'category,revenue\nA,10\nB,\nC,30', '', 3, 2);

    const response = await request(app)
      .post('/api/enterprise/etl/run')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ operations: ['imputation', 'type_sync'] });

    expect(response.status).toBe(200);
    expect(response.body.dataset.rowCount).toBe(3);
    expect(response.body.stats.filledCells).toBe(1);
    const transformed = await getLatestDataset(email);
    expect(transformed?.file_content).toContain('B,20');
    expect(transformed?.file_content).not.toContain('DÜZELTİLDİ');
  });

  it('neutralizes spreadsheet formulas in CSV exports', () => {
    const payload = buildExportPayload('Security report', [
      { metric: '=HYPERLINK("https://example.test")', value: '+1+1' }
    ]);
    const csv = Buffer.from(payload.base64Content, 'base64').toString('utf8');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+1+1");
  });

  it('downloads real dashboard, prediction, insight and quality reports', async () => {
    const email = 'report-user@enterprise.com';
    await request(app)
      .post('/api/register')
      .send({ email, name: 'Report User', password: 'securePassword123' });
    const login = await request(app)
      .post('/api/login')
      .send({ email, password: 'securePassword123' });
    await saveDataset(
      email,
      'reports.csv',
      'date,category,revenue,cost\n2026-01-01,A,100,40\n2026-02-01,B,150,50\n2026-03-01,A,220,70\n2026-04-01,B,260,90',
      '',
      4,
      4
    );

    for (const type of ['dashboard', 'prediction', 'insights', 'quality']) {
      const response = await request(app)
        .get(`/reports/download?type=${type}`)
        .set('Authorization', `Bearer ${login.body.token}`);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('.csv');
      const csvLength = response.text?.length ?? response.body?.length ?? 0;
      expect(csvLength).toBeGreaterThan(50);
    }
  });

  it('SQLite Database user isolation test', async () => {
    await saveDataset('userA@enterprise.com', 'a.csv', 'A data content', 'none', 1, 1);
    await saveDataset('userB@enterprise.com', 'b.csv', 'B data content', 'none', 1, 1);

    const dataA = await getLatestDataset('userA@enterprise.com');
    expect(dataA?.filename).toBe('a.csv');
    expect(dataA?.file_content).toBe('A data content');

    const dataB = await getLatestDataset('userB@enterprise.com');
    expect(dataB?.filename).toBe('b.csv');
    expect(dataB?.file_content).toBe('B data content');
  });

  it('serializes concurrent dataset writes without corrupting active state', async () => {
    const email = 'concurrent-writes@enterprise.com';
    const writes = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        saveDataset(email, `parallel-${index}.csv`, `value\n${index}`, '', 1, 1)
      )
    );
    const datasets = await listUserDatasets(email);

    expect(new Set(writes).size).toBe(8);
    expect(datasets).toHaveLength(8);
    expect(datasets.filter((dataset) => dataset.is_active === 1)).toHaveLength(1);
  });

  it('multi-dataset endpoints analyze all uploaded files together', async () => {
    const email = `multi-${Date.now()}@enterprise.com`;
    await request(app)
      .post('/api/register')
      .send({
        email,
        name: 'Multi Dataset User',
        password: 'securePassword123'
      });

    const login = await request(app)
      .post('/api/login')
      .send({
        email,
        password: 'securePassword123'
      });

    const firstId = await saveDataset(email, 'first.csv', 'category,revenue\nA,10\nB,20\nC,30', '', 3, 2);
    const secondId = await saveDataset(email, 'second.csv', 'category,revenue\nA,100\nB,200\nC,300', '', 3, 2);

    const list = await request(app)
      .get('/api/dataset/list')
      .set('Authorization', `Bearer ${login.body.token}`);

    expect(list.status).toBe(200);
    expect(list.body.map((dataset: { id: number }) => dataset.id)).toEqual(expect.arrayContaining([firstId, secondId]));

    const summary = await request(app)
      .get('/api/dataset/summary')
      .set('Authorization', `Bearer ${login.body.token}`);

    expect(summary.status).toBe(200);
    expect(summary.body.datasetIds).toEqual([firstId, secondId]);
    expect(summary.body.datasetCount).toBe(2);
    expect(summary.body.summary.rowCount).toBe(6);
    expect(summary.body.summary.totalRevenue).toBe(660);

    const dashboard = await request(app)
      .get('/api/dashboard/dynamic')
      .set('Authorization', `Bearer ${login.body.token}`);

    expect(dashboard.status).toBe(200);
    expect(dashboard.body.datasetIds).toEqual([firstId, secondId]);
    expect(dashboard.body.profile.rowCount).toBe(6);

    const pluralAlias = await request(app)
      .get('/api/datasets')
      .set('Authorization', `Bearer ${login.body.token}`);

    expect(pluralAlias.status).toBe(200);
    expect(pluralAlias.body.some((dataset: { id: number }) => dataset.id === firstId)).toBe(true);
  });

  it('persists validated ML analyses and exports the exact saved run', async () => {
    const email = `analysis-${Date.now()}@enterprise.com`;
    await request(app).post('/api/register').send({ email, name: 'Analysis User', password: 'securePassword123' });
    const login = await request(app).post('/api/login').send({ email, password: 'securePassword123' });
    const authorization = `Bearer ${login.body.token}`;
    const csv = ['date,revenue'];
    for (let index = 1; index <= 10; index += 1) csv.push(`2026-01-${String(index).padStart(2, '0')},${index * 100}`);
    await request(app)
      .post('/api/upload')
      .set('Authorization', authorization)
      .attach('file', Buffer.from(csv.join('\n')), 'validated.csv');

    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/analyze')) {
        return new Response(JSON.stringify({
          dataset_type: 'time_series',
          feature_columns: ['date'],
          target_column: 'revenue',
          forecast: {
            type: 'forecast',
            confidence: 0.81,
            model: 'chronological holdout test model',
            metrics: { mae: 10, rmse: 12, r2: 0.9, smape: 4, train_rows: 8, test_rows: 2, validation_method: 'chronological_last_20_percent' },
            data: [{ row: 'T+1', predicted: 1100, lower: 1075, upper: 1125 }]
          },
          anomalies: { type: 'anomaly', confidence: 0.7, model: 'IsolationForest', metrics: { anomaly_count: 0 }, data: [] },
          segments: { type: 'segment', confidence: 0.7, model: 'KMeans', metrics: { segments: 2 }, data: [] },
          warnings: [],
          cached: false
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url as any);
    }));

    try {
      const analyzed = await request(app)
        .post('/api/ml/analyze')
        .set('Authorization', authorization)
        .send({ target_column: 'revenue', periods: 1 });
      expect(analyzed.status).toBe(200);
      expect(analyzed.body.analysisRunId).toMatch(/^analysis_/);
      expect(analyzed.body.forecast.metrics).toMatchObject({ train_rows: 8, test_rows: 2 });
      expect((await getUsage(login.body.organization.organization_id)).counters.ml_runs).toBe(1);

      const saved = await request(app)
        .get(`/api/ml/analyses/${analyzed.body.analysisRunId}`)
        .set('Authorization', authorization);
      const report = await request(app)
        .get(`/reports/download?type=analysis&analysisId=${encodeURIComponent(analyzed.body.analysisRunId)}`)
        .set('Authorization', authorization);
      expect(saved.status).toBe(200);
      expect(saved.body.forecast.data[0]).toMatchObject({ predicted: 1100, lower: 1075, upper: 1125 });
      expect(report.status).toBe(200);
      expect(report.headers['content-type']).toContain('text/csv');
      expect(report.text).toContain('chronological holdout test model');
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('refunds a reserved ML run when the model service fails', async () => {
    const email = `analysis-failure-${Date.now()}@enterprise.com`;
    await request(app).post('/api/register').send({ email, name: 'Analysis Failure', password: 'securePassword123' });
    const login = await request(app).post('/api/login').send({ email, password: 'securePassword123' });
    const authorization = `Bearer ${login.body.token}`;
    await request(app)
      .post('/api/upload')
      .set('Authorization', authorization)
      .attach('file', Buffer.from('date,revenue\n2026-01-01,100\n2026-01-02,120\n2026-01-03,140\n2026-01-04,160\n2026-01-05,180'), 'failure.csv');

    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/analyze')) return new Response('service unavailable', { status: 503 });
      return originalFetch(url as any);
    }));
    try {
      const response = await request(app)
        .post('/api/ml/analyze')
        .set('Authorization', authorization)
        .send({ target_column: 'revenue', periods: 2 });
      expect(response.status).toBe(502);
      expect(response.body.error).toMatchObject({
        code: 'ML_SERVICE_ERROR',
        message: 'ML servisi analizi tamamlayamadı.'
      });
      expect((await getUsage(login.body.organization.organization_id)).counters.ml_runs).toBe(0);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('ML forecast selects revenue target and returns non-zero predictions', async () => {
    await request(app)
      .post('/api/register')
      .send({
        email: 'forecast-user@enterprise.com',
        name: 'Forecast User',
        password: 'securePassword123'
      });

    const login = await request(app)
      .post('/api/login')
      .send({
        email: 'forecast-user@enterprise.com',
        password: 'securePassword123'
      });

    const csv = [
      'tarih,kategori,birim_fiyat,adet,ciro',
      '01/01/2026,A,"1.234,56",2,"2.469,12"',
      '2026-02-01,A,"1.300,00",2,"2.600,00"',
      '03/03/2026,B,"1.450,00",3,"4.350,00"',
      '2026-04-03,B,"1.600,00",3,"4.800,00"',
      '05/05/2026,C,"1.750,00",4,"7.000,00"'
    ].join('\n');
    await saveDataset('forecast-user@enterprise.com', 'forecast.csv', csv, 'none', 5, 5);

    const res = await request(app)
      .get('/api/ml/forecast')
      .set('Authorization', `Bearer ${login.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.targetColumn).toBe('ciro');
    expect(res.body.forecast.some((point: { predicted: number }) => point.predicted > 0)).toBe(true);
    expect(res.body.metrics.rmse).toBeGreaterThan(0);
    expect(res.body.debug.invalidDateRows).toBe(0);
  });

  it('ML forecast aggregates noisy daily revenue into a stronger forecast horizon', async () => {
    await request(app)
      .post('/api/register')
      .send({
        email: 'noisy-forecast-user@enterprise.com',
        name: 'Noisy Forecast User',
        password: 'securePassword123'
      });

    const login = await request(app)
      .post('/api/login')
      .send({
        email: 'noisy-forecast-user@enterprise.com',
        password: 'securePassword123'
      });

    const start = new Date(2026, 0, 1);
    const rows = ['tarih,toplam_tutar'];
    for (let index = 0; index < 120; index += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const dailyNoise = index % 2 === 0 ? 2600 : 400;
      const monthlyTrend = Math.floor(index / 30) * 120;
      rows.push(`${date.toISOString().slice(0, 10)},${dailyNoise + monthlyTrend}`);
    }

    await saveDataset('noisy-forecast-user@enterprise.com', 'noisy-forecast.csv', rows.join('\n'), 'none', 120, 2);

    const res = await request(app)
      .get('/api/ml/forecast')
      .set('Authorization', `Bearer ${login.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.targetColumn).toBe('toplam_tutar');
    expect(res.body.debug.aggregationPeriodDays).toBeGreaterThan(1);
    expect(res.body.accuracy).toBeGreaterThanOrEqual(70);
    expect(res.body.forecast[0].row).toMatch(/G\+1$/);
  });

  it('data profile does not average order IDs or dates', async () => {
    await request(app)
      .post('/api/register')
      .send({
        email: 'profile-user@enterprise.com',
        name: 'Profile User',
        password: 'securePassword123'
      });

    const login = await request(app)
      .post('/api/login')
      .send({
        email: 'profile-user@enterprise.com',
        password: 'securePassword123'
      });

    const csv = [
      'Siparis ID,Tarih,ciro',
      '1001,2026-01-01,1200',
      '1002,2026-01-02,1400',
      '1003,2026-01-03,1600'
    ].join('\n');
    await saveDataset('profile-user@enterprise.com', 'profile.csv', csv, 'none', 3, 3);

    const res = await request(app)
      .get('/api/dashboard/dynamic')
      .set('Authorization', `Bearer ${login.body.token}`);

    expect(res.status).toBe(200);
    const orderId = res.body.profile.columns.find((column: { name: string }) => column.name === 'Siparis ID');
    const date = res.body.profile.columns.find((column: { name: string }) => column.name === 'Tarih');
    const revenue = res.body.profile.columns.find((column: { name: string }) => column.name === 'ciro');
    expect(orderId).toMatchObject({ type: 'id', min: null, max: null, mean: null });
    expect(date).toMatchObject({ type: 'datetime', min: null, max: null, mean: null });
    expect(revenue).toMatchObject({ type: 'currency', min: 1200, max: 1600, mean: 1400 });
    expect(res.body.ml.forecast.targetColumn).toBe('ciro');
  });
});
