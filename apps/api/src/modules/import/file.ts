/**
 * From an uploaded file to the table inside it. reader.ts does the reading, in a process of its own;
 * this side starts it, within limits, and finds the header in what comes back.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import { AppError, badRequest } from '../../core/errors';
import { HEADER_SCAN_ROWS, READ_STDIN, type ReaderAnswer, type Sheet } from './reader';
import { cellText, matchKey, type Cell } from './values';

/**
 * Sized for the smallest server, where the API's container has 1 GB: the process then peaks near 460 MB
 * beside an API of about 300 MB. A real file needs far less: 2000 rows peak at 140 MB, 30 000 rows at 330 MB.
 */
const READER_HEAP_MB = 256;
/** A file that takes the whole heap ends in about 5 s on a laptop. A proxy gives up at 120 s, queue included. */
const READ_TIMEOUT_MS = 20_000;
/** The reader keeps 8 million characters at most, and JSON can spend a few bytes on each. */
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;
const MAX_WAITING_READS = 3;

const READER_ARGS = [
  '--experimental-strip-types',
  '--no-warnings',
  `--max-old-space-size=${READER_HEAP_MB}`,
  fileURLToPath(new URL('./reader.ts', import.meta.url)),
  READ_STDIN,
];

export interface Finished {
  stdout: Buffer;
  exitCode: number | null;
  /** Set when the process was killed or crashed. */
  signal: NodeJS.Signals | null;
}

/**
 * Run node on `args` with `input` on stdin, killing it past the limits. Only a process that cannot
 * start rejects: whatever one that started does, the answer is how it ended.
 */
export function runLimited(args: string[], input: Buffer, limits: { timeoutMs: number; maxOutputBytes: number }): Promise<Finished> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      // None of the API's secrets, and not its NODE_OPTIONS, which would set the API's heap.
      env: {},
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: limits.timeoutMs,
      killSignal: 'SIGKILL',
    });
    child.on('error', reject);

    const chunks: Buffer[] = [];
    let size = 0;
    // Out of file handles, there are no streams and only the 'error' above.
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limits.maxOutputBytes) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    // A stream error nobody hears would end the API. 'close' says how the process ended anyway.
    child.stdout?.on('error', () => {});
    child.stdin?.on('error', () => {});

    child.on('close', (exitCode, signal) => resolve({ stdout: Buffer.concat(chunks), exitCode, signal }));
    child.stdin?.end(input);
  });
}

let reading = false;
const waiting: (() => void)[] = [];

/** Files are read one at a time, because of the memory above. Returns what hands the turn on. */
async function readerTurn(): Promise<() => void> {
  if (reading) {
    if (waiting.length >= MAX_WAITING_READS) {
      throw new AppError(429, 'READER_BUSY', 'Other files are being read, please try again in a moment');
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  reading = true;
  return () => {
    const next = waiting.shift();
    if (next) next();
    else reading = false;
  };
}

function parseAnswer(finished: Finished): ReaderAnswer | null {
  if (finished.exitCode !== 0) return null;
  try {
    return JSON.parse(finished.stdout.toString('utf8')) as ReaderAnswer;
  } catch {
    return null;
  }
}

/** Read any accepted file, or refuse it. Nothing a file does here reaches this process. */
export async function readSpreadsheet(body: Buffer, log: FastifyBaseLogger): Promise<Sheet[]> {
  const handOn = await readerTurn();
  let finished: Finished;
  try {
    finished = await runLimited(READER_ARGS, body, { timeoutMs: READ_TIMEOUT_MS, maxOutputBytes: MAX_ANSWER_BYTES });
  } catch (err) {
    log.error({ err }, 'the spreadsheet reader did not start');
    throw new AppError(503, 'READER_UNAVAILABLE', 'Files cannot be read right now, please try again');
  } finally {
    handOn();
  }

  const answer = parseAnswer(finished);
  if (!answer) {
    log.warn({ exitCode: finished.exitCode, signal: finished.signal, bytes: body.length }, 'the spreadsheet reader was stopped');
    throw badRequest('FILE_TOO_COMPLEX', 'This workbook is too large to read');
  }
  if ('refused' in answer) throw badRequest(answer.refused.code, answer.refused.message, answer.refused.details);
  return answer.sheets;
}

export interface ColumnNames {
  key: string;
  /** Every name this column may have in a header, in any language. */
  names: string[];
}

/** Longer text is not a header, and the patterns below are too slow for what a hostile cell can hold. */
const MAX_HEADER_CHARS = 200;

/** A header cell without the marks our template adds: "Maydoni (ga) *" reads as "Maydoni (ga)". */
function headerKey(cell: Cell | undefined): string {
  return matchKey(cellText(cell).replace(/\*/g, ''));
}

/** Column key by every form of its names. A column may also match by its name without the bracket note. */
function columnsByName(columns: ColumnNames[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const column of columns) {
    for (const name of column.names) {
      const key = matchKey(name);
      if (key) names.set(key, column.key);
      const short = matchKey(name.replace(/\(.*?\)/g, ''));
      if (short) names.set(short, column.key);
    }
  }
  return names;
}

/** Column index by key in one row. */
function matchHeader(cells: Cell[], names: Map<string, string>): Map<string, number> {
  const found = new Map<string, number>();
  cells.forEach((cell, index) => {
    const full = cellText(cell);
    if (full.length > MAX_HEADER_CHARS) return;
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
  const names = columnsByName(columns);
  let best: Located | null = null;
  for (const sheet of sheets) {
    for (const row of sheet.rows.slice(0, HEADER_SCAN_ROWS)) {
      const found = matchHeader(row.cells, names);
      if (found.size > (best?.columns.size ?? 0)) best = { sheet, headerRow: row.number, columns: found };
    }
  }
  return best;
}
