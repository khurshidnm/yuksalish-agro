import { and, desc, eq, gte, like, lt, sql, type SQL, type Column } from 'drizzle-orm';
import { z } from 'zod';
import { EVENT_SOURCES, PII_VIEW, SEVERITIES } from '@yap/shared';
import { schema } from '../../db/client';
import { canSeeMoney, ctx, hasPermission, tx } from '../../core/context';
import { isoDate, listQuery, paged } from '../../core/query';

const { auditLogs, events, users } = schema;

export const auditQuery = listQuery.extend({
  entity: z.string().max(60).optional(),
  entityId: z.string().max(60).optional(),
  userId: z.uuid().optional(),
  action: z.enum(['insert', 'update', 'delete']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const journalQuery = listQuery.extend({
  /** Exact type, or a prefix such as "animal." */
  type: z.string().max(60).optional(),
  source: z.enum(EVENT_SOURCES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  entityType: z.string().max(60).optional(),
  entityId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/** Removed for everyone: credentials never leave the database, even for auditors. */
const SECRET_KEYS = new Set([
  'key_hash', 'keyHash', 'secret', 'stream_credentials', 'streamCredentials', 'password_hash', 'passwordHash',
  'totp_secret', 'totpSecret', 'token_hash', 'tokenHash',
]);
const PII_KEYS = new Set([
  'phone', 'email', 'passport', 'full_name', 'fullName', 'contact_person', 'contactPerson', 'bank_details', 'bankDetails',
]);
/** Keys that hold money. NOT_MONEY removes look-alikes such as cost_center_id and payment_method. */
const MONEY_KEY = /(amount|cost|price|salary|balance|principal|interest|payment|rate|bonus|deduction|advance|budget|piecework|allocation|\bnet\b|_net$)/i;
const NOT_MONEY = /(_id$|Id$|center|treatment|method|percent|pct|_date$|Date$|seed_?rate|norm)/i;

const isMoneyKey = (key: string) => MONEY_KEY.test(key) && !NOT_MONEY.test(key);

/** Deep copy with the fields this caller may not see removed (CLAUDE.md rules 7 and 8). */
export function redact(value: unknown, seeMoney: boolean, seePii: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => redact(v, seeMoney, seePii));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) continue;
    if (!seePii && PII_KEYS.has(key)) continue;
    if (!seeMoney && isMoneyKey(key)) continue;
    out[key] = redact(v, seeMoney, seePii);
  }
  return out;
}

/** Lower bound of a business date in the farm's time zone; the plain column keeps the index usable. */
export function fromDay(column: Column, day: string | undefined): SQL | undefined {
  return day ? gte(column, sql`(${day}::date)::timestamp at time zone ${ctx().timezone}`) : undefined;
}
export function toDay(column: Column, day: string | undefined): SQL | undefined {
  return day ? lt(column, sql`(${day}::date + 1)::timestamp at time zone ${ctx().timezone}`) : undefined;
}

export async function listAudit(q: z.infer<typeof auditQuery>) {
  const c = ctx();
  const where = and(
    eq(auditLogs.tenantId, c.tenantId),
    // audit_logs has no farm_id: the row's own farm decides. Tenant-level rows have none.
    sql`coalesce(${auditLogs.after}->>'farm_id', ${auditLogs.before}->>'farm_id', ${c.farmId}::text) = ${c.farmId}::text`,
    q.entity ? eq(auditLogs.entity, q.entity) : undefined,
    q.entityId ? eq(auditLogs.entityId, q.entityId) : undefined,
    q.userId ? eq(auditLogs.userId, q.userId) : undefined,
    q.action ? eq(auditLogs.action, q.action) : undefined,
    fromDay(auditLogs.at, q.from),
    toDay(auditLogs.at, q.to),
  );
  const seeMoney = canSeeMoney();
  const seePii = hasPermission(PII_VIEW);

  const page = await paged(q, auditLogs, where, (limit, offset) =>
    tx()
      .select({
        id: auditLogs.id,
        at: auditLogs.at,
        entity: auditLogs.entity,
        entityId: auditLogs.entityId,
        action: auditLogs.action,
        before: auditLogs.before,
        after: auditLogs.after,
        ip: auditLogs.ip,
        device: auditLogs.device,
        userId: auditLogs.userId,
        userName: users.fullName,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.userId))
      .where(where)
      .orderBy(desc(auditLogs.at), desc(auditLogs.id))
      .limit(limit)
      .offset(offset),
  );

  return {
    ...page,
    data: page.data.map((row) => ({
      ...row,
      before: redact(row.before, seeMoney, seePii),
      after: redact(row.after, seeMoney, seePii),
      userName: seePii ? row.userName : null,
      ip: seePii ? row.ip : null,
    })),
  };
}

/** Tables with recent changes, for the filter dropdown. */
export async function auditEntities(): Promise<string[]> {
  const rows = await tx()
    .selectDistinct({ entity: auditLogs.entity })
    .from(auditLogs)
    .where(and(eq(auditLogs.tenantId, ctx().tenantId), sql`${auditLogs.at} > now() - interval '90 days'`))
    .orderBy(auditLogs.entity);
  return rows.map((r) => r.entity);
}

export async function listJournal(q: z.infer<typeof journalQuery>) {
  const where = and(
    eq(events.farmId, ctx().farmId),
    q.type ? (q.type.endsWith('.') ? like(events.type, `${q.type.replace(/[\\%_]/g, '\\$&')}%`) : eq(events.type, q.type)) : undefined,
    q.source ? eq(events.source, q.source) : undefined,
    q.severity ? eq(events.severity, q.severity) : undefined,
    q.entityType ? eq(events.entityType, q.entityType) : undefined,
    q.entityId ? eq(events.entityId, q.entityId) : undefined,
    fromDay(events.occurredAt, q.from),
    toDay(events.occurredAt, q.to),
  );
  const seeMoney = canSeeMoney();
  const seePii = hasPermission(PII_VIEW);

  const page = await paged(q, events, where, (limit, offset) =>
    tx()
      .select({
        id: events.id,
        occurredAt: events.occurredAt,
        source: events.source,
        type: events.type,
        severity: events.severity,
        entityType: events.entityType,
        entityId: events.entityId,
        data: events.data,
        createdBy: events.createdBy,
        userName: users.fullName,
      })
      .from(events)
      .leftJoin(users, eq(users.id, events.createdBy))
      .where(where)
      .orderBy(desc(events.occurredAt), desc(events.id))
      .limit(limit)
      .offset(offset),
  );
  return {
    ...page,
    data: page.data.map((row) => ({
      ...row,
      data: redact(row.data, seeMoney, seePii),
      userName: seePii ? row.userName : null,
    })),
  };
}
