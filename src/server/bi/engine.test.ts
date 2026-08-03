import { describe, it, expect } from 'vitest';
import { BIEngine } from './engine';

describe('BIEngine Evaluation', () => {
  it('should trigger CRITICAL risk when inventory days < 7', () => {
    const result = BIEngine.evaluate({
      skuInventory: [
        { sku: 'SKU-101', name: 'Kablosuz Kulaklık', stockDays: 4, stockQty: 20, dailyVelocity: 5 },
      ],
    });

    expect(result.riskSignals.length).toBe(1);
    expect(result.riskSignals[0].severity).toBe('CRITICAL');
    expect(result.riskSignals[0].conditionTriggered).toBe('stok_günü < 7');
    expect(result.riskSignals[0].actionRequired).toContain('Tedarikçiye acil');
  });

  it('should trigger CRITICAL risk when ROAS < 2.0', () => {
    const result = BIEngine.evaluate({
      roas: 1.4,
    });

    expect(result.riskSignals.length).toBe(1);
    expect(result.riskSignals[0].severity).toBe('CRITICAL');
    expect(result.riskSignals[0].category).toBe('MARKETING_ROAS');
  });

  it('should trigger CRITICAL risk when return rate > 8%', () => {
    const result = BIEngine.evaluate({
      returnRatePct: 0.11, // 11%
    });

    expect(result.riskSignals.length).toBe(1);
    expect(result.riskSignals[0].severity).toBe('CRITICAL');
    expect(result.riskSignals[0].category).toBe('RETURNS_QUALITY');
  });

  it('should trigger CRITICAL risk when cash flow is negative', () => {
    const result = BIEngine.evaluate({
      cashFlow30dForecast: -125000,
    });

    expect(result.riskSignals.length).toBe(1);
    expect(result.riskSignals[0].severity).toBe('CRITICAL');
    expect(result.riskSignals[0].category).toBe('CASH_FLOW');
  });

  it('should generate opportunity signals when ROAS is high', () => {
    const result = BIEngine.evaluate({
      roas: 4.5,
      salesGrowthVsLastWeekPct: 15,
    });

    expect(result.opportunitySignals.length).toBe(2);
    expect(result.overallHealthStatus).toBe('EXCELLENT');
  });
});
