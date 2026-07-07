/**
 * CSV parsing and data-type utilities.
 * Extracted from server.ts for modularity.
 */

export function parseCsv(text: string): string[][] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const cells: string[] = [];
      let current = "";
      let quoted = false;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '"' && line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else if (char === '"') {
          quoted = !quoted;
        } else if (char === "," && !quoted) {
          cells.push(current.trim());
          current = "";
        } else {
          current += char;
        }
      }
      cells.push(current.trim());
      return cells;
    });
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

export function inferColumnKind(
  header: string,
  values: string[],
  numericValues: number[]
): ColumnKind {
  const normalizedHeader = header.toLowerCase();
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
  const idHint =
    /(^id$|[_\s-]?id$|^id[_\s-]|uuid|key|kod|code|email|mail|siparis\s*id|sipariş\s*id|order\s*id)/.test(
      normalizedHeader
    );

  if (idHint && uniqueCount >= Math.max(nonEmptyValues.length * 0.8, 1)) return "id";
  if (dateRatio >= 0.65) return "datetime";
  if (currencyHint && numericRatio >= 0.6) return "currency";
  if (numericRatio >= 0.7) return "numeric";
  if (uniqueCount <= Math.max(20, nonEmptyValues.length * 0.35)) return "categorical";
  return "text";
}
