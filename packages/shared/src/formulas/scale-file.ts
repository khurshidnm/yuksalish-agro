/**
 * Reads the file an electronic scale or a stick reader saves: one animal per line, its tag or
 * electronic number, and its weight in kilograms. Indicators differ in everything else, so the
 * reader accepts commas, semicolons or tabs between cells, a decimal comma or point, quoted cells,
 * a heading row or none, and a few lines of session details above the heading.
 *
 * Nothing is guessed. A weight that cannot be read, that may mean two things, or that is in another
 * unit is reported with its line number and left out. Which animal a line belongs to is decided by
 * exact matching (scan-code.ts), never by a near miss.
 */
import { maxLiveWeightKg } from './livestock';
import { normalizeScan } from './scan-code';
import { readTypedNumber } from './typed-number';

export type ScaleDelimiter = ';' | ',' | '\t';

/** No weight above this is accepted from a file, whatever the species (the API's own limit). */
export const SCALE_MAX_KG = 2000;

/** A file longer than this is not a weighing session: the bulk route takes 1000 entries. */
export const SCALE_MAX_ROWS = 1000;

export interface ScaleRecord {
  /** Line in the file, from 1, where the record starts. */
  line: number;
  cells: string[];
}

const DELIMITERS: ScaleDelimiter[] = ['\t', ';', ','];

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === delimiter && !quoted) count += 1;
  }
  return count;
}

/**
 * The character between cells: the one found on the most lines. Tab wins over semicolon, and
 * semicolon over comma, because a file with "45,5" in every row has a comma on every line too.
 */
export function detectDelimiter(text: string): ScaleDelimiter {
  const lines = text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim())
    .slice(0, 30);
  let best: ScaleDelimiter = ',';
  let bestLines = 0;
  for (const delimiter of DELIMITERS) {
    const withIt = lines.filter((line) => countOutsideQuotes(line, delimiter) > 0).length;
    if (withIt > bestLines) {
      best = delimiter;
      bestLines = withIt;
    }
  }
  return best;
}

/** Spreadsheets write a number kept as text as ="982000123456789". */
function cleanCell(cell: string): string {
  const text = cell.replace(/ /g, ' ').trim();
  const formula = /^="(.*)"$/.exec(text);
  return formula ? formula[1].trim() : text;
}

