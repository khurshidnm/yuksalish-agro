/**
 * The import flow: upload → preview (nothing written) → confirm (everything valid, in one
 * transaction). Rows are judged again at confirm, because the farm may have changed since the
 * preview. Re-importing a file is safe: rows already in the system are skipped by natural key.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { PII_VIEW, type Permission } from '@yap/shared';
import { schema } from '../../db/client';
import { canSeeMoney, ctx, hasPermission, tx } from '../../core/context';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { hidePii } from '../../core/privacy';
import { listQuery, paged, type Page } from '../../core/query';
import { RowCheck, makeEnv, type ApplyResult, type Checked, type Column, type RawRow, type RowMessage, type RowStatus, type Template } from './check';
import { locateHeader, readSpreadsheet, type ColumnNames, type Sheet } from './file';
import { LANG_CODES, tr, type LanguageCode } from './i18n';
import { TEMPLATES, templateOf } from './templates';
import { EXAMPLE_MARK, buildErrorWorkbook, buildTemplate, exampleValue } from './workbook';
import { cellText, matchKey, type Cell } from './values';

const { importJobs, tenants, users } = schema;

type Job = typeof importJobs.$inferSelect;

/**
 * Larger files are split. Confirming costs about 9 ms a row, and one transaction holds its locks
 * for as long as it runs, so this keeps a confirm near 20 s, well inside a proxy's 60 s timeout.
 */
export const MAX_ROWS = 2000;

/** Modules that cannot be switched off, as in core/http.ts. */
const ALWAYS_ON = new Set(['dashboard', 'users', 'settings', 'audit', 'tasks']);

interface StoredRow {
  row: number;
  status: RowStatus;
  values: Record<string, Cell>;
  errors: RowMessage[];
  warnings: RowMessage[];
  note?: string;
}

// ─── Access ────────────────────────────────────────────────────────────────

export const canUse = (template: Template) =>
  template.requires.every((group) => group.some((permission) => hasPermission(permission)));

async function enabledModules(): Promise<string[]> {
  const [tenant] = await tx().select({ modules: tenants.modules }).from(tenants).where(eq(tenants.id, ctx().tenantId));
  return tenant?.modules ?? [];
}

const isEnabled = (template: Template, modules: string[]) =>
  template.modules.every((m) => ALWAYS_ON.has(m) || modules.includes(m));

export async function assertTemplate(template: Template): Promise<void> {
  // A module switched off grants no permission in it, so that is the reason to give first.
  const modules = await enabledModules();
  const off = template.modules.find((m) => !ALWAYS_ON.has(m) && !modules.includes(m));
  if (off) throw forbidden('This module is not enabled for your workspace', 'MODULE_DISABLED', { module: off });
  for (const group of template.requires) {
    if (!group.some((permission) => hasPermission(permission))) throw forbidden(undefined, 'FORBIDDEN', { required: group });
  }
}

/** A person without finance.view gets a template with no price columns at all (rule 7). */
export const visibleColumns = (template: Template): Column[] =>
  template.columns.filter((c) => !c.money || canSeeMoney());

const hiddenFromCaller = (column: Column | undefined) =>
  !!column && ((column.money && !canSeeMoney()) || (column.pii && !hasPermission(PII_VIEW as Permission)));

/** What the job screen shows must obey rules 7 and 8, whoever uploaded the file. */
function maskValues(template: Template, values: Record<string, Cell>): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const column of template.columns) {
    if (!hiddenFromCaller(column)) out[column.key] = values[column.key] ?? null;
  }
  return out;
}

const maskMessages = (template: Template, messages: RowMessage[]) =>
  messages.filter((m) => m.open || !hiddenFromCaller(template.columns.find((c) => c.key === m.column)));

// ─── Reading the file into rows ────────────────────────────────────────────

const namesOf = (template: Template): ColumnNames[] =>
  template.columns.map((column) => ({
    key: column.key,
    names: [
      ...LANG_CODES.map((lang) => tr(lang, `templates.${template.key}.columns.${column.key}.label`)),
      ...(column.aliases ?? []),
    ],
  }));

const templateLabel = (template: Template, lang: LanguageCode) => tr(lang, `templates.${template.key}.title`);

/**
 * The example row is left in the file by most people, and must not become data. It needs both
 * the example's values and the mark beside the table: a real row that happens to equal the
 * example must not vanish silently, and a preview would show a stray example anyway.
 */
