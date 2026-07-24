import { describe, expect, it } from 'vitest';
import { Dataset } from '../../lib/db';
import { combineDatasets, DatasetCompatibilityError } from './combined';
import { jsonToCsv } from './normalize';
import { inferColumnKind, parseCsv, toNumber } from '../ml/parser';

function dataset(id: number, filename: string, fileContent: string): Dataset {
  return {
    id,
    organization_id: 'org_test',
    email: 'test@example.com',
    filename,
    file_content: fileContent,
    warning: null,
    is_active: id === 1 ? 1 : 0,
    include_in_analysis: 1,
    source_type: 'file',
    source_ref: null,
    row_count: Math.max(0, parseCsv(fileContent).length - 1),
    column_count: parseCsv(fileContent)[0]?.length || 0,
    created_at: new Date(2026, 0, id).toISOString(),
    updated_at: new Date(2026, 0, id).toISOString()
  };
}

describe('tabular source normalization', () => {
  it('treats business identifiers and binary flags as dimensions rather than measures', () => {
    const kind = (header: string, values: string[]) => inferColumnKind(
      header,
      values,
      values.map(toNumber).filter((value): value is number => value !== null)
    );

    expect(kind('Sipariş No', ['1001', '1001', '1002'])).toBe('id');
    expect(kind('musteri_numarasi', ['42', '42', '51'])).toBe('id');
    expect(kind('Telefon', ['5320000000', '5330000000'])).toBe('id');
    expect(kind('aktif_mi', ['1', '0', '1'])).toBe('categorical');
    expect(kind('satış_adedi', ['2', '4', '8'])).toBe('numeric');
  });

  it('parses quoted multiline CSV cells without splitting the record', () => {
    const rows = parseCsv('name,note,value\nA,"iki\nsatır",10\nB,"tırnak ""test""",20');
    expect(rows).toEqual([
      ['name', 'note', 'value'],
      ['A', 'iki\nsatır', '10'],
      ['B', 'tırnak "test"', '20']
    ]);
  });

  it('normalizes common JSON envelope shapes into CSV', () => {
    const normalized = jsonToCsv(JSON.stringify({
      items: [
        { tarih: '2026-01-01', ciro: 120, bolge: 'A' },
        { tarih: '2026-01-02', ciro: 180, bolge: 'B' }
      ]
    }));
    expect(normalized).toMatchObject({ rowCount: 2, columnCount: 3 });
    expect(parseCsv(normalized.csv)).toEqual([
      ['tarih', 'ciro', 'bolge'],
      ['2026-01-01', '120', 'A'],
      ['2026-01-02', '180', 'B']
    ]);
  });

  it('merges compatible schemas case-insensitively and records source lineage', () => {
    const combined = combineDatasets([
      dataset(1, 'ocak.csv', 'Tarih,Ciro,Bölge\n2026-01-01,100,A'),
      dataset(2, 'subat.csv', 'tarih,ciro,bölge\n2026-02-01,200,B')
    ]);
    expect(combined?.row_count).toBe(2);
    expect(parseCsv(combined!.file_content)).toEqual([
      ['Tarih', 'Ciro', 'Bölge', 'kaynak_dosya'],
      ['2026-01-01', '100', 'A', 'ocak.csv'],
      ['2026-02-01', '200', 'B', 'subat.csv']
    ]);
  });

  it('merges related business sources that share dimensions but have different measures', () => {
    const combined = combineDatasets([
      dataset(1, 'eticaret.csv', 'siparis_id,tarih,kategori,urun_adi,bolge,satis_kanali,adet,birim_fiyat,toplam_tutar,musteri_memnuniyet_skoru,iade_edildi\n1,2026-01-01,A,Urun,A,Web,2,10,20,5,hayir'),
      dataset(2, 'satis.csv', 'IslemID,Tarih,Kategori,Bolge,Musteri_Skoru,Satis_Miktari,Kar_Orani\n2,2026-01-02,B,B,4,30,0.2')
    ]);

    expect(combined?.dataset_count).toBe(2);
    expect(combined?.row_count).toBe(2);
    expect(parseCsv(combined!.file_content)[0]).toEqual(expect.arrayContaining([
      'tarih', 'kategori', 'bolge', 'toplam_tutar', 'Satis_Miktari', 'kaynak_dosya'
    ]));
  });

  it('rejects unrelated schemas instead of silently producing misleading KPIs', () => {
    expect(() => combineDatasets([
      dataset(1, 'satis.csv', 'tarih,ciro,bolge\n2026-01-01,100,A'),
      dataset(2, 'personel.csv', 'calisan,departman,izin_gunu\nAyse,Finans,3')
    ])).toThrow(DatasetCompatibilityError);
  });
});
