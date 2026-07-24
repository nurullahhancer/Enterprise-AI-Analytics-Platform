export interface NormalizedTabularData {
  csv: string;
  rowCount: number;
  columnCount: number;
}

export function csvCell(value: unknown): string {
  const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
  if (text.length > 65_536) throw new Error('Bir veri hücresi izin verilen 65.536 karakter sınırını aşıyor.');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function recordsToCsv(
  input: unknown[],
  options: { maxRows?: number; maxColumns?: number } = {}
): NormalizedTabularData {
  const maxRows = Math.max(1, Math.min(options.maxRows || 10_000, 50_000));
  const maxColumns = Math.max(1, Math.min(options.maxColumns || 100, 500));
  if (input.length === 0) throw new Error('JSON kaynağında analiz edilecek kayıt bulunamadı.');
  if (input.length > maxRows) throw new Error(`JSON kaynağı en fazla ${maxRows.toLocaleString('tr-TR')} kayıt içerebilir.`);
  if (input.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('JSON verisi nesnelerden oluşan bir liste olmalıdır.');
  }

  const records = input as Array<Record<string, unknown>>;
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const rawHeader of Object.keys(record)) {
      const header = rawHeader.replace(/[\r\n\0]/g, ' ').trim();
      if (!header || seen.has(header)) continue;
      if (headers.length >= maxColumns) throw new Error(`JSON kaynağı en fazla ${maxColumns} kolon içerebilir.`);
      seen.add(header);
      headers.push(header);
    }
  }
  if (headers.length === 0) throw new Error('JSON kayıtlarında kolon bulunamadı.');

  return {
    csv: [
      headers.map(csvCell).join(','),
      ...records.map((record) => headers.map((header) => csvCell(record[header])).join(','))
    ].join('\n'),
    rowCount: records.length,
    columnCount: headers.length
  };
}

export function jsonValueToCsv(parsed: unknown): NormalizedTabularData {
  if (Array.isArray(parsed)) return recordsToCsv(parsed);
  if (!parsed || typeof parsed !== 'object') throw new Error('JSON kökü bir nesne veya nesne listesi olmalıdır.');

  const record = parsed as Record<string, unknown>;
  for (const key of ['data', 'items', 'results', 'records']) {
    if (Array.isArray(record[key])) return recordsToCsv(record[key] as unknown[]);
  }
  return recordsToCsv([record]);
}

export function jsonToCsv(content: string): NormalizedTabularData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('JSON dosyası geçerli bir JSON belgesi değil.');
  }

  return jsonValueToCsv(parsed);
}