function isExampleRow(template: Template, values: Record<string, Cell>, present: string[], cells: Cell[], used: Set<number>): boolean {
  const marked = cells.some((cell, index) => !used.has(index) && cellText(cell).startsWith(EXAMPLE_MARK));
  if (!marked) return false;
  return LANG_CODES.some((lang) =>
    present.every((key) => {
      const column = template.columns.find((c) => c.key === key)!;
      return matchKey(cellText(values[key])) === matchKey(cellText(exampleValue(template, column, lang)));
    }),
  );
}

export function extractRows(sheets: Sheet[], template: Template, lang: LanguageCode): RawRow[] {
  const located = locateHeader(sheets, namesOf(template));

  const best = TEMPLATES.filter((other) => other !== template)
    .map((other) => ({ other, size: locateHeader(sheets, namesOf(other))?.columns.size ?? 0 }))
    .sort((a, b) => b.size - a.size)[0];
  const size = located?.columns.size ?? 0;
  const required = template.columns.filter((c) => c.required);

  if (!located || size < Math.min(2, template.columns.length) || (best.size > size && best.size >= 2)) {
    const expected = templateLabel(template, lang);
    if (best.size >= 2) {
      throw badRequest('LOOKS_LIKE_OTHER_TEMPLATE', 'This file looks like a different template', {
        expected,
        detected: templateLabel(best.other, lang),
      });
    }
    throw badRequest('WRONG_TEMPLATE', 'This file does not match the chosen template', { expected });
  }

  const missing = required.filter((c) => !located.columns.has(c.key));
  if (missing.length) {
    const columns = missing.map((c) => tr(lang, `templates.${template.key}.columns.${c.key}.label`)).join(', ');
    throw badRequest('MISSING_COLUMNS', `Missing columns: ${columns}`, { columns });
  }

  const present = [...located.columns.keys()];
  const used = new Set(located.columns.values());
  const rows: RawRow[] = [];
  for (const row of located.sheet.rows) {
    if (row.number <= located.headerRow) continue;
    const values: Record<string, Cell> = {};
    for (const [key, index] of located.columns) values[key] = row.cells[index] ?? null;
    if (present.every((key) => cellText(values[key]) === '')) continue;
    if (isExampleRow(template, values, present, row.cells, used)) continue;
    rows.push({ row: row.number, values });
  }

  if (rows.length === 0) throw badRequest('NO_DATA_ROWS', 'The file has no data rows');
  if (rows.length > MAX_ROWS) {
    throw badRequest('TOO_MANY_ROWS', `A file can hold up to ${MAX_ROWS} rows`, { max: MAX_ROWS, found: rows.length });
  }
  return rows;
}

// ─── Judging rows ──────────────────────────────────────────────────────────

async function checkRows(template: Template, rows: RawRow[], lang: LanguageCode) {
  const refs = await template.refs({ lang, rows });
  const env = makeEnv(template, lang, canSeeMoney(), ctx().timezone);
  const checked: Checked<unknown>[] = [];
  for (const raw of rows) {
    const check = new RowCheck(raw.row, raw.values, env);
    const parsed = await template.check(check, refs);
    const failed = check.status !== 'skip' && (check.errors.length > 0 || parsed === undefined);
    checked.push({
      row: raw.row,
      status: failed ? 'error' : check.status,
      values: raw.values,
      errors: check.status === 'skip' ? [] : check.errors,
      warnings: failed || check.status === 'skip' ? [] : check.warnings,
      note: check.note,
      parsed: failed ? undefined : parsed,
    });
  }
  return { refs, checked };
}

