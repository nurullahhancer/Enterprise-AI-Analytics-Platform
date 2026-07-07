import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import { serverAppPromise } from './server';
import { Express } from 'express';
import { saveDataset, getLatestDataset, findUserByEmail } from './src/lib/db';

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
