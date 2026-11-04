/**
 * The daily summary (spec 15.3, 24.1) and the bot's /holat answer. Whether money appears depends
 * on the reader's permissions, so a shepherd's message contains no figures in so'm (rule 7).
 */
import { sql, type SQL } from 'drizzle-orm';
import { addDays } from '@yap/shared';
import { ctx, today, tx } from '../../core/context';
import { counts } from '../alerts/alerts.service';
import { feedBalance } from '../feed/balance.service';
import { cashPosition } from '../finance/summary';
import { herdSummary } from '../livestock/summary';
import { tr, type Params } from './i18n';

async function first(statement: SQL): Promise<Record<string, unknown>> {
  const result = await tx().execute(statement);
  return result.rows[0] as Record<string, unknown>;
}

const num = (value: unknown) => Number(value ?? 0);

export interface DigestFacts {
  date: string;
  head: number;
  pregnant: number;
  sick: number;
  quarantine: number;
  lambingWeek: number;
  scarceFeed: { name: string; days: number } | null;
  openAlerts: number;
  urgentAlerts: number;
  cash: number | null;
  tasksOpen: number;
}

export async function digestFacts(seeMoney: boolean): Promise<DigestFacts> {
  const c = ctx();
  const date = today();
  const herd = await herdSummary();
  const weekEnd = addDays(date, 7);
  const lambing = await first(sql`
    select count(*) as n from breeding_records
    where farm_id = ${c.farmId} and status = 'pregnant'
      and expected_date between ${date}::date and ${weekEnd}::date`);
  const alerts = await counts();
  const tasks = await first(sql`
    select count(*) as n from tasks
    where farm_id = ${c.farmId} and status in ('open', 'in_progress') and recurrence = 'none'`);

  const scarce = (await feedBalance())
    .filter((row) => row.days !== null)
    .sort((a, b) => a.days! - b.days!)[0];

  return {
    date,
    head: herd.total,
    pregnant: herd.pregnant,
    sick: herd.sick,
    quarantine: herd.quarantine,
    lambingWeek: num(lambing.n),
    scarceFeed: scarce ? { name: scarce.name, days: Math.floor(scarce.days!) } : null,
    openAlerts: alerts.total,
    urgentAlerts: alerts.urgent,
    cash: seeMoney ? (await cashPosition()).total : null,
    tasksOpen: num(tasks.n),
  };
}

const NUMBER_LOCALE: Record<string, string> = { uz: 'uz-UZ', 'uz-Cyrl': 'uz-UZ', ru: 'ru-RU', en: 'en-US' };

function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(NUMBER_LOCALE[locale] ?? 'uz-UZ', { maximumFractionDigits: 0 }).format(value);
}

/** One line per fact. Lines with no information are left out rather than shown as zeros. */
export function renderDigest(facts: DigestFacts, locale: string): { title: string; body: string } {
  const line = (key: string, params: Params = {}) => tr(locale, 'alerts', `digest.${key}`, params);
  const lines = [line('herd', { head: formatNumber(facts.head, locale), pregnant: formatNumber(facts.pregnant, locale) })];
  if (facts.sick > 0 || facts.quarantine > 0) {
    lines.push(line('health', { sick: facts.sick, quarantine: facts.quarantine }));
  }
  if (facts.lambingWeek > 0) lines.push(line('lambing', { count: facts.lambingWeek }));
  if (facts.scarceFeed) lines.push(line('feed', facts.scarceFeed));
  if (facts.cash !== null) lines.push(line('cash', { amount: formatNumber(facts.cash, locale) }));
  lines.push(line('alerts', { count: facts.openAlerts, urgent: facts.urgentAlerts }));
  lines.push(line('tasks', { count: facts.tasksOpen }));
  return { title: line('title', { date: facts.date }), body: lines.join('\n') };
}
