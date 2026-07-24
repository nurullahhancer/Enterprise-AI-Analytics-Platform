import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUserWithOrganization } from './db';
import {
  createKpiDefinition,
  deleteKpiDefinition,
  getKpiDefinition,
  listKpiDefinitionsWithLatest,
  listKpiEvaluationHistory,
  recordKpiEvaluation,
  updateKpiDefinition
} from './kpiDb';

afterEach(() => vi.unstubAllEnvs());

describe('tenant-scoped KPI persistence', () => {
  it('keeps definitions isolated, records transitions and applies history retention', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ownerEmail = `kpi-owner-${suffix}@example.com`;
    const otherEmail = `kpi-other-${suffix}@example.com`;
    const organizationId = await createUserWithOrganization(ownerEmail, 'KPI Owner', 'test-hash', { emailVerified: true });
    const otherOrganizationId = await createUserWithOrganization(otherEmail, 'KPI Other', 'test-hash', { emailVerified: true });

    const definition = await createKpiDefinition(organizationId, ownerEmail, {
      name: 'Net Gelir',
      description: 'Aylık net gelir toplamı',
      columnName: 'net_gelir',
      aggregation: 'sum',
      displayFormat: 'currency',
      thresholdType: 'minimum',
      thresholdValue: 100,
      enabled: true
    });

    expect(await getKpiDefinition(otherOrganizationId, definition.id)).toBeNull();
    expect((await listKpiDefinitionsWithLatest(organizationId))[0].latest).toBeNull();

    vi.stubEnv('KPI_EVALUATION_MAX_PER_KPI', '2');
    const first = await recordKpiEvaluation(organizationId, definition.id, ownerEmail, {
      value: 80,
      status: 'breach',
      rowCount: 4,
      message: 'Asgari eşik karşılanmadı.'
    });
    const second = await recordKpiEvaluation(organizationId, definition.id, ownerEmail, {
      value: 120,
      status: 'healthy',
      rowCount: 4,
      message: 'Asgari eşik karşılandı.'
    });
    await recordKpiEvaluation(organizationId, definition.id, ownerEmail, {
      value: null,
      status: 'unavailable',
      rowCount: 0,
      message: 'Kolon bulunamadı.'
    });

    expect(first.previous).toBeNull();
    expect(second.previous?.status).toBe('breach');
    const history = await listKpiEvaluationHistory(organizationId, definition.id, 30);
    expect(history).toHaveLength(2);
    expect(history.map((item) => item.status)).toEqual(['unavailable', 'healthy']);
    expect((await listKpiDefinitionsWithLatest(organizationId))[0].latest?.status).toBe('unavailable');

    const updated = await updateKpiDefinition(organizationId, definition.id, {
      name: 'Net Gelir Güncel',
      description: '',
      columnName: 'net_gelir',
      aggregation: 'average',
      displayFormat: 'number',
      thresholdType: 'none',
      thresholdValue: null,
      enabled: false
    });
    expect(updated).toMatchObject({ name: 'Net Gelir Güncel', thresholdValue: null, enabled: false });

    expect(await deleteKpiDefinition(organizationId, definition.id)).toBe(true);
    expect(await getKpiDefinition(organizationId, definition.id)).toBeNull();
    expect(await listKpiEvaluationHistory(organizationId, definition.id)).toEqual([]);
  });

  it('enforces a finite tenant-scoped definition limit and falls back safely for invalid configuration', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ownerEmail = `kpi-limit-${suffix}@example.com`;
    const otherEmail = `kpi-limit-other-${suffix}@example.com`;
    const organizationId = await createUserWithOrganization(ownerEmail, 'KPI Limit', 'test-hash', { emailVerified: true });
    const otherOrganizationId = await createUserWithOrganization(otherEmail, 'KPI Limit Other', 'test-hash', { emailVerified: true });
    const values = {
      name: 'Toplam Ciro',
      description: '',
      columnName: 'ciro',
      aggregation: 'sum' as const,
      displayFormat: 'currency' as const,
      thresholdType: 'none' as const,
      thresholdValue: null,
      enabled: true
    };

    vi.stubEnv('KPI_MAX_PER_ORG', '2');
    await createKpiDefinition(organizationId, ownerEmail, values);
    await createKpiDefinition(organizationId, ownerEmail, { ...values, name: 'Ortalama Ciro' });
    await expect(createKpiDefinition(organizationId, ownerEmail, { ...values, name: 'Azami Ciro' }))
      .rejects.toMatchObject({ status: 409, code: 'KPI_LIMIT_REACHED' });

    await expect(createKpiDefinition(otherOrganizationId, otherEmail, values)).resolves.toMatchObject({
      organizationId: otherOrganizationId
    });

    vi.stubEnv('KPI_MAX_PER_ORG', 'Infinity');
    await expect(createKpiDefinition(organizationId, ownerEmail, { ...values, name: 'Güvenli Varsayılan' }))
      .resolves.toMatchObject({ organizationId });
  });
});
