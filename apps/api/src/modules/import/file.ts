/**
 * Turning an uploaded file into rows of cells. Excel and CSV both end up as the same shape, so
 * everything after this point does not care where the data came from.
 */
import ExcelJS from 'exceljs';
import { badRequest } from '../../core/errors';
import { cellText, matchKey, type Cell } from './values';

export interface Sheet {
  name: string;
  /** Sparse by column index, 0-based. `number` is the row number the person sees in Excel. */
  rows: { number: number; cells: Cell[] }[];
}

/** Rows scanned to find the header. People put a title above the table. */
export const HEADER_SCAN_ROWS = 15;
/** Sheets of our own template that never hold data. */
export const LISTS_SHEET = 'Lists';

const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

const startsWith = (body: Buffer, ...bytes: number[]) => bytes.every((b, i) => body[i] === b);

/**
 * A small .xlsx can unpack to gigabytes. The zip directory declares the unpacked sizes, so check
 * them before handing the file to a parser that holds everything in memory.
 */
function assertReasonableZip(body: Buffer): void {
  const END_OF_DIRECTORY = 0x06054b50;
  const ENTRY = 0x02014b50;
  const searchFrom = Math.max(0, body.length - 66_000);
  let end = -1;
  for (let i = body.length - 22; i >= searchFrom; i--) {
    if (body.readUInt32LE(i) === END_OF_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) throw badRequest('NOT_A_SPREADSHEET', 'This file is not an Excel workbook');

  const entries = body.readUInt16LE(end + 10);
  let offset = body.readUInt32LE(end + 16);
  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > body.length || body.readUInt32LE(offset) !== ENTRY) {
      throw badRequest('NOT_A_SPREADSHEET', 'This file is not an Excel workbook');
    }
    total += body.readUInt32LE(offset + 24);
    if (total > MAX_UNCOMPRESSED_BYTES) throw badRequest('FILE_TOO_COMPLEX', 'This workbook is too large to read');
    offset += 46 + body.readUInt16LE(offset + 28) + body.readUInt16LE(offset + 30) + body.readUInt16LE(offset + 32);
  }
}

function toIsoDate(date: Date): string | null {
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** ExcelJS gives a different shape per cell kind; a formula is read by its stored result, never run. */
function readCell(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return toIsoDate(value);
  if (typeof value === 'object') {
    if ('error' in value) return null;
    if ('richText' in value) return value.richText.map((part) => part.text).join('').trim() || null;
    if ('text' in value) return String(value.text).trim() || null;
    if ('result' in value) return readCell(value.result as ExcelJS.CellValue);
  }
  return null;
}

async function readWorkbook(body: Buffer): Promise<Sheet[]> {
  assertReasonableZip(body);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(body as unknown as ArrayBuffer);
  } catch {
    throw badRequest('NOT_A_SPREADSHEET', 'This file is not an Excel workbook');
  }

  const sheets: Sheet[] = [];
  for (const sheet of workbook.worksheets) {
    if (sheet.name === LISTS_SHEET) continue;
    const rows: Sheet['rows'] = [];
    sheet.eachRow({ includeEmpty: false }, (row, number) => {
      const cells: Cell[] = [];
      row.eachCell({ includeEmpty: false }, (cell, column) => {
        cells[column - 1] = readCell(cell.value);
      });
      if (cells.some((c) => c !== null && c !== undefined)) rows.push({ number, cells });
    });
    sheets.push({ name: sheet.name, rows });
  }
  return sheets;
}

function decodeText(body: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body).replace(/^﻿/, '');
  } catch {
    // Excel on a Russian Windows saves "CSV" in cp1251.
    return new TextDecoder('windows-1251').decode(body);
  }
}

function detectDelimiter(text: string): string {
  const firstLines = text.split(/\r?\n/, 5).join('\n');
  const candidates = [';', ',', '\t'];
  const counts = candidates.map((c) => firstLines.split(c).length);
  return candidates[counts.indexOf(Math.max(...counts))];
}

/** RFC 4180 with an auto-detected delimiter. Quoted cells may contain delimiters and newlines. */
export function parseCsv(text: string): Cell[][] {
  const delimiter = detectDelimiter(text);
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let cell = '';
  let quoted = false;

  const pushCell = () => {
    // Our own CSV export prefixes risky cells with an apostrophe; a real cell never starts so.
    const clean = cell.trim().replace(/^'(?=[=+\-@])/, '');
    row.push(clean === '' ? null : clean);
    cell = '';
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      pushCell();
    } else if (ch === '\n') {
      pushRow();
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) pushRow();
  return rows;
}

function readCsv(body: Buffer, name: string): Sheet[] {
  const rows = parseCsv(decodeText(body))
    .map((cells, index) => ({ number: index + 1, cells }))
    .filter((row) => row.cells.some((c) => c !== null));
  return [{ name, rows }];
}

const looksBinary = (body: Buffer) => body.subarray(0, 4096).includes(0);

/** Read any accepted file. The declared type is client input, so the bytes decide. */
export async function readSpreadsheet(body: Buffer, fileName: string): Promise<Sheet[]> {
  if (body.length === 0) throw badRequest('EMPTY_FILE', 'The file is empty');
  if (startsWith(body, 0x50, 0x4b)) return readWorkbook(body);
  // The old binary .xls format: tell the person exactly what to do.
  if (startsWith(body, 0xd0, 0xcf, 0x11, 0xe0)) {
    throw badRequest('OLD_EXCEL_FORMAT', 'Save this file as .xlsx and upload it again');
  }
  if (looksBinary(body)) throw badRequest('NOT_A_SPREADSHEET', 'This file is not an Excel or CSV file');
  return readCsv(body, fileName);
}

export interface ColumnNames {
  key: string;
  /** Every name this column may have in a header, in any language. */
  names: string[];
}

/** A header cell without the marks our template adds: "Maydoni (ga) *" reads as "Maydoni (ga)". */
function headerKey(cell: Cell | undefined): string {
  return matchKey(cellText(cell).replace(/\*/g, ''));
}

/** Column index by key in one row. A column may also match by its name without the bracket note. */
export function matchHeader(cells: Cell[], columns: ColumnNames[]): Map<string, number> {
  const names = new Map<string, string>();
  for (const column of columns) {
    for (const name of column.names) {
      const key = matchKey(name);
      if (key) names.set(key, column.key);
      const short = matchKey(name.replace(/\(.*?\)/g, ''));
      if (short) names.set(short, column.key);
    }
  }
  const found = new Map<string, number>();
  cells.forEach((cell, index) => {
    const full = cellText(cell);
    const column = names.get(headerKey(cell)) ?? names.get(matchKey(full.replace(/\*/g, '').replace(/\(.*?\)/g, '')));
    if (column && !found.has(column)) found.set(column, index);
  });
  return found;
}

export interface Located {
  sheet: Sheet;
  headerRow: number;
  columns: Map<string, number>;
}

/** The sheet and row with the most recognised headers. */
export function locateHeader(sheets: Sheet[], columns: ColumnNames[]): Located | null {
  let best: Located | null = null;
  for (const sheet of sheets) {
    for (const row of sheet.rows.slice(0, HEADER_SCAN_ROWS)) {
      const found = matchHeader(row.cells, columns);
      if (found.size > (best?.columns.size ?? 0)) best = { sheet, headerRow: row.number, columns: found };
    }
  }
  return best;
}
