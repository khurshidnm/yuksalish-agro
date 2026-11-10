/**
 * The evening recap (docs/assistant.md): what a person recorded through the assistant today, what
 * still waits, and the day's totals. It repeats only their own records, so it reveals nothing new
 * to them. Totals count approved records only (rule 6); the rest are named as waiting.
 */
import { and, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { ctx, today, tx } from '../../../core/context';
import { schema } from '../../../db/client';
import { tr } from '../../notifications/i18n';
import { notifyUser } from '../../notifications/notify.service';
import { money } from './render';
import { RECORD_KINDS } from './routing';
import type { ProposalFields } from './types';

const { aiProposals: t, memberships, roles, transactions } = schema;

/** Enough to see the day at a glance, and to stay one short message. */
const MAX_LINES = 12;

export interface RecapLine {
  label: string;
  /** A category's name in each language. */
  labels?: Record<string, string>;
  amount: number;
  currency: string;
}

export interface Recap {
  date: string;
  currency: string;
  /** Approved today, largest first. */
  lines: RecapLine[];
  recorded: number;
  moneyOut: number;
  moneyIn: number;
  /** Confirmed, but a second person has not approved yet. */
  awaitingSecond: number;
  /** Still waiting for this person's own confirm. */
  waiting: number;
}

function labelOf(kind: string, f: ProposalFields): string {
  if (f.item) return `${f.item.name}, ${f.qty} ${f.item.unit}`;
  if (kind === 'transfer') return `${f.account?.name} → ${f.toAccount?.name}`;
  return f.category?.name ?? f.counterparty?.name ?? kind;
}

const isIncoming = (kind: string, f: ProposalFields) =>
  kind === 'income' || (kind === 'debt_payment' && f.direction === 'receivable');

/** Everyone with something to hear about today, keyed by person. */
export async function eveningRecaps(): Promise<Map<string, Recap>> {
  const c = ctx();
  const date = today();
  const rows = await tx()
    .select()
    .from(t)
    .where(
      and(
        eq(t.farmId, c.farmId),
        // The recap is about money; a farm record has no amount to total.
        inArray(t.kind, [...RECORD_KINDS]),
        or(
          and(eq(t.status, 'confirmed'), sql`(${t.confirmedAt} at time zone ${c.timezone})::date = ${date}::date`),
          and(eq(t.status, 'pending'), gt(t.expiresAt, new Date())),
        ),
      ),
    );

  // The status at confirm goes stale when a second person acts, so ask the books.
  const resultIds = rows.flatMap((row) => (row.resultId ? [row.resultId] : []));
  const entries = resultIds.length
    ? await tx().select({ id: transactions.id, status: transactions.status }).from(transactions).where(inArray(transactions.id, resultIds))
    : [];
  const statusOf = new Map(entries.map((e) => [e.id, e.status]));

  const recaps = new Map<string, Recap>();
  const recapOf = (userId: string) => {
    const existing = recaps.get(userId);
    if (existing) return existing;
    const fresh: Recap = { date, currency: c.currency, lines: [], recorded: 0, moneyOut: 0, moneyIn: 0, awaitingSecond: 0, waiting: 0 };
    recaps.set(userId, fresh);
    return fresh;
  };

  for (const row of rows) {
    if (row.status === 'pending') {
      recapOf(row.userId).waiting += 1;
      continue;
    }
    const status = row.resultId ? statusOf.get(row.resultId) : undefined;
    if (status === 'pending') {
      recapOf(row.userId).awaitingSecond += 1;
      continue;
    }
    if (status !== 'approved') continue; // Refused or voided since: it is not in the books.
    const f = row.fields as unknown as ProposalFields;
    const recap = recapOf(row.userId);
    recap.recorded += 1;
    recap.lines.push({ label: labelOf(row.kind, f), labels: f.item ? undefined : f.category?.translations, amount: f.amount!, currency: f.currency });
    if (row.kind === 'transfer') continue; // Moved, not spent.
    if (isIncoming(row.kind, f)) recap.moneyIn += f.amountBase!;
    else recap.moneyOut += f.amountBase!;
  }
  for (const recap of recaps.values()) recap.lines.sort((a, b) => b.amount - a.amount);
  return recaps;
}

/** One line per fact, and a line with nothing to say is left out rather than shown as zero. */
export function renderRecap(recap: Recap, locale: string): { title: string; body: string } {
  const say = (key: string, params: Record<string, unknown> = {}) => tr(locale, 'ai', `recap.${key}`, params);
  const lines: string[] = [];
  if (recap.recorded > 0) {
    lines.push(say('recorded', { count: recap.recorded }));
    if (recap.moneyOut > 0) lines.push(say('moneyOut', { amount: money(recap.moneyOut, recap.currency, locale) }));
    if (recap.moneyIn > 0) lines.push(say('moneyIn', { amount: money(recap.moneyIn, recap.currency, locale) }));
    for (const line of recap.lines.slice(0, MAX_LINES)) lines.push(`• ${line.labels?.[locale] ?? line.label}: ${money(line.amount, line.currency, locale)}`);
    if (recap.lines.length > MAX_LINES) lines.push(say('more', { count: recap.lines.length - MAX_LINES }));
  }
  if (recap.awaitingSecond > 0) lines.push(say('awaitingSecond', { count: recap.awaitingSecond }));
  if (recap.waiting > 0) lines.push(say('waiting', { count: recap.waiting }));
  return { title: say('title', { date: recap.date }), body: lines.join('\n') };
}

export async function sendEveningRecap(): Promise<number> {
  const recaps = await eveningRecaps();
  if (recaps.size === 0) return 0;
  // Someone who has left the farm, or may no longer see money, no longer hears about it.
  const members = await tx()
    .select({ userId: memberships.userId, permissions: roles.permissions })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(memberships.farmId, ctx().farmId), eq(memberships.status, 'active'), inArray(memberships.userId, [...recaps.keys()])));
  const active = members.filter((m) => m.permissions.includes('finance.view'));
  for (const { userId } of active) {
    const recap = recaps.get(userId)!;
    await notifyUser(userId, {
      eventType: 'assistant_recap',
      severity: 'info',
      title: (locale) => renderRecap(recap, locale).title,
      body: (locale) => renderRecap(recap, locale).body,
      link: '/ai',
    });
  }
  return active.length;
}