/** Split delimited text into records. Quotes follow RFC 4180: "" inside a quoted cell is one quote. */
export function splitRecords(text: string, delimiter: ScaleDelimiter): ScaleRecord[] {
  const source = text.replace(/^﻿/, '');
  const records: ScaleRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  let startLine = 1;

  const endCell = () => {
    cells.push(wasQuoted ? cell : cleanCell(cell));
    cell = '';
    wasQuoted = false;
  };
  const endRecord = () => {
    endCell();
    if (cells.some((c) => c !== '')) records.push({ line: startLine, cells: cells.map(cleanCell) });
    cells = [];
    startLine = line + 1;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else {
        if (ch === '\n') line += 1;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === '') {
      quoted = true;
      wasQuoted = true;
      cell = '';
    } else if (ch === delimiter) endCell();
    else if (ch === '\r') {
      if (source[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
    } else if (ch === '\n') {
      endRecord();
      line += 1;
    } else cell += ch;
  }
  endRecord();
  return records;
}

// ─── Headings ──────────────────────────────────────────────────────────────

const fold = (text: string) =>
  text
    .toLowerCase()
    .replace(/[ʻʼ’‘`']/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim();

const EID_WORDS = ['eid', 'rfid', 'electronic', 'chip', 'transponder', 'elektron', 'электрон', 'чип', 'рфид'];
const TAG_WORDS = ['vid', 'tag', 'visual', 'ear', 'birka', 'raqam', 'raqami', "sirg'a", 'бирка', 'бирки', 'инв'];
/** Headings that may name the animal, or may only count the lines: used when nothing better is there. */
const LOOSE_TAG_WORDS = ['animal', 'id', 'no', 'number', 'номер', 'ид'];
const WEIGHT_WORDS = ['weight', 'wt', 'lwt', 'kg', 'mass', 'vazn', 'vazni', "og'irlik", "og'irligi", 'вес', 'масса', 'кг'];
/** A second weight-like column that is not the weight taken today. */
const NOT_THE_WEIGHT = ['gain', 'adg', 'avg', 'average', 'target', 'previous', 'prev', 'last', 'birth', 'прирост', 'привес', 'средний', 'предыдущий', "o'sish", 'oldingi'];

const hasWord = (heading: string, words: string[]) => fold(heading).split(' ').some((word) => words.includes(word));

const looksNumeric = (cell: string) => /^[-+]?\d[\d\s.,]*$/.test(cell.trim());

function isHeading(record: ScaleRecord): boolean {
  if (record.cells.some(looksNumeric)) return false;
  return record.cells.some((cell) => [WEIGHT_WORDS, EID_WORDS, TAG_WORDS, LOOSE_TAG_WORDS].some((words) => hasWord(cell, words)));
}

export type ScaleWeightUnit = 'kg' | 'lb' | 'g';

function unitOfHeading(heading: string): ScaleWeightUnit {
  const words = fold(heading).split(' ');
  if (words.some((w) => ['lb', 'lbs', 'pound', 'pounds', 'фунт', 'фунты'].includes(w))) return 'lb';
  if (words.some((w) => ['g', 'gr', 'gram', 'grams', 'г', 'гр', 'грамм'].includes(w))) return 'g';
  return 'kg';
}

export interface ScaleColumns {
  /** Index of the column that names the animal. */
  code: number | null;
  /** Index of the column with today's weight. */
  weight: number | null;
}

export interface ScaleFile {
  delimiter: ScaleDelimiter;
  /** Heading cells, or null when the file has no heading row. */
  header: string[] | null;
  /** Lines above the heading that were left out: a session name, a date. */
  skippedLines: number[];
  /** Data records only. */
  records: ScaleRecord[];
  columnCount: number;
  /** The reader's own choice of columns; a person may choose others. */
  columns: ScaleColumns;
}

function share(records: ScaleRecord[], index: number, test: (cell: string) => boolean): number {
  if (records.length === 0) return 0;
  return records.filter((r) => test(r.cells[index] ?? '')).length / records.length;
}

function guessColumns(header: string[] | null, records: ScaleRecord[], columnCount: number): ScaleColumns {
  const indexes = Array.from({ length: columnCount }, (_, i) => i);
  const filled = (i: number) => share(records, i, (cell) => cell !== '');

  if (header) {
    const weights = indexes.filter((i) => hasWord(header[i] ?? '', WEIGHT_WORDS) && !hasWord(header[i] ?? '', NOT_THE_WEIGHT));
    const weight = weights[0] ?? null;
    const eid = indexes.find((i) => i !== weight && hasWord(header[i] ?? '', EID_WORDS)) ?? null;
    const named = (words: string[]) => indexes.find((i) => i !== weight && i !== eid && hasWord(header[i] ?? '', words)) ?? null;
    const tag = named(TAG_WORDS) ?? named(LOOSE_TAG_WORDS);
    // The electronic number names the animal when the file has one on as many lines as the tag.
    const code = eid !== null && (tag === null || filled(eid) >= filled(tag)) ? eid : (tag ?? eid);
    if (weight !== null || code !== null) return { code, weight };
  }

  // No heading: the weight column is the one whose cells read as weights, the code is the fullest other.
  const readable = (i: number) => share(records, i, (cell) => readScaleWeight(cell).problem === null);
  const hasFraction = (i: number) => share(records, i, (cell) => /\d[.,]\d/.test(cell)) > 0;
  let weight: number | null = null;
  for (const i of indexes) {
    if (readable(i) === 0) continue;
    if (weight === null) weight = i;
    else if (readable(i) > readable(weight)) weight = i;
    else if (readable(i) === readable(weight) && (hasFraction(i) || !hasFraction(weight))) weight = i;
  }
  let code: number | null = null;
  for (const i of indexes) {
    if (i === weight || filled(i) === 0) continue;
    if (code === null || filled(i) > filled(code)) code = i;
  }
  return { code, weight };
}

/**
 * Read the structure of a scale file. `header` overrides the reader's own decision about the first
 * row, for the rare file whose heading it cannot recognise.
 */
export function parseScaleFile(text: string, options: { header?: boolean; delimiter?: ScaleDelimiter } = {}): ScaleFile {
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const all = splitRecords(text, delimiter);
  let headerIndex = -1;
  if (options.header !== false) {
    headerIndex = all.slice(0, 15).findIndex(isHeading);
    if (headerIndex < 0 && options.header === true && all.length > 0) headerIndex = 0;
  }
  const header = headerIndex >= 0 ? all[headerIndex].cells : null;
  const records = headerIndex >= 0 ? all.slice(headerIndex + 1) : all;
  const skippedLines = headerIndex > 0 ? all.slice(0, headerIndex).map((r) => r.line) : [];
  const columnCount = Math.max(header?.length ?? 0, ...records.map((r) => r.cells.length), 0);
  return { delimiter, header, skippedLines, records, columnCount, columns: guessColumns(header, records, columnCount) };
}

/** The unit a weight column's heading states. Kilograms when it states none. */
export function scaleWeightUnit(file: ScaleFile, weightColumn: number | null): ScaleWeightUnit {
  return file.header && weightColumn !== null ? unitOfHeading(file.header[weightColumn] ?? '') : 'kg';
}

// ─── Weights ───────────────────────────────────────────────────────────────

export type ScaleWeightProblem =
  /** The cell is empty. */
  | 'no_weight'
  /** Not a number: "err", "45.5 S", "4,5e1". */
  | 'not_a_number'
  /** "1.234" or "1,234": one kilogram and a bit, or over a tonne. Both are possible, so neither is taken. */
  | 'ambiguous'
  /** Pounds or grams. Converting is the scale's job: set it to kilograms and export again. */
  | 'unit'
  /** Zero or below: the scale saved a line with no animal on it. */
  | 'not_positive'
  /** Heavier than any animal. */
  | 'too_heavy';

const KG_SUFFIX = /^(.*\d)\s*(?:kg|kgs|kg\.|кг|кг\.)$/i;
const OTHER_UNIT_SUFFIX = /^(.*\d)\s*(?:lb|lbs|lb\.|g|gr|gr\.|г|гр|гр\.|t|т|oz|фунт\S*)$/i;

/** One weight cell, in kilograms, or the reason it cannot be used. */
export function readScaleWeight(cell: string, maxKg: number = SCALE_MAX_KG): { kg: number | null; problem: ScaleWeightProblem | null } {
  const bad = (problem: ScaleWeightProblem) => ({ kg: null, problem });
  let text = cell.replace(/[   ]/g, ' ').trim();
  if (!text) return bad('no_weight');
  if (OTHER_UNIT_SUFFIX.test(text)) return bad('unit');
  const withKg = KG_SUFFIX.exec(text);
  if (withKg) text = withKg[1].trim();
  if (text.startsWith('+')) text = text.slice(1).trim();
  const negative = text.startsWith('-');
  if (negative) text = text.slice(1).trim();
  if (!/^\d/.test(text) && !/^[.,]\d/.test(text)) return bad('not_a_number');

  const read = readTypedNumber(text, { decimals: 3 });
  if (read.unreadable || read.value === null) return bad('not_a_number');
  if (negative || read.value <= 0) return bad('not_positive');
  // 45.250 can only be 45.25 kg: forty-five tonnes is no animal. 1.234 can be either.
  if (read.otherReading !== null && read.otherReading <= maxKg) return bad('ambiguous');
  if (read.value > maxKg) return bad('too_heavy');
  return { kg: read.value, problem: null };
}

export type ScaleRowProblem =
  | ScaleWeightProblem
  /** No tag or electronic number on the line. */
  | 'no_code'
  /** A spreadsheet turned the electronic number into 9.82E+14: the digits are gone. */
  | 'code_damaged';

export interface ScaleRow {
  line: number;
  /** The tag or electronic number, as scan-code reads it. Null when the line has none. */
  code: string | null;
  /** The weight cell as written, for showing the person what the file says. */
  weightText: string;
  weightKg: number | null;
  problem: ScaleRowProblem | null;
}

const SCIENTIFIC = /^\d(?:[.,]\d+)?e\+?\d+$/i;

/** Every data line of the file with the chosen columns read. */
export function readScaleRows(file: ScaleFile, columns: ScaleColumns = file.columns): ScaleRow[] {
  const unit = scaleWeightUnit(file, columns.weight);
  return file.records.map((record) => {
    const codeText = columns.code === null ? '' : (record.cells[columns.code] ?? '');
    const weightText = columns.weight === null ? '' : (record.cells[columns.weight] ?? '');
    const code = normalizeScan(codeText);
    const weight = readScaleWeight(weightText);
    let problem: ScaleRowProblem | null = null;
    if (SCIENTIFIC.test(codeText.trim())) problem = 'code_damaged';
    else if (code === null) problem = 'no_code';
    else if (weight.problem) problem = weight.problem;
    else if (unit !== 'kg') problem = 'unit';
    return { line: record.line, code, weightText, weightKg: problem ? null : weight.kg, problem };
  });
}

// ─── Matching the lines to animals ─────────────────────────────────────────

export interface ScaleAnimal {
  id: string;
  tag: string;
  onFarm: boolean;
  herdId: string | null;
  speciesKey: string | null;
  birthDate: string | null;
  /** What in the registry carried the code: 'tag', or an identifier type such as 'rfid'. */
  matchedBy: string;
}

export type ScalePlanStatus =
  /** Will be sent. */
  | 'ready'
  /** The line itself cannot be used: see `problem`. */
  | 'unreadable'
  /** No animal carries this code. */
  | 'unmatched'
  /** Two or more animals carry it: the file cannot say which. */
  | 'several'
  /** The animal was sold, died or was slaughtered. */
  | 'not_on_farm'
  /** Heavier than this species can be. */
  | 'implausible'
  /** The weighing date is before the animal was born. */
  | 'before_birth'
  /** The same animal comes again further down: the later line stands. */
  | 'duplicate';

export interface ScalePlanRow extends ScaleRow {
  status: ScalePlanStatus;
  animal: ScaleAnimal | null;
  /** For 'several': the animals to tell apart. */
  candidates: ScaleAnimal[];
  /** The animal is in another herd than the one being weighed. It is still weighed, and flagged. */
  otherHerd: boolean;
  /** For 'duplicate': the line that replaces this one. */
  replacedByLine: number | null;
  /** 'rfid' when the file named the animal by its electronic number, else 'scale'. */
  method: 'scale' | 'rfid';
  /** For 'implausible': the most this species can weigh. */
  maxKg: number | null;
}

/**
 * Decide what happens to every line. When an animal is on two lines the later one stands, as it
 * does when the same animal is weighed twice by hand: the second reading is the correction.
 */
export function planScaleImport(
  rows: readonly ScaleRow[],
  matchesOf: (code: string) => readonly ScaleAnimal[],
  campaign: { herdId: string | null; date: string },
): ScalePlanRow[] {
  const plan: ScalePlanRow[] = rows.map((row) => {
    const base = { ...row, animal: null, candidates: [] as ScaleAnimal[], otherHerd: false, replacedByLine: null, method: 'scale' as const, maxKg: null };
    if (row.problem || row.code === null || row.weightKg === null) return { ...base, status: 'unreadable' as const };
    const found = matchesOf(row.code);
    if (found.length === 0) return { ...base, status: 'unmatched' as const };
    if (found.length > 1) return { ...base, status: 'several' as const, candidates: [...found] };
    const animal = found[0];
    const matched = { ...base, animal, otherHerd: animal.herdId !== campaign.herdId, method: animal.matchedBy === 'rfid' ? ('rfid' as const) : ('scale' as const) };
    if (!animal.onFarm) return { ...matched, status: 'not_on_farm' as const };
    if (animal.birthDate && campaign.date < animal.birthDate) return { ...matched, status: 'before_birth' as const };
    const maxKg = maxLiveWeightKg(animal.speciesKey ?? '');
    if (row.weightKg > maxKg) return { ...matched, status: 'implausible' as const, maxKg };
    return { ...matched, status: 'ready' as const };
  });

  const lastLineOf = new Map<string, number>();
  for (const row of plan) if (row.status === 'ready' && row.animal) lastLineOf.set(row.animal.id, row.line);
  return plan.map((row) => {
    if (row.status !== 'ready' || !row.animal) return row;
    const last = lastLineOf.get(row.animal.id)!;
    return last === row.line ? row : { ...row, status: 'duplicate' as const, replacedByLine: last };
  });
}
