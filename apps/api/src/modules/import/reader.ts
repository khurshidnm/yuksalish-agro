/**
 * Turns the bytes of an uploaded file into rows of cells. Excel and CSV both end up as the same shape.
 *
 * This file runs as its own process, started by file.ts: a file can ask for more memory or time than
 * the API can give, and when this process dies the API and its fire alerts keep running. Plain `node`
 * runs it, so it holds only syntax that node can strip of types, and imports nothing from the API at
 * run time. Nothing here may need the API's environment either: the process gets none of it.
 *
 * ExcelJS's streaming reader is not used: it decodes each chunk alone, so a Cyrillic letter that falls
 * across two chunks silently turns into "��".
 */
import { writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import type ExcelJS from 'exceljs';
import type { Cell } from './values';

export interface Sheet {
  name: string;
  /** Sparse by column index, 0-based. `number` is the row number the person sees in Excel. */
  rows: { number: number; cells: Cell[] }[];
  /** Rows holding data in the whole sheet. Above `rows.length` when the sheet has too many to keep. */
  found: number;
}

export type ReaderAnswer = { sheets: Sheet[] } | { refused: { code: string; message: string; details?: unknown } };

/**
 * Larger files are split. Confirming costs about 9 ms a row, and one transaction holds its locks
 * for as long as it runs, so this keeps a confirm near 20 s, well inside a proxy's 60 s timeout.
 */
export const MAX_ROWS = 2000;
/** Rows scanned to find the header. People put a title above the table. */
export const HEADER_SCAN_ROWS = 15;
/** Sheets of our own template that never hold data. */
export const LISTS_SHEET = 'Lists';
/** The argument that tells this file it is the process, and not a module of the API. */
export const READ_STDIN = '--read-stdin';

/** Excel's own limit for one cell. */
export const MAX_CELL_CHARS = 32_767;
/** A title, the header and the example row come on top of the data. */
const KEPT_ROWS = MAX_ROWS + HEADER_SCAN_ROWS + 1;
/** Cells further right are not read. A table that wide is not one of our templates. */
const MAX_COLUMNS = 100;
const MAX_SHEETS = 20;
/** The cells handed to the API. A shared string can repeat in every cell, so the file's size says nothing. */
const MAX_KEPT_CHARS = 8_000_000;
/** What is really unpacked, whatever the zip declares. A full 2000-row file needs about 5 MB. */
const MAX_UNPACKED_BYTES = 32 * 1024 * 1024;

/** Pictures and embedded files can be most of a workbook, and nothing here looks at them. */
const UNREAD_PARTS = /^(xl\/media|xl\/embeddings)\//;

class Refusal extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const notWorkbook = () => new Refusal('NOT_A_SPREADSHEET', 'This file is not an Excel workbook');
const tooComplex = () => new Refusal('FILE_TOO_COMPLEX', 'This workbook is too large to read');
const cellTooLong = (row: number) =>
  new Refusal('CELL_TOO_LONG', `Row ${row} has a cell longer than ${MAX_CELL_CHARS} characters`, { row, max: MAX_CELL_CHARS });

const startsWith = (body: Buffer, ...bytes: number[]) => bytes.every((b, i) => body[i] === b);

// ─── Zip ───────────────────────────────────────────────────────────────────

const ZIP_FILE = 0x04034b50;
const ZIP_ENTRY = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;

interface ZipEntry {
  name: string;
  method: number;
  packedSize: number;
  headerAt: number;
}

function zipEntries(body: Buffer): ZipEntry[] {
  let end = -1;
  for (let i = body.length - 22; i >= Math.max(0, body.length - 66_000); i--) {
    if (body.readUInt32LE(i) === ZIP_END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw notWorkbook();

  const entries: ZipEntry[] = [];
  const count = body.readUInt16LE(end + 10);
  let at = body.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (at + 46 > body.length || body.readUInt32LE(at) !== ZIP_ENTRY) throw notWorkbook();
    const nameLength = body.readUInt16LE(at + 28);
    entries.push({
      name: body.toString('utf8', at + 46, at + 46 + nameLength),
      method: body.readUInt16LE(at + 10),
      packedSize: body.readUInt32LE(at + 20),
      headerAt: body.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + body.readUInt16LE(at + 30) + body.readUInt16LE(at + 32);
  }
  return entries;
}

function unpackEntry(body: Buffer, entry: ZipEntry, room: number): Buffer {
  const header = entry.headerAt;
  if (header + 30 > body.length || body.readUInt32LE(header) !== ZIP_FILE) throw notWorkbook();
  const start = header + 30 + body.readUInt16LE(header + 26) + body.readUInt16LE(header + 28);
  const packed = body.subarray(start, start + entry.packedSize);
  if (packed.length !== entry.packedSize) throw notWorkbook();
  if (room <= 0) throw tooComplex();

  if (entry.method === ZIP_STORED) {
    if (packed.length > room) throw tooComplex();
    return packed;
  }
  if (entry.method !== ZIP_DEFLATED) throw notWorkbook();
  try {
    return inflateRawSync(packed, { maxOutputLength: room });
  } catch (err) {
    throw (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? tooComplex() : notWorkbook();
  }
}

/** A zip declares its sizes itself, so the limit counts what really comes out, and stops there. */
function unpack(body: Buffer): [string, Buffer][] {
  const parts: [string, Buffer][] = [];
  let unpacked = 0;
  for (const entry of zipEntries(body)) {
    if (entry.name.endsWith('/')) continue;
    if (UNREAD_PARTS.test(entry.name.replace(/^\//, ''))) {
      parts.push([entry.name, Buffer.alloc(0)]);
      continue;
    }
    const data = unpackEntry(body, entry, MAX_UNPACKED_BYTES - unpacked);
    unpacked += data.length;
    parts.push([entry.name, data]);
  }
  return parts;
}

/**
 * The same parts in a zip that compresses nothing. ExcelJS unpacks whatever it is given with no limit,
 * so it only ever sees what was counted above. Nothing checks the CRC, so none is written.
 */
function storedZip(parts: [string, Buffer][]): Buffer {
  const files: Buffer[] = [];
  const directory: Buffer[] = [];
  let at = 0;
  for (const [name, data] of parts) {
    const path = Buffer.from(name);
    const file = Buffer.alloc(30);
    file.writeUInt32LE(ZIP_FILE, 0);
    file.writeUInt16LE(20, 4);
    file.writeUInt16LE(0x0800, 6);
    file.writeUInt32LE(data.length, 18);
    file.writeUInt32LE(data.length, 22);
    file.writeUInt16LE(path.length, 26);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(ZIP_ENTRY, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(path.length, 28);
    entry.writeUInt32LE(at, 42);

    files.push(file, path, data);
    directory.push(entry, path);
    at += file.length + path.length + data.length;
  }
  const entries = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(entries.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...files, entries, end]);
}

// ─── Rows ──────────────────────────────────────────────────────────────────

/** Adds rows to a sheet, up to what the API can take. Past that they are only counted. */
function rowKeeper() {
  let keptChars = 0;
  return (sheet: Sheet, number: number, cells: Cell[]) => {
    if (!cells.some((cell) => cell !== null && cell !== undefined)) return;
    sheet.found += 1;
    if (sheet.rows.length >= KEPT_ROWS) return;
    for (const cell of cells) {
      if (typeof cell !== 'string') continue;
      if (cell.length > MAX_CELL_CHARS) throw cellTooLong(number);
      keptChars += cell.length;
    }
    if (keptChars > MAX_KEPT_CHARS) throw tooComplex();
    sheet.rows.push({ number, cells });
  };
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
  const clean = storedZip(unpack(body));
  const { default: Excel } = await import('exceljs');
  const workbook = new Excel.Workbook();
  try {
    await workbook.xlsx.load(clean as unknown as ArrayBuffer);
  } catch {
    throw notWorkbook();
  }

  const worksheets = workbook.worksheets.filter((sheet) => sheet.name !== LISTS_SHEET);
  if (worksheets.length > MAX_SHEETS) throw tooComplex();

  const keep = rowKeeper();
  return worksheets.map((worksheet) => {
    const sheet: Sheet = { name: worksheet.name, rows: [], found: 0 };
    worksheet.eachRow({ includeEmpty: false }, (row, number) => {
      const cells: Cell[] = [];
      row.eachCell({ includeEmpty: false }, (cell, column) => {
        if (column <= MAX_COLUMNS) cells[column - 1] = readCell(cell.value);
      });
      keep(sheet, number, cells);
    });
    return sheet;
  });
}

function decodeText(body: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    // Excel on a Russian Windows saves "CSV" in cp1251.
    return new TextDecoder('windows-1251').decode(body);
  }
}

function detectDelimiter(text: string): string {
  const firstLines = text.slice(0, 64 * 1024).split(/\r?\n/, 5).join('\n');
  const candidates = [';', ',', '\t'];
  const counts = candidates.map((c) => firstLines.split(c).length);
  return candidates[counts.indexOf(Math.max(...counts))];
}

/** RFC 4180 with an auto-detected delimiter. Quoted cells may contain delimiters and newlines. */
function parseCsv(text: string, onRow: (number: number, cells: Cell[]) => void): void {
  const delimiter = detectDelimiter(text);
  let number = 0;
  let row: Cell[] = [];
  let cell = '';
  let quoted = false;

  const pushCell = () => {
    // Our own CSV export prefixes risky cells with an apostrophe; a real cell never starts so.
    const clean = cell.trim().replace(/^'(?=[=+\-@])/, '');
    if (row.length < MAX_COLUMNS) row.push(clean === '' ? null : clean);
    cell = '';
  };
  const pushRow = () => {
    pushCell();
    number += 1;
    onRow(number, row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (cell.length > MAX_CELL_CHARS) throw cellTooLong(number + 1);
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
}

function readCsv(body: Buffer): Sheet[] {
  const sheet: Sheet = { name: 'CSV', rows: [], found: 0 };
  const keep = rowKeeper();
  parseCsv(decodeText(body), (number, cells) => keep(sheet, number, cells));
  return [sheet];
}

/** Read any accepted file. The declared type is client input, so the bytes decide. */
async function readBody(body: Buffer): Promise<Sheet[]> {
  if (body.length === 0) throw new Refusal('EMPTY_FILE', 'The file is empty');
  if (startsWith(body, 0x50, 0x4b, 0x03, 0x04)) return readWorkbook(body);
  // The old binary .xls format: tell the person exactly what to do.
  if (startsWith(body, 0xd0, 0xcf, 0x11, 0xe0)) {
    throw new Refusal('OLD_EXCEL_FORMAT', 'Save this file as .xlsx and upload it again');
  }
  // Text never holds a NUL, and Postgres could not store one.
  if (body.includes(0)) throw new Refusal('NOT_A_SPREADSHEET', 'This file is not an Excel or CSV file');
  return readCsv(body);
}

async function answer(body: Buffer): Promise<ReaderAnswer> {
  try {
    return { sheets: await readBody(body) };
  } catch (err) {
    const { code, message, details } = err instanceof Refusal ? err : notWorkbook();
    return { refused: { code, message, details } };
  }
}

async function main(): Promise<void> {
  // If the container runs out of memory, the kernel must take this process and not the API.
  try {
    writeFileSync('/proc/self/oom_score_adj', '1000');
  } catch {
    // Not Linux.
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  process.stdout.write(JSON.stringify(await answer(Buffer.concat(chunks))));
}

if (process.argv[2] === READ_STDIN) await main();
