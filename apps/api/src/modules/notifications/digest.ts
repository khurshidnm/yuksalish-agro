/**
 * The daily summary (spec 15.3, 24.1) and the bot's /holat answer. Each fact is there only for a
 * reader the web would show it to, so a shepherd's message contains no figures in so'm (rule 7).
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
  herd: { head: number; pregnant: number; sick: number; quarantine: number; lambingWeek: number } | null;
  scarceFeed: { name: string; days: number } | null;
  openAlerts: number;
  urgentAlerts: number;
  cash: number | null;
  tasksOpen: number | null;
}

export interface DigestScope {
  herd: boolean;
  feed: boolean;
  cash: boolean;
  tasks: boolean;
}

/** The dashboard's own rule for each fact (dashboard.service.ts). Alerts are open to everyone there. */
export function digestScope(permissions: Iterable<string>): DigestScope {
  const held = new Set(permissions);
  const aggregates = held.has('dashboard.view') && held.has('reports.view');
  return {
    herd: held.has('livestock.view') || aggregates,
    feed: held.has('feed.view') || held.has('inventory.view') || aggregates,
    cash: held.has('finance.view'),
    tasks: held.has('tasks.view'),
  };
}

async function herdFacts(date: string): Promise<DigestFacts['herd']> {
  const herd = await herdSummary();
  const lambing = await first(sql`
    select count(*) as n from breeding_records
    where farm_id = ${ctx().farmId} and status = 'pregnant'
      and expected_date between ${date}::date and ${addDays(date, 7)}::date`);
  return { head: herd.total, pregnant: herd.pregnant, sick: herd.sick, quarantine: herd.quarantine, lambingWeek: num(lambing.n) };
}

async function feedFact(): Promise<DigestFacts['scarceFeed']> {
  const scarce = (await feedBalance()).filter((row) => row.days !== null).sort((a, b) => a.days! - b.days!)[0];
  return scarce ? { name: scarce.name, days: Math.floor(scarce.days!) } : null;
}

async function tasksFact(): Promise<number> {
  const tasks = await first(sql`
    select count(*) as n from tasks
    where farm_id = ${ctx().farmId} and status in ('open', 'in_progress') and recurrence = 'none'`);
  return num(tasks.n);
}

export async function digestFacts(scope: DigestScope): Promise<DigestFacts> {
  const date = today();
  const alerts = await counts();
  return {
    date,
    herd: scope.herd ? await herdFacts(date) : null,
    scarceFeed: scope.feed ? await feedFact() : null,
    openAlerts: alerts.total,
    urgentAlerts: alerts.urgent,
    cash: scope.cash ? (await cashPosition()).total : null,
    tasksOpen: scope.tasks ? await tasksFact() : null,
  };
}

const NUMBER_LOCALE: Record<string, string> = { uz: 'uz-UZ', 'uz-Cyrl': 'uz-UZ', ru: 'ru-RU', en: 'en-US' };

function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(NUMBER_LOCALE[locale] ?? 'uz-UZ', { maximumFractionDigits: 0 }).format(value);
}

/** One line per fact. Lines with no information are left out rather than shown as zeros. */
export function renderDigest(facts: DigestFacts, locale: string): { title: string; body: string } {
  const line = (key: string, params: Params = {}) => tr(locale, 'alerts', `digest.${key}`, params);
  const lines: string[] = [];
  if (facts.herd) {
    const { head, pregnant, sick, quarantine, lambingWeek } = facts.herd;
    lines.push(line('herd', { head: formatNumber(head, locale), pregnant: formatNumber(pregnant, locale) }));
    if (sick > 0 || quarantine > 0) lines.push(line('health', { sick, quarantine }));
    if (lambingWeek > 0) lines.push(line('lambing', { count: lambingWeek }));
  }
  if (facts.scarceFeed) lines.push(line('feed', facts.scarceFeed));
  if (facts.cash !== null) lines.push(line('cash', { amount: formatNumber(facts.cash, locale) }));
  lines.push(line('alerts', { count: facts.openAlerts, urgent: facts.urgentAlerts }));
  if (facts.tasksOpen !== null) lines.push(line('tasks', { count: facts.tasksOpen }));
  return { title: line('title', { date: facts.date }), body: lines.join('\n') };
}
