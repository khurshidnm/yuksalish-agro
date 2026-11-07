import { index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { pk, ts } from './_helpers';
import { tenantColumns } from './_tenant';

/** Saved custom reports and their delivery schedule (spec 14.2). */
export const savedReports = pgTable('saved_reports', {
  id: pk(),
  ...tenantColumns(),
  name: text().notNull(),
  reportKey: text().notNull(),
  config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  schedule: text(),
  channels: jsonb().$type<string[]>().notNull().default([]),
  recipients: jsonb().$type<string[]>().notNull().default([]),
  lastSentAt: ts(),
});

export const importJobs = pgTable(
  'import_jobs',
  {
    id: pk(),
    ...tenantColumns(),
    template: text().notNull(),
    fileName: text().notNull(),
    /** preview, confirmed or discarded. */
    status: text().notNull().default('preview'),
    /** Language of the stored messages. */
    lang: text().notNull().default('uz'),
    /** Rows read from the file, not counting blanks and the example row. */
    totalRows: integer().notNull().default(0),
    /** Rows written by confirm: created plus updated. */
    importedRows: integer().notNull().default(0),
    /** Counts by outcome: new, update, skip, error, and after confirm pendingApproval. */
    summary: jsonb().$type<Record<string, number>>().notNull().default({}),
    errors: jsonb().$type<{ row: number; column?: string; message: string }[]>().notNull().default([]),
    /** Non-blocking notes shown before confirm, e.g. "a new herd will be created". */
    warnings: jsonb().$type<{ row: number; column?: string; message: string }[]>().notNull().default([]),
    /**
     * Parsed rows awaiting confirmation, as { row, status, values, errors, warnings }.
     * After confirm only rows with errors stay, so that personal data is not kept longer than needed.
     */
    rows: jsonb().$type<Record<string, unknown>[]>().notNull().default([]),
  },
  (t) => [index().on(t.farmId, t.createdAt)],
);
