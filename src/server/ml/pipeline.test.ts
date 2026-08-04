import { describe, expect, it } from 'vitest';
import { extractNlpComplaints } from './pipeline';

describe('extractNlpComplaints', () => {
  it('returns hasComments: false when dataset has no text/comment columns', () => {
    const csvData = `tarih,ciro,maliyet\n2026-01-01,100,50\n2026-01-02,120,60`;
    const result = extractNlpComplaints(csvData);
    expect(result.hasComments).toBe(false);
    expect(result.totalComments).toBe(0);
    expect(result.topComplaint).toBeNull();
    expect(result.clusters).toEqual([]);
  });

  it('dynamically extracts and categorizes comments from a comment dataset', () => {
    const csvData = `musteri_id,gorus_ve_yorumlar\n101,Kargo cok gec geldi kurye paket getirmedi\n102,Beden dar geldi degisim istiyorum\n103,Kutu ezik ve ambalaj yirtik geldi\n104,Kargo teslimat suresi cok uzundu`;
    const result = extractNlpComplaints(csvData);

    expect(result.hasComments).toBe(true);
    expect(result.totalComments).toBe(4);
    expect(result.columnHeader).toBe('gorus_ve_yorumlar');
    expect(result.topComplaint?.topic).toBe('Kargo ve Teslimat Gecikmesi');
    expect(result.topComplaint?.count).toBe(2);
    expect(result.topComplaint?.percentage).toBe(50.0);
  });
});
