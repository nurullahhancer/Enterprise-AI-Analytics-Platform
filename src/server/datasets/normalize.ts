import ExcelJS from 'exceljs';

export interface NormalizedTabularData {
  csv: string;
  rowCount: number;
  columnCount: number;
}

const DEFAULT_MAX_ROWS = 50_000;
const DEFAULT_MAX_COLUMNS = 500;
const MAX_ZIP_ENTRIES = 2_048;
const MAX_ZIP_UNCOMPRESSED_BYTES = 150 * 1024 * 1024;
const MAX_ZIP_COMPRESSION_RATIO = 100;

function neutralizeSpreadsheetFormula(value: string): string {
  return /^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value;
}

export function csvCell(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const raw = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
  if (raw.length > 65_536) throw new Error('Bir veri hücresi izin verilen 65.536 karakter sınırını aşıyor.');
  const text = typeof value === 'string' ? neutralizeSpreadsheetFormula(raw) : raw;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function recordsToCsv(
  input: unknown[],
  options: { maxRows?: number; maxColumns?: number; sourceLabel?: string } = {}
): NormalizedTabularData {
  const sourceLabel = options.sourceLabel || 'JSON';
  const maxRows = Math.max(1, Math.min(options.maxRows || DEFAULT_MAX_ROWS, DEFAULT_MAX_ROWS));
  const maxColumns = Math.max(1, Math.min(options.maxColumns || DEFAULT_MAX_COLUMNS, DEFAULT_MAX_COLUMNS));
  if (input.length === 0) throw new Error(`${sourceLabel} kaynağında analiz edilecek kayıt bulunamadı.`);
  if (input.length > maxRows) throw new Error(`${sourceLabel} kaynağı en fazla ${maxRows.toLocaleString('tr-TR')} kayıt içerebilir.`);
  if (input.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error(`${sourceLabel} verisi nesnelerden oluşan bir liste olmalıdır.`);
  }

  const records = input as Array<Record<string, unknown>>;
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const rawHeader of Object.keys(record)) {
      const header = rawHeader.replace(/[\r\n\0]/g, ' ').trim();
      if (!header || seen.has(header)) continue;
      if (headers.length >= maxColumns) throw new Error(`${sourceLabel} kaynağı en fazla ${maxColumns} kolon içerebilir.`);
      seen.add(header);
      headers.push(header);
    }
  }
  if (headers.length === 0) throw new Error(`${sourceLabel} kayıtlarında kolon bulunamadı.`);

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
  if (Array.isArray(parsed)) return recordsToCsv(parsed, { sourceLabel: 'JSON' });
  if (!parsed || typeof parsed !== 'object') throw new Error('JSON kökü bir nesne veya nesne listesi olmalıdır.');
  const record = parsed as Record<string, unknown>;
  for (const key of ['data', 'items', 'results', 'records']) {
    if (Array.isArray(record[key])) return recordsToCsv(record[key] as unknown[], { sourceLabel: 'JSON' });
  }
  return recordsToCsv([record], { sourceLabel: 'JSON' });
}

export function jsonToCsv(content: string): NormalizedTabularData {
  try {
    return jsonValueToCsv(JSON.parse(content));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('JSON dosyası geçerli bir JSON belgesi değil.');
    throw error;
  }
}

function validateXlsxArchive(buffer: Buffer): void {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('Dosya uzantısı XLSX olsa da içerik geçerli bir XLSX arşivi değil.');
  }
  const searchStart = Math.max(0, buffer.length - 65_557);
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('XLSX merkez dizini bulunamadı.');
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);
  if (entryCount < 1 || entryCount > MAX_ZIP_ENTRIES) throw new Error('XLSX arşivi güvenli dosya sayısı sınırını aşıyor.');

  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('XLSX merkez dizini bozuk.');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) throw new Error('XLSX dosya adı alanı bozuk.');
    const name = buffer.subarray(nameStart, nameEnd).toString('utf8').replace(/\\/g, '/');
    if ((flags & 0x1) !== 0) throw new Error('Şifreli XLSX dosyaları desteklenmiyor.');
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('XLSX arşivinde güvenli olmayan dosya yolu var.');
    if (/vbaproject\.bin|macrosheets|xlm/i.test(name)) throw new Error('Makro içeren Excel dosyaları kabul edilmiyor.');
    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    offset = nameEnd + extraLength + commentLength;
  }
  const ratio = totalUncompressed / Math.max(totalCompressed, 1);
  if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES || ratio > MAX_ZIP_COMPRESSION_RATIO) {
    throw new Error('XLSX arşivi güvenli açılmış boyut veya sıkıştırma oranı sınırını aşıyor.');
  }
}

function excelCellValue(cell: ExcelJS.Cell): unknown {
  const value = cell.value;
  if (value && typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) throw new Error('Excel formülleri güvenlik nedeniyle kabul edilmiyor.');
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
    if ('text' in value && typeof value.text === 'string') return value.text;
    if (value instanceof Date) return value;
  }
  return value;
}

export async function excelBufferToCsv(
  buffer: Buffer,
  options: { maxRows?: number; maxColumns?: number } = {}
): Promise<NormalizedTabularData> {
  validateXlsxArchive(buffer);
  const maxRows = Math.max(1, Math.min(options.maxRows || DEFAULT_MAX_ROWS, DEFAULT_MAX_ROWS));
  const maxColumns = Math.max(1, Math.min(options.maxColumns || DEFAULT_MAX_COLUMNS, DEFAULT_MAX_COLUMNS));
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new Error('Excel dosyası okunamadı. Lütfen geçerli ve şifresiz bir .xlsx dosyası yükleyin.');
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error('Excel dosyasında çalışma sayfası bulunamadı.');
  if (worksheet.rowCount - 1 > maxRows) throw new Error(`Excel kaynağı en fazla ${maxRows.toLocaleString('tr-TR')} kayıt içerebilir.`);
  if (worksheet.columnCount > maxColumns) throw new Error(`Excel kaynağı en fazla ${maxColumns} kolon içerebilir.`);

  const headers: string[] = [];
  const seen = new Set<string>();
  for (let column = 1; column <= worksheet.columnCount; column += 1) {
    const header = String(excelCellValue(worksheet.getCell(1, column)) ?? '').replace(/[\r\n\0]/g, ' ').trim();
    if (!header) throw new Error('Excel başlık satırında boş kolon adı bulunuyor.');
    if (seen.has(header)) throw new Error(`Excel başlık satırında yinelenen kolon adı var: ${header}`);
    seen.add(header);
    headers.push(header);
  }
  const records: Array<Record<string, unknown>> = [];
  for (let row = 2; row <= worksheet.rowCount; row += 1) {
    const record = Object.fromEntries(headers.map((header, index) => [header, excelCellValue(worksheet.getCell(row, index + 1))]));
    if (Object.values(record).some((value) => value !== null && value !== '')) records.push(record);
  }
  return recordsToCsv(records, { maxRows, maxColumns, sourceLabel: 'Excel' });
}
