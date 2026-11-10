/**
 * What a camera or a hand scanner read, turned into the code the registry is searched by, and the
 * code a printed label carries. Both directions live here so that a label this product prints is
 * always a label this product reads: `normalizeScan(animalLabelCode(a))` is the code that finds `a`.
 *
 * Nothing here guesses. A scan either becomes one code or it is null, and matching is exact apart
 * from letter case and spaces, which differ between a tag as printed and a tag as typed.
 */

/** The longest code the API accepts for a tag, an identifier or a barcode. */
export const SCAN_CODE_MAX = 60;

/** Query parameters a label on a web address may carry its code in, in order of preference. */
const URL_CODE_PARAMS = ['code', 'tag', 'id'];

/** AIM symbology prefix some hand scanners put in front of the data: "]C1", "]Q3", "]E0". */
const AIM_PREFIX = /^\][A-Za-z][0-9A-Za-z]/;

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The code inside a web address: a `code`, `tag` or `id` parameter, else the last part of the path.
 * Read by hand, because this package runs where there is no URL class.
 */
function codeFromUrl(text: string): string | null {
  const parts = /^https?:\/\/[^/?#]*([^?#]*)(?:\?([^#]*))?/i.exec(text);
  if (!parts) return null;
  const [, path, query = ''] = parts;
  const params = query
    .split('&')
    .filter(Boolean)
    .map((pair): [string, string] => {
      const at = pair.indexOf('=');
      return at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
    });
  for (const name of URL_CODE_PARAMS) {
    for (const [key, value] of params) {
      const decoded = safeDecode(value.replace(/\+/g, ' ')).trim();
      if (safeDecode(key).toLowerCase() === name && decoded) return decoded;
    }
  }
  const segments = path.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  return last ? safeDecode(last) : null;
}

function clean(text: string): string {
  return text
    .replace(/^﻿/, '')
    // Control characters: a scanner's trailing Enter or Tab, a GS1 group separator.
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The code in a scan, or null when there is none. Letter case is kept as read: comparison ignores
 * it (`scanKey`), but what the person sees stays what the label says.
 *
 * Labels printed here carry the bare code. A tag bought elsewhere may carry a web address such as
 * `https://example.uz/t/UZ-0042` or `...?tag=UZ-0042`: the code is taken out of it.
 */
export function normalizeScan(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let text = clean(raw).replace(AIM_PREFIX, '').trim();
  if (/^https?:\/\//i.test(text)) {
    const inner = codeFromUrl(text);
    if (inner === null) return null;
    text = clean(inner);
  }
  if (!text || text.length > SCAN_CODE_MAX) return null;
  return text;
}

/** Two codes are the same code when their keys are equal: letter case and spaces do not count. */
export function scanKey(code: string): string {
  return code.replace(/\s+/g, '').toUpperCase();
}

/**
 * The keys a scanned code may be stored under. A 12-digit UPC-A is the same number as the EAN-13
 * with a zero in front, and scanners disagree on which one they report.
 */
export function scanKeyVariants(code: string): string[] {
  const key = scanKey(code);
  if (!key) return [];
  if (/^\d{12}$/.test(key)) return [key, `0${key}`];
  if (/^0\d{12}$/.test(key)) return [key, key.slice(1)];
  return [key];
}

/**
 * What an animal's printed tag encodes. One rule: the animal's own QR identifier when it has an
 * active one, because that is what is already hanging on its ear; otherwise its ear tag number,
 * which is unique in the registry, short enough for a small code, and can be typed when the
 * print is torn. The record id is never printed: nobody can type it.
 */
export function animalLabelCode(animal: { tag: string; qr?: string | null }): string {
  const own = animal.qr ? normalizeScan(animal.qr) : null;
  return own ?? normalizeScan(animal.tag) ?? animal.tag.trim();
}

/**
 * What a stock item's printed label encodes: its barcode, else its own code (SKU), else its record
 * id, which every item has. The item lookup matches the same three, in the same order.
 */
export function itemLabelCode(item: { id: string; sku?: string | null; barcode?: string | null }): string {
  return (item.barcode ? normalizeScan(item.barcode) : null) ?? (item.sku ? normalizeScan(item.sku) : null) ?? item.id;
}

export interface CodeCandidate<T> {
  /** The stored value: a tag, an identifier or a barcode. */
  value: string;
  item: T;
}

/**
 * Exact matching, in one place for the server and the browser. A candidate matches when its key
 * equals one of the scan's keys. When some candidates match letter for letter, only those are
 * returned; otherwise every tolerant match is, so two animals with "ya-1" and "YA-1" are both
 * offered rather than one of them picked silently. Each item appears once.
 */
export function matchScan<T>(code: string, candidates: readonly CodeCandidate<T>[]): { item: T; value: string; exact: boolean }[] {
  const keys = new Set(scanKeyVariants(code));
  if (keys.size === 0) return [];
  const tolerant = candidates.filter((c) => keys.has(scanKey(c.value)));
  const exact = tolerant.filter((c) => c.value === code);
  const chosen = exact.length > 0 ? exact : tolerant;
  const seen = new Set<T>();
  const out: { item: T; value: string; exact: boolean }[] = [];
  for (const c of chosen) {
    if (seen.has(c.item)) continue;
    seen.add(c.item);
    out.push({ item: c.item, value: c.value, exact: c.value === code });
  }
  return out;
}
