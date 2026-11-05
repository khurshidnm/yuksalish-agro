/**
 * Full data export (spec 20.3). The table list comes from the catalog, so a table added later
 * is exported without changing this file. Rows are read in small transactions through RLS, and
 * credentials are dropped in SQL, so they never reach this process.
 */
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { sql, type SQL } from 'drizzle-orm';
import { ctx, tx, withTenant, type Identity } from '../../core/context';
import { notFound } from '../../core/errors';
import { redact } from './audit.service';

const BATCH = 1000;

/** Internal plumbing: not the tenant's business data. */
const EXCLUDED_TABLES = new Set(['idempotency_keys', 'webhook_deliveries', 'import_jobs']);
const SECRET_COLUMNS = ['key_hash', 'secret', 'stream_credentials', 'password_hash', 'totp_secret', 'token_hash'];

interface TableInfo {
  name: string;
  hasFarm: boolean;
  /** Columns usable for a stable order. */
  orderBy: string;
}

async function exportableTables(): Promise<TableInfo[]> {
  const result = await tx().execute(sql`
    select c.table_name as name,
           bool_or(c.column_name = 'farm_id') as has_farm,
           bool_or(c.column_name = 'id') as has_id
    from information_schema.columns c
    join information_schema.tables t using (table_schema, table_name)
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      and exists (
        select 1 from information_schema.columns k
        where k.table_schema = 'public' and k.table_name = c.table_name and k.column_name = 'tenant_id'
      )
    group by c.table_name
    order by c.table_name`);
  return (result.rows as { name: string; has_farm: boolean; has_id: boolean }[])
    .filter((r) => !EXCLUDED_TABLES.has(r.name))
    .map((r) => ({ name: r.name, hasFarm: r.has_farm, orderBy: r.has_id ? 'id' : 'ctid' }));
}

/**
 * A membership is per farm, so a director of one farm must not export another. Rows with a farm_id
 * are limited to the active farm. The two tables below have none and carry farm data all the same;
 * tables left without a filter are tenant-wide reference data.
 */
function farmScope(table: TableInfo): SQL {
  const { farmId } = ctx();
  if (table.hasFarm) return sql`where t.farm_id = ${farmId}`;
  if (table.name === 'audit_logs') {
    return sql`where coalesce(t.after->>'farm_id', t.before->>'farm_id', ${farmId}::text) = ${farmId}::text`;
  }
  if (table.name === 'ai_messages') {
    return sql`where t.conversation_id in (select id from ai_conversations where farm_id = ${farmId})`;
  }
  return sql``;
}

/** `table` comes from the catalog above, never from the request. */
function scopedSelect(table: TableInfo, offset: number): SQL {
  const secrets = sql.join(SECRET_COLUMNS.map((c) => sql`${c}`), sql`, `);
  return sql`
    select to_jsonb(t) - array[${secrets}]::text[] as row
    from ${sql.identifier(table.name)} t ${farmScope(table)}
    order by t.${sql.identifier(table.orderBy)}
    limit ${BATCH} offset ${offset}`;
}

async function readBatch(identity: Identity, table: TableInfo, offset: number): Promise<Record<string, unknown>[]> {
  return withTenant(identity, async () => {
    const result = await tx().execute(scopedSelect(table, offset));
    // Audit rows hold whole records as JSON, so credentials must also be removed at depth.
    return (result.rows as { row: Record<string, unknown> }[]).map((r) => redact(r.row, true, true) as Record<string, unknown>);
  });
}

async function write(stream: PassThrough, chunk: string): Promise<void> {
  if (!stream.write(chunk)) await once(stream, 'drain');
}

/** Stream one JSON document without holding the export in memory or a transaction open. */
export async function writeJsonExport(identity: Identity, stream: PassThrough): Promise<void> {
  try {
    const tables = await withTenant(identity, exportableTables);
    const header = await withTenant(identity, async () => {
      const members = await tx().execute(sql`
        select u.id, u.full_name, u.phone, u.email, u.locale, u.status
        from memberships m join users u on u.id = m.user_id
        where m.farm_id = ${ctx().farmId}`);
      const tenant = await tx().execute(sql`
        select id, name, legal_name, tin, legal_form, tax_regime, currency, timezone, locale, modules, settings
        from tenants where id = ${ctx().tenantId}`);
      return { tenant: tenant.rows[0], users: members.rows };
    });

    await write(
      stream,
      `{"exportedAt":${JSON.stringify(new Date().toISOString())},"tenant":${JSON.stringify(header.tenant)},` +
        `"users":${JSON.stringify(header.users)},"tables":{`,
    );

    for (const [index, table] of tables.entries()) {
      await write(stream, `${index === 0 ? '' : ','}${JSON.stringify(table.name)}:[`);
      let offset = 0;
      let first = true;
      for (;;) {
        const rows = await readBatch(identity, table, offset);
        for (const row of rows) {
          await write(stream, `${first ? '' : ','}${JSON.stringify(row)}`);
          first = false;
        }
        if (rows.length < BATCH) break;
        offset += BATCH;
      }
      await write(stream, ']');
    }
    stream.end('}}');
  } catch (err) {
    // The status line has gone out, so the only honest signal left is a broken stream.
    stream.destroy(err instanceof Error ? err : new Error('Export failed'));
  }
}

/** Names and row counts of what the export contains. */
/** The figures only help someone choose what to download, and an exact one reads all of a long journal. */
const OVERVIEW_COUNT_LIMIT = 100_000;

export async function exportOverview() {
  const tables = await exportableTables();
  const rows: { name: string; rows: number; capped?: true }[] = [];
  for (const table of tables) {
    const result = await tx().execute(
      sql`select count(*)::int as n from (select 1 from ${sql.identifier(table.name)} t ${farmScope(table)} limit ${OVERVIEW_COUNT_LIMIT + 1}) counted`,
    );
    const { n } = result.rows[0] as { n: number };
    rows.push(n > OVERVIEW_COUNT_LIMIT ? { name: table.name, rows: OVERVIEW_COUNT_LIMIT, capped: true } : { name: table.name, rows: n });
  }
  return rows;
}

function csvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  // A cell starting with these runs as a formula in Excel. Numbers keep their minus sign.
  if (/^[=+\-@\t\r]/.test(text) && Number.isNaN(Number(text))) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One table as CSV. `requested` must match the catalog, or this is a 404. */
export async function writeCsvExport(identity: Identity, requested: string, stream: PassThrough): Promise<void> {
  try {
    let columns: string[] | null = null;
    const table = (await withTenant(identity, exportableTables)).find((t) => t.name === requested)!;
    for (let offset = 0; ; offset += BATCH) {
      const rows = await readBatch(identity, table, offset);
      if (rows.length > 0 && !columns) {
        columns = Object.keys(rows[0]);
        // BOM: without it Excel misreads Uzbek and Russian text.
        await write(stream, `﻿${columns.join(',')}\r\n`);
      }
      for (const row of rows) await write(stream, `${columns!.map((c) => csvValue(row[c])).join(',')}\r\n`);
      if (rows.length < BATCH) break;
    }
    stream.end();
  } catch (err) {
    stream.destroy(err instanceof Error ? err : new Error('Export failed'));
  }
}

export async function assertExportable(identity: Identity, table: string): Promise<void> {
  const tables = await withTenant(identity, exportableTables);
  if (!tables.some((t) => t.name === table)) throw notFound('Table');
}