function countsOf(rows: { status: RowStatus }[]): Record<string, number> {
  const counts: Record<string, number> = { new: 0, update: 0, skip: 0, error: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

const toStored = ({ parsed: _parsed, ...row }: Checked<unknown>): StoredRow => row;

// ─── Views ─────────────────────────────────────────────────────────────────

interface ProblemGroup {
  column: string | null;
  message: string;
  count: number;
  rows: number[];
}

const SHOWN_ROWS_PER_PROBLEM = 12;

/** One mistake often repeats across hundreds of rows; show it once, with how many it touches. */
function groupMessages(messages: RowMessage[]): ProblemGroup[] {
  const groups = new Map<string, ProblemGroup>();
  for (const message of messages) {
    const key = `${message.column ?? ''}|${message.message}`;
    const group = groups.get(key) ?? { column: message.column ?? null, message: message.message, count: 0, rows: [] };
    group.count += 1;
    if (group.rows.length < SHOWN_ROWS_PER_PROBLEM) group.rows.push(message.row);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function view(job: Job) {
  const template = templateOf(job.template);
  return {
    id: job.id,
    template: job.template,
    fileName: job.fileName,
    status: job.status,
    totalRows: job.totalRows,
    importedRows: job.importedRows,
    summary: job.summary,
    createdAt: job.createdAt,
    link: template.link,
    errors: groupMessages(maskMessages(template, job.errors)),
    warnings: groupMessages(maskMessages(template, job.warnings)),
  };
}

// ─── Templates ─────────────────────────────────────────────────────────────

export async function listTemplates() {
  const modules = await enabledModules();
  return {
    maxRows: MAX_ROWS,
    templates: TEMPLATES.filter((t) => isEnabled(t, modules)).map((template) => ({
      key: template.key,
      link: template.link,
      allowed: canUse(template),
      columns: visibleColumns(template).map((c) => ({ key: c.key, required: !!c.required })),
    })),
  };
}

export async function templateFile(key: string, lang: LanguageCode) {
  const template = templateOf(key);
  await assertTemplate(template);
  const refs = await template.refs({ lang, rows: [] });
  const lists = template.lists?.(refs, lang) ?? {};
  const body = await buildTemplate(template, visibleColumns(template), lists, lang);
  return { body, fileName: `${tr(lang, `templates.${key}.file`)}.xlsx` };
}

// ─── Jobs ──────────────────────────────────────────────────────────────────

export async function preview(key: string, file: { body: Buffer; name: string }, lang: LanguageCode) {
  const template = templateOf(key);
  await assertTemplate(template);
  const sheets = await readSpreadsheet(file.body, file.name);
  const rows = extractRows(sheets, template, lang);
  const { checked } = await checkRows(template, rows, lang);

  const c = ctx();
  // A new upload replaces the previous attempt: this is what fixing a file and retrying looks like.
  await tx()
    .update(importJobs)
    .set({ status: 'discarded', rows: [] })
    .where(
      and(
        eq(importJobs.farmId, c.farmId),
        eq(importJobs.template, key),
        eq(importJobs.status, 'preview'),
        eq(importJobs.createdBy, c.userId!),
      ),
    );

  const [job] = await tx()
    .insert(importJobs)
    .values({
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      template: key,
      fileName: file.name.slice(0, 255),
      lang,
      totalRows: rows.length,
      summary: countsOf(checked),
      errors: checked.flatMap((r) => r.errors),
      warnings: checked.flatMap((r) => r.warnings),
      rows: checked.map(toStored) as unknown as Record<string, unknown>[],
    })
    .returning();
  return view(job);
}

async function loadJob(id: string, opts: { lock?: boolean } = {}): Promise<Job> {
  const query = tx()
    .select()
    .from(importJobs)
    .where(and(eq(importJobs.id, id), eq(importJobs.farmId, ctx().farmId)));
  const [job] = await (opts.lock ? query.for('update') : query);
  if (!job) throw notFound('Import job');
  await assertTemplate(templateOf(job.template));
  return job;
}

export const getJob = async (id: string) => view(await loadJob(id));

export const jobRowsQuery = listQuery.extend({ status: z.enum(['new', 'update', 'skip', 'error']).optional() });

export async function jobRows(id: string, q: z.infer<typeof jobRowsQuery>): Promise<Page<unknown>> {
  const job = await loadJob(id);
  const template = templateOf(job.template);
  const rows = (job.rows as unknown as StoredRow[]).filter((row) => !q.status || row.status === q.status);
  const start = (q.page - 1) * q.pageSize;
  return {
    data: rows.slice(start, start + q.pageSize).map((row) => ({
      ...row,
      values: maskValues(template, row.values),
      errors: maskMessages(template, row.errors),
      warnings: maskMessages(template, row.warnings),
    })),
    meta: { page: q.page, pageSize: q.pageSize, total: rows.length },
  };
}

export async function errorFile(id: string) {
  const job = await loadJob(id);
  const template = templateOf(job.template);
  const lang = job.lang as LanguageCode;
  const rows = (job.rows as unknown as StoredRow[])
    .filter((row) => row.status === 'error')
    .map((row) => ({
      row: row.row,
      values: maskValues(template, row.values),
      reasons: maskMessages(template, row.errors).map((e) => e.message),
    }));
  const columns = template.columns.filter((c) => !hiddenFromCaller(c));
  return {
    body: await buildErrorWorkbook(template, columns, rows, lang),
    fileName: `${tr(lang, `templates.${template.key}.file`)}-${tr(lang, 'workbook.errorsFile')}.xlsx`,
  };
}

export function rowFailure(row: number, err: unknown): AppError {
  const reason = err instanceof AppError ? err.message : 'The database refused this row';
  const failure = conflict('IMPORT_ROW_FAILED', `Row ${row}: ${reason}`, {
    row,
    reason,
    code: err instanceof AppError ? err.code : null,
  });
  failure.cause = err;
  return failure;
}

/**
 * Write every valid row, or nothing: all of it runs in the request's transaction, so a failure on
 * row 400 leaves no trace of rows 1 to 399 and the preview stays open to retry.
 */
export async function confirmJob(id: string) {
  const job = await loadJob(id, { lock: true });
  if (job.status !== 'preview') throw conflict('JOB_NOT_OPEN', 'This import has already been finished');

  const template = templateOf(job.template);
  const lang = job.lang as LanguageCode;
  const raw = (job.rows as unknown as StoredRow[]).map(({ row, values }) => ({ row, values }));
  const { refs, checked } = await checkRows(template, raw, lang);

  const valid = checked.filter((row) => row.status === 'new' || row.status === 'update');
  if (valid.length === 0) throw conflict('NOTHING_TO_IMPORT', 'There are no valid rows to import');

  const counters: Record<string, number> = {};
  const add = (result: ApplyResult) => {
    for (const [key, value] of Object.entries(result ?? {})) counters[key] = (counters[key] ?? 0) + value;
  };

  if (template.applyAll) {
    try {
      add(await template.applyAll(valid.map((row) => row.parsed), refs));
    } catch (err) {
      throw rowFailure(valid[0].row, err);
    }
  } else {
    for (const row of valid) {
      try {
        add(await template.apply!(row.parsed, refs, lang));
      } catch (err) {
        throw rowFailure(row.row, err);
      }
    }
  }

  const summary = { ...countsOf(checked), ...counters };
  const [updated] = await tx()
    .update(importJobs)
    .set({
      status: 'confirmed',
      importedRows: valid.length,
      summary,
      errors: checked.flatMap((r) => r.errors),
      warnings: checked.flatMap((r) => r.warnings),
      // Personal data leaves the job as soon as it is imported. Failed rows stay, for fixing.
      rows: checked.filter((r) => r.status === 'error').map(toStored) as unknown as Record<string, unknown>[],
    })
    .where(eq(importJobs.id, id))
    .returning();

  await recordEvent({
    type: 'import.confirmed',
    entityType: 'import_job',
    entityId: id,
    data: { template: template.key, fileName: job.fileName, ...summary },
  });
  return view(updated);
}

export async function discardJob(id: string) {
  const job = await loadJob(id, { lock: true });
  if (job.status !== 'preview') throw conflict('JOB_NOT_OPEN', 'This import has already been finished');
  const [updated] = await tx()
    .update(importJobs)
    .set({ status: 'discarded', rows: [] })
    .where(eq(importJobs.id, id))
    .returning();
  await recordEvent({ type: 'import.discarded', entityType: 'import_job', entityId: id, data: { template: job.template } });
  return view(updated);
}

export async function listJobs(q: z.infer<typeof listQuery>) {
  const allowed = TEMPLATES.filter(canUse).map((t) => t.key);
  if (allowed.length === 0) return { data: [], meta: { page: q.page, pageSize: q.pageSize, total: 0 } };
  const where = and(eq(importJobs.farmId, ctx().farmId), inArray(importJobs.template, allowed));
  const page = await paged(q, importJobs, where, (limit, offset) =>
    tx()
      .select({
        id: importJobs.id,
        template: importJobs.template,
        fileName: importJobs.fileName,
        status: importJobs.status,
        totalRows: importJobs.totalRows,
        importedRows: importJobs.importedRows,
        summary: importJobs.summary,
        createdAt: importJobs.createdAt,
        createdByName: users.fullName,
      })
      .from(importJobs)
      .leftJoin(users, eq(users.id, importJobs.createdBy))
      .where(where)
      .orderBy(desc(importJobs.createdAt), desc(importJobs.id))
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: hidePii(page.data, ['createdByName']) };
}
