/**
 * Enquiries from the public website. A lead belongs to the platform, not to a tenant: the table has
 * no tenant_id, no RLS, and no grant to yap_ai, so the assistant can never read a prospect's phone.
 */
import { and, count, desc, eq, gt, ilike, inArray, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { LEAD_FARM_TYPES, LEAD_STATUSES } from '@yap/shared';
import { config } from '../../config';
import { schema } from '../../db/client';
import { withPlatform } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { listQuery } from '../../core/query';
import { normalizePhone } from '../auth/auth.service';
import { escapeHtml, sendRaw, telegramConfigured } from '../notifications/telegram';

const { leads } = schema;

/** Filling the form takes a person longer than this. Scripts submit it at once. */
const MIN_HUMAN_MS = 1500;
/** A second enquiry from the same phone within this window joins the open lead. */
const REPEAT_WINDOW_DAYS = 30;
const OPEN_STATUSES = ['new', 'contacted', 'qualified'] as const;

const optionalText = (max: number) => z.string().trim().max(max).optional();

export const leadInput = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(9).max(24),
  farmName: optionalText(200),
  region: optionalText(120),
  farmType: z.enum(LEAD_FARM_TYPES).optional(),
  farmSize: optionalText(120),
  message: optionalText(2000),
  language: z.enum(['uz', 'uz-Cyrl', 'ru', 'en']).default('uz'),
  source: optionalText(300),
  utm: z
    .record(z.string().max(40), z.string().max(200))
    .refine((value) => Object.keys(value).length <= 8)
    .optional(),
  consent: z.literal(true),
  /** Hidden from people. Only a bot fills it. */
  website: z.string().max(300).optional(),
  /** How long the form was open before it was sent. */
  elapsedMs: z.number().int().min(0).optional(),
});

export const leadListQuery = listQuery.extend({ status: z.enum(LEAD_STATUSES).optional() });

export const leadUpdate = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

function alertTeam(lead: { fullName: string; phone: string; farmName?: string; farmSize?: string; message?: string }, log: FastifyBaseLogger): void {
  const chatId = config.LEADS_TELEGRAM_CHAT_ID;
  if (!chatId || !telegramConfigured()) return;
  const lines = [
    `<b>${escapeHtml(lead.fullName)}</b>`,
    escapeHtml(lead.phone),
    lead.farmName && escapeHtml(lead.farmName),
    lead.farmSize && escapeHtml(lead.farmSize),
    lead.message && escapeHtml(lead.message),
  ].filter(Boolean);
  // A slow or broken bot must never cost us the enquiry, which is already saved.
  void sendRaw(chatId, lines.join('\n')).catch((err) => log.warn({ err }, 'lead alert failed'));
}

/** Traps answer exactly like a real submission, so a bot learns nothing from the response. */
export async function submitLead(input: z.infer<typeof leadInput>, log: FastifyBaseLogger) {
  const { website, elapsedMs, consent: _consent, ...fields } = input;
  if (website || (elapsedMs !== undefined && elapsedMs < MIN_HUMAN_MS)) {
    log.info('lead dropped by the bot trap');
    return { received: true };
  }

  const phone = normalizePhone(fields.phone);
  if (!/^\+\d{9,15}$/.test(phone)) throw badRequest('INVALID_PHONE', 'This phone number is not valid');

  const isNew = await withPlatform(async (trx) => {
    const since = new Date(Date.now() - REPEAT_WINDOW_DAYS * 86_400_000);
    const [open] = await trx
      .select({ id: leads.id, submissions: leads.submissions })
      .from(leads)
      .where(and(eq(leads.phone, phone), gt(leads.createdAt, since), inArray(leads.status, OPEN_STATUSES)))
      .orderBy(desc(leads.createdAt))
      .limit(1)
      .for('update');

    if (open) {
      await trx.update(leads).set({ ...fields, phone, submissions: open.submissions + 1 }).where(eq(leads.id, open.id));
      return false;
    }
    await trx.insert(leads).values({ ...fields, phone, consentAt: new Date() });
    return true;
  });

  if (isNew) alertTeam({ ...fields, phone }, log);
  return { received: true };
}

export async function listLeads(q: z.infer<typeof leadListQuery>) {
  const term = q.search ? `%${q.search.replace(/[\\%_]/g, '\\$&')}%` : null;
  const where = and(
    q.status ? eq(leads.status, q.status) : undefined,
    term ? or(ilike(leads.fullName, term), ilike(leads.phone, term), ilike(leads.farmName, term), ilike(leads.region, term)) : undefined,
  );
  return withPlatform(async (trx) => {
    const data = await trx
      .select()
      .from(leads)
      .where(where)
      .orderBy(desc(leads.createdAt), desc(leads.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ total }] = await trx.select({ total: count() }).from(leads).where(where);
    return { data, meta: { page: q.page, pageSize: q.pageSize, total } };
  });
}

/** Counts per status. A status with no leads is 0: that is a fact here, not missing data. */
export async function leadStats() {
  return withPlatform(async (trx) => {
    const rows = await trx.select({ status: leads.status, n: count() }).from(leads).groupBy(leads.status);
    const counts = Object.fromEntries(LEAD_STATUSES.map((status) => [status, rows.find((row) => row.status === status)?.n ?? 0]));
    return { ...counts, total: rows.reduce((sum, row) => sum + row.n, 0) } as Record<(typeof LEAD_STATUSES)[number] | 'total', number>;
  });
}

export async function updateLead(id: string, input: z.infer<typeof leadUpdate>) {
  return withPlatform(async (trx) => {
    const [lead] = await trx.select().from(leads).where(eq(leads.id, id)).for('update');
    if (!lead) throw notFound('Lead');
    // The first step away from "new" is when someone actually got back to this person.
    const firstContact = lead.contactedAt === null && input.status !== undefined && input.status !== 'new';
    const [updated] = await trx
      .update(leads)
      .set({ ...input, ...(firstContact ? { contactedAt: new Date() } : {}) })
      .where(eq(leads.id, id))
      .returning();
    return updated;
  });
}

/** For spam, and for anyone who asks us to remove their details. */
export async function deleteLead(id: string) {
  return withPlatform(async (trx) => {
    const [removed] = await trx.delete(leads).where(eq(leads.id, id)).returning({ id: leads.id });
    if (!removed) throw notFound('Lead');
    return removed;
  });
}
