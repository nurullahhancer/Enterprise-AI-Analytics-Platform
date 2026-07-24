import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createUser,
  createUserWithOrganization,
  listAuditLogs,
  listNotifications,
  saveUserDataset
} from '../../lib/db';
import { acceptInvitation, createInvitation } from '../../lib/saasDb';
import { AuthenticatedRequest } from '../index';
import kpiRouter from './kpis';

describe('KPI route lifecycle', () => {
  const app = express();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ownerEmail = `kpi-route-${suffix}@example.com`;
  const analystEmail = `kpi-route-analyst-${suffix}@example.com`;
  let organizationId = '';

  beforeAll(async () => {
    organizationId = await createUserWithOrganization(ownerEmail, 'KPI Route Owner', 'test-hash', { emailVerified: true });
    await createUser(analystEmail, 'KPI Route Analyst', 'test-hash', 'analyst', true);
    const invitationHash = `kpi-invitation-${suffix}`;
    await createInvitation(
      organizationId,
      analystEmail,
      'analyst',
      ownerEmail,
      invitationHash,
      new Date(Date.now() + 60_000)
    );
    await acceptInvitation(invitationHash, analystEmail);
    await saveUserDataset(
      organizationId,
      'satis.csv',
      'tarih,ciro,bolge\n2026-01-01,10,Kuzey\n2026-01-02,20,Güney',
      '',
      2,
      3,
      ownerEmail
    );

    app.use(express.json());
    app.use((req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
      const requestedRole = req.headers['x-test-role'];
      const role = requestedRole === 'viewer' || requestedRole === 'analyst' ? requestedRole : 'admin';
      const email = role === 'analyst' ? analystEmail : ownerEmail;
      req.user = { email, name: role === 'analyst' ? 'KPI Route Analyst' : 'KPI Route Owner', role, token_version: 0 };
      req.organization = {
        organization_id: organizationId,
        organization_name: 'KPI Test',
        organization_slug: 'kpi-test',
        plan_key: 'starter'
      };
      next();
    });
    app.use('/api/kpis', kpiRouter);
    app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: { code: 'TEST_ERROR', message: error.message } });
    });
  });

  it('enforces roles and persists breach/recovery evaluations with audit and notifications', async () => {
    const columns = await request(app).get('/api/kpis/columns').set('x-test-role', 'viewer');
    expect(columns.status).toBe(200);
    expect(columns.body).toMatchObject({
      dataset: { filename: 'satis.csv', rowCount: 2 },
      allColumns: ['tarih', 'ciro', 'bolge', 'kaynak_dosya']
    });
    expect(columns.body.numericColumns).toContainEqual({ name: 'ciro', nonEmptyCount: 2 });

    const forbidden = await request(app)
      .post('/api/kpis')
      .set('x-test-role', 'viewer')
      .send({ name: 'Ciro', columnName: 'ciro', aggregation: 'sum' });
    expect(forbidden.status).toBe(403);

    const invalid = await request(app)
      .post('/api/kpis')
      .send({
        name: 'Ciro',
        columnName: 'ciro',
        aggregation: 'sum',
        thresholdType: 'minimum',
        thresholdValue: '40'
      });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_KPI');

    const created = await request(app)
      .post('/api/kpis')
      .set('x-test-role', 'analyst')
      .send({
        name: 'Toplam Ciro',
        description: 'Satışların toplamı',
        columnName: 'CİRO',
        aggregation: 'sum',
        displayFormat: 'currency',
        thresholdType: 'minimum',
        thresholdValue: 40,
        enabled: true
      });
    expect(created.status).toBe(201);
    const id = created.body.item.id as string;

    const forbiddenEvaluation = await request(app)
      .post('/api/kpis/evaluate')
      .set('x-test-role', 'viewer')
      .send({ id });
    expect(forbiddenEvaluation.status).toBe(403);
    expect((await request(app).get(`/api/kpis/${id}/history`).set('x-test-role', 'viewer')).body.items).toEqual([]);

    const breach = await request(app)
      .post('/api/kpis/evaluate')
      .set('x-test-role', 'analyst')
      .send({ id });
    expect(breach.status).toBe(200);
    expect(breach.body.items[0].evaluation).toMatchObject({ value: 30, status: 'breach', rowCount: 2 });
    expect(await listNotifications(organizationId, ownerEmail)).toHaveLength(1);
    expect(await listNotifications(organizationId, analystEmail)).toHaveLength(0);

    const updated = await request(app)
      .patch(`/api/kpis/${id}`)
      .send({ thresholdValue: 20 });
    expect(updated.status).toBe(200);
    expect(updated.body.item.thresholdValue).toBe(20);

    const recovered = await request(app)
      .post('/api/kpis/evaluate')
      .set('x-test-role', 'analyst')
      .send({ id });
    expect(recovered.status).toBe(200);
    expect(recovered.body.items[0].evaluation.status).toBe('healthy');
    expect((await listNotifications(organizationId, ownerEmail)).map((item) => item.title))
      .toEqual(['KPI Yeniden Sağlıklı', 'KPI Eşik Uyarısı']);
    expect(await listNotifications(organizationId, analystEmail)).toHaveLength(0);

    const history = await request(app).get(`/api/kpis/${id}/history?limit=30`).set('x-test-role', 'viewer');
    const listed = await request(app).get('/api/kpis').set('x-test-role', 'viewer');
    expect(history.body.items.map((item: { status: string }) => item.status)).toEqual(['healthy', 'breach']);
    expect(listed.body.items[0].latest.status).toBe('healthy');

    const actions = (await listAuditLogs(organizationId)).map((item) => item.action);
    expect(actions).toEqual(expect.arrayContaining(['KPI Created', 'KPI Updated', 'KPI Evaluated']));

    const deleted = await request(app).delete(`/api/kpis/${id}`);
    expect(deleted.status).toBe(200);
    expect((await request(app).get('/api/kpis')).body.items).toEqual([]);
  });
});
