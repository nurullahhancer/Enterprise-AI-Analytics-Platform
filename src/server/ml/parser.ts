/**
 * CSV parsing and data-type utilities.
 * Extracted from server.ts for modularity.
 */

export function parseCsv(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  const finishRow = () => {
    row.push(cell.trim());
    if (row.some((value) => value.length > 0)) rows.push(row);
    row = [];
    cell = '';
  };

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '"') {
      if (quoted && normalized[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if (character === '\n' && !quoted) {
      finishRow();
    } else {
      cell += character;
    }
  }

  if (quoted) throw new Error('CSV dosyasında kapanmamış bir tırnak işareti var.');
  if (cell.length > 0 || row.length > 0) finishRow();
  return rows;
}

export function toNumber(value: string | number | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!value) return null;
  let normalized = value
    .trim()
    .replace(/[₺$€£%\s\u00A0']/g, "")
    .replace(/[^0-9,.\-]/g, "");

  if (!normalized || normalized === "-" || normalized === "," || normalized === ".") return null;

  const commaIndex = normalized.lastIndexOf(",");
  const dotIndex = normalized.lastIndexOf(".");
  if (commaIndex >= 0 && dotIndex >= 0) {
    const decimalSeparator = commaIndex > dotIndex ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    normalized = normalized
      .replace(new RegExp(`\\${thousandsSeparator}`, "g"), "")
      .replace(decimalSeparator, ".");
  } else if (commaIndex >= 0) {
    const parts = normalized.split(",");
    normalized =
      parts.length > 2 || parts.at(-1)?.length === 3
        ? parts.join("")
        : normalized.replace(",", ".");
  } else if (dotIndex >= 0) {
    const parts = normalized.split(".");
    normalized =
      parts.length > 2 || parts.at(-1)?.length === 3 ? parts.join("") : normalized;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeLabel(value: string): string {
  return value
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function findColumn(headers: string[], candidates: string[]): number {
  const normalizedHeaders = headers.map(normalizeLabel);
  return normalizedHeaders.findIndex((header) =>
    candidates.some((candidate) => header.includes(normalizeLabel(candidate)))
  );
}

export function parseFlexibleDate(value: string | undefined): Date | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;

  if (!Number.isNaN(Number(raw))) {
    if (raw.length < 10) return null;
  }

  const iso = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (iso) {
    const date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const local = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (local) {
    const first = Number(local[1]);
    const second = Number(local[2]);
    const year = Number(local[3].length === 2 ? `20${local[3]}` : local[3]);
    const day = first > 12 ? first : second > 12 ? second : first;
    const month = first > 12 ? second : second > 12 ? first : second;
    const date = new Date(year, month - 1, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

export function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export type ColumnKind = "numeric" | "categorical" | "datetime" | "currency" | "text" | "id";

export function isIdentifierHeader(header: string): boolean {
  const name = normalizeLabel(header);
  if (!name) return false;
  return (
    /(^| )(id|uuid|guid|key|sku|ean|iban)( |$)/.test(name) ||
    /(^| )(kod|kodu|code|ref|referans|barkod|barcode|email|mail|telefon|phone|gsm|zip)( |$)/.test(name) ||
    /(posta kodu|postal code|tc kimlik|vergi no|vergi numarasi|tax no|tax number)/.test(name) ||
    /(siparis|order|fatura|invoice|musteri|customer|urun|product|stok|stock|islem|transaction|kayit|record|personel|employee|calisan) (no|numara|numarasi|number)$/.test(name)
  );
}

export function inferColumnKind(
  header: string,
  values: string[],
  numericValues: number[]
): ColumnKind {
  const normalizedHeader = normalizeLabel(header);
  const nonEmptyValues = values.filter((v) => v.trim().length > 0);
  const uniqueCount = new Set(nonEmptyValues).size;
  const dateCount = nonEmptyValues.filter((v) => {
    const trimmed = v.trim();
    if (!Number.isNaN(Number(trimmed))) return trimmed.length >= 10;
    return !Number.isNaN(Date.parse(trimmed));
  }).length;
  const numericRatio =
    nonEmptyValues.length === 0 ? 0 : numericValues.length / nonEmptyValues.length;
  const dateRatio = nonEmptyValues.length === 0 ? 0 : dateCount / nonEmptyValues.length;
  const currencyHint =
    /ciro|gelir|revenue|sales|amount|tutar|cost|maliyet|price|fiyat|₺|\$|eur|usd/.test(
      normalizedHeader
    );
  const idHint = isIdentifierHeader(header);
  const normalizedValues = new Set(nonEmptyValues.map(normalizeLabel));
  const booleanValues = normalizedValues.size > 0 && [...normalizedValues].every((value) =>
    ['0', '1', 'true', 'false', 'yes', 'no', 'evet', 'hayir'].includes(value)
  );

  // Business identifiers remain identifiers even when they repeat (for example,
  // one order ID appearing on multiple line items). They are never measures.
  if (idHint) return "id";
  if (dateRatio >= 0.65) return "datetime";
  if (booleanValues) return "categorical";
  if (currencyHint && numericRatio >= 0.6) return "currency";
  if (numericRatio >= 0.7) return "numeric";
  if (uniqueCount <= Math.max(20, nonEmptyValues.length * 0.35)) return "categorical";
  return "text";
}
