import { describe, expect, it, vi } from 'vitest';
import { KpiDefinition } from '../../lib/kpiDb';
import {
  evaluateKpiDefinition,
  inspectKpiColumns,
  prepareKpiDataset
} from './engine';

function definition(overrides: Partial<KpiDefinition> = {}): KpiDefinition {
  return {
    id: 'kpi_test',
    organizationId: 'org_test',
    createdBy: 'analyst@example.com',
    name: 'Aylık Ciro',
    description: '',
    columnName: 'Ciro',
    aggregation: 'sum',
    displayFormat: 'currency',
    thresholdType: 'none',
    thresholdValue: null,
    enabled: true,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides
  };
}

describe('KPI calculation engine', () => {
  it('matches normalized Turkish headers and parses quoted multiline CSV safely', () => {
    const dataset = prepareKpiDataset(
      'BÖLGE,CİRO,Açıklama\nKuzey,"1.250,50","iki\nsatır"\nGüney,"749,50",normal'
    );
    const result = evaluateKpiDefinition(definition({ columnName: 'ciro' }), dataset);

    expect(dataset.rows).toHaveLength(2);
    expect(result).toMatchObject({ value: 2000, rowCount: 2, status: 'healthy' });
  });

  it('computes average, min and max from numeric values and reports ignored cells', () => {
    const dataset = prepareKpiDataset('value\n10\n20\ngeçersiz\n40');

    expect(evaluateKpiDefinition(definition({ columnName: 'VALUE', aggregation: 'average' }), dataset))
      .toMatchObject({ value: 70 / 3, rowCount: 3 });
    expect(evaluateKpiDefinition(definition({ columnName: 'value', aggregation: 'min' }), dataset).value).toBe(10);
    expect(evaluateKpiDefinition(definition({ columnName: 'value', aggregation: 'max' }), dataset).value).toBe(40);
    expect(evaluateKpiDefinition(definition({ columnName: 'value' }), dataset).message).toContain('1 sayısal olmayan');
  });

  it('reduces min and max values without spreading the full dataset into Math functions', () => {
    const dataset = prepareKpiDataset('value\n10\n20\n5\n40');
    const minSpy = vi.spyOn(Math, 'min').mockImplementation(() => {
      throw new Error('Math.min must not receive the full KPI dataset.');
    });
    const maxSpy = vi.spyOn(Math, 'max').mockImplementation(() => {
      throw new Error('Math.max must not receive the full KPI dataset.');
    });

    try {
      expect(evaluateKpiDefinition(definition({ columnName: 'value', aggregation: 'min' }), dataset).value).toBe(5);
      expect(evaluateKpiDefinition(definition({ columnName: 'value', aggregation: 'max' }), dataset).value).toBe(40);
    } finally {
      minSpy.mockRestore();
      maxSpy.mockRestore();
    }
  });

  it('counts only non-empty cells, including non-numeric values', () => {
    const dataset = prepareKpiDataset('müşteri,segment\nA,Kurumsal\nB,\nC,Bireysel');
    const result = evaluateKpiDefinition(definition({
      columnName: 'segment',
      aggregation: 'count',
      displayFormat: 'number'
    }), dataset);

    expect(result).toMatchObject({ value: 2, rowCount: 2, status: 'healthy' });
  });

  it('never averages or sums business identifier columns', () => {
    const dataset = prepareKpiDataset('Sipariş No,ciro\n1001,100\n1001,120\n1002,140');

    expect(evaluateKpiDefinition(definition({ columnName: 'Sipariş No', aggregation: 'average' }), dataset))
      .toMatchObject({ value: null, status: 'unavailable' });
    expect(evaluateKpiDefinition(definition({ columnName: 'Sipariş No', aggregation: 'sum' }), dataset).message)
      .toContain('kimlik/referans');
    expect(evaluateKpiDefinition(definition({ columnName: 'Sipariş No', aggregation: 'count' }), dataset))
      .toMatchObject({ value: 3, status: 'healthy' });
  });

  it('applies inclusive minimum and maximum thresholds in the correct direction', () => {
    const dataset = prepareKpiDataset('value\n10\n20');
    const minimumEqual = evaluateKpiDefinition(definition({
      columnName: 'value',
      thresholdType: 'minimum',
      thresholdValue: 30
    }), dataset);
    const maximumBreach = evaluateKpiDefinition(definition({
      columnName: 'value',
      thresholdType: 'maximum',
      thresholdValue: 29
    }), dataset);

    expect(minimumEqual.status).toBe('healthy');
    expect(maximumBreach.status).toBe('breach');
  });

  it('returns unavailable instead of a fabricated zero for missing or non-numeric columns', () => {
    const dataset = prepareKpiDataset('kategori,tutar\nA,bilinmiyor\nB,yok');

    expect(evaluateKpiDefinition(definition({ columnName: 'olmayan' }), dataset))
      .toMatchObject({ value: null, rowCount: 0, status: 'unavailable' });
    expect(evaluateKpiDefinition(definition({ columnName: 'tutar' }), dataset))
      .toMatchObject({ value: null, rowCount: 0, status: 'unavailable' });
  });

  it('classifies numeric column candidates using non-empty coverage', () => {
    const inspected = inspectKpiColumns(prepareKpiDataset(
      'tarih,Sipariş No,ciro,segment,karışık\n2026-01-01,1001,100,A,1\n2026-01-02,1001,200,B,x\n2026-01-03,1002,,C,2'
    ));

    expect(inspected.allColumns).toEqual(['tarih', 'Sipariş No', 'ciro', 'segment', 'karışık']);
    expect(inspected.numericColumns).toEqual([{ name: 'ciro', nonEmptyCount: 2 }]);
  });
});
