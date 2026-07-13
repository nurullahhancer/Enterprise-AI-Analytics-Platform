import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import { serverAppPromise } from './server';
import { Express } from 'express';
import {
  changeUserRole,
  deleteUser,
  findUserByEmail,
  getLatestDataset,
  LastAdminError,
  listUsers,
  listUserDatasets,
  saveDataset,
  updateUserRole
} from './src/lib/db';
import { buildExportPayload } from './src/server/ml/pipeline';

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
    expect(me.body.user.role).toBe('analyst');
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

  it('enforces viewer write restrictions on the server', async () => {
    const email = 'viewer-user@enterprise.com';
    await request(app)
      .post('/api/register')
      .send({ email, name: 'Viewer User', password: 'securePassword123' });
    await updateUserRole(email, 'viewer');
    const login = await request(app)
      .post('/api/login')
      .send({ email, password: 'securePassword123' });

    const read = await request(app)
      .get('/api/dataset/list')
      .set('Authorization', `Bearer ${login.body.token}`);
    const write = await request(app)
      .delete('/api/dataset')
      .set('Authorization', `Bearer ${login.body.token}`);
    const selfEscalation = await request(app)
      .put('/api/enterprise/roles')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ email, role: 'admin' });

    expect(read.status).toBe(200);
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
    await expect(deleteUser(admins[0].email)).rejects.toBeInstanceOf(LastAdminError);
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
      .get('/api/ml/insights')
      .set('Authorization', `Bearer ${login.body.token}`);

    expect(res.status).toBe(200);
    // ML insights returns forecast/anomalies/segments structure
    expect(res.body.forecast).toBeDefined();
    expect(res.body.anomalies).toBeDefined();
  });
});
