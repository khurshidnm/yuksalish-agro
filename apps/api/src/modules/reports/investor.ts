/**
 * Investor one-pager (spec 10.4, 14.2): a fixed one-page summary, on demand and monthly.
 *
 * This is the one deliberate exception to "money needs finance.view". Holders of finance.summary,
 * such as the investor role, are meant to receive these figures, so they are read with finance.view
 * for this call only, and the output is a fixed set of farm-level totals with no names of any kind:
 * no people, no counterparties. Reading needs finance.view or finance.summary: a zootechnician holds
 * reports.view but must not get money through this door.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { FINANCE_SUMMARY_VIEW, monthRange, monthOf, profitabilityPercent, round } from '@yap/shared';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { v7 as uuidv7 } from 'uuid';
import { schema } from '../../db/client';
import { ctx, hasPermission, today, tx, updateCtx } from '../../core/context';
import { forbidden } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { storage } from '../../core/storage';
import { harvestPlanFact, fieldStatus } from '../crops/summary';
import { listWithBalances } from '../finance/accounts.service';
import { budgetExecution, cashflowForecast, debtSummary, herdCost, monthToDate } from '../finance/summary';
import { signedFileUrl } from '../files';
import { feedBalance } from '../inventory/summary';
import { lambingCalendar } from '../livestock/breeding.summary';
import { herdMovement, herdSummary, mortality, weightTrend } from '../livestock/summary';
import { notifyRole } from '../notifications/notify.service';
import { formatIsoDate, formatIsoMonth, formatNumber, resolveLang, t } from './i18n';
import { printable, renderPdf } from './pdf';
import type { Lang } from './types';

const { events, farms, files, tenants } = schema;

const LAMBING_HORIZON_DAYS = 180;
const FEED_ROWS = 4;

export function assertCanReadInvestorReport(): void {
  if (!hasPermission('finance.view') && !hasPermission(FINANCE_SUMMARY_VIEW)) {
    throw forbidden('This report contains financial figures', 'INVESTOR_REPORT_FORBIDDEN');
  }
}

const roundOrNull = (value: number | null, digits: number) => (value === null ? null : round(value, digits));

async function withMoneyRead<T>(fn: () => Promise<T>): Promise<T> {
  const before = ctx().permissions;
  updateCtx({ permissions: new Set([...before, 'finance.view']) });
  try {
    return await fn();
  } finally {
    updateCtx({ permissions: before });
  }
}

export async function investorData(month: string) {
  const c = ctx();
  return withMoneyRead(async () => {
    const { from, to } = monthRange(month);
    const now = today();
    const asOf = to < now ? to : now;

    const [tenant] = await tx().select({ name: tenants.name }).from(tenants).where(eq(tenants.id, c.tenantId));
    const [farm] = await tx().select({ name: farms.name }).from(farms).where(eq(farms.id, c.farmId));

    const result = await monthToDate(month);
    const accounts = await listWithBalances(asOf);
    const debts = await debtSummary();
    const budget = await budgetExecution(from, to);
    const forecast = await cashflowForecast(3);
    const cost = await herdCost();

    const movement = await herdMovement(from, asOf);
    const herd = await herdSummary();
    const dead = await mortality(30);
    const lambing = await lambingCalendar(LAMBING_HORIZON_DAYS);
    const weights = await weightTrend(1);

    const fields = await fieldStatus();
    const harvest = await harvestPlanFact();
    const feed = (await feedBalance()).filter((row) => row.days !== null).sort((a, b) => a.days! - b.days!);

    return {
      month,
      asOf,
      tenantName: tenant?.name ?? '',
      farmName: farm?.name ?? '',
      finance: {
        income: result.income,
        expense: result.expense,
        operatingExpense: result.operatingExpense,
        // Income less the cost of running the farm, so the percent below follows from these lines.
        // Animals, machinery and stock still in the warehouse are assets, not a loss (rule 3).
        net: round(result.income - result.operatingExpense, 2),
        profitabilityPercent: roundOrNull(profitabilityPercent(result.income, result.operatingExpense), 1),
        cash: round(accounts.reduce((sum, a) => sum + a.balanceBase, 0), 2),
        receivable: debts.receivable,
        payable: debts.payable,
        loans: debts.loansOutstanding,
        budgetPercent: roundOrNull(budget.percent, 1),
        costPerHead: cost.costPerHead,
        forecast: forecast.map((row) => ({ month: row.month, closing: row.closing })),
      },
      livestock: {
        head: movement.closing,
        pregnant: herd.pregnant,
        born: movement.born,
        sold: movement.sold,
        dead: movement.dead,
        mortalityPercent: roundOrNull(dead.percent, 2),
        lambingExpected: lambing.reduce((sum, day) => sum + day.expected, 0),
        avgWeightKg: weights[weights.length - 1]?.avgKg ?? null,
      },
      crops: {
        sown: fields.sown,
        total: fields.total,
        harvestPlannedT: harvest.plannedT,
        harvestActualT: harvest.actualT,
      },
      feed: feed.slice(0, FEED_ROWS).map((row) => ({ name: row.name, days: row.days })),
    };
  });
}

export type InvestorData = Awaited<ReturnType<typeof investorData>>;

type Line = [label: string, value: string];

function sections(d: InvestorData, lang: Lang): { title: string; lines: Line[] }[] {
  const label = (key: string) => t(lang, `investor.${key}`);
  const money = (value: number | null) => (value === null ? '—' : formatNumber(value, 0, lang));
  const qty = (value: number | null, digits = 1) => (value === null ? '—' : formatNumber(value, digits, lang));
  const pct = (value: number | null) => (value === null ? '—' : `${formatNumber(value, 1, lang)}%`);
  const f = d.finance;
  const l = d.livestock;
  return [
    {
      title: label('finance'),
      lines: [
        [label('income'), money(f.income)],
        [label('operatingExpense'), money(f.operatingExpense)],
        [label('net'), money(f.net)],
        [label('expense'), money(f.expense)],
        [label('profitability'), pct(f.profitabilityPercent)],
        [label('budget'), pct(f.budgetPercent)],
        [label('cash'), money(f.cash)],
        [label('receivable'), money(f.receivable)],
        [label('payable'), money(f.payable)],
        [label('loans'), money(f.loans)],
        [label('costPerHead'), money(f.costPerHead)],
      ],
    },
    {
      title: label('forecast'),
      lines: f.forecast.map((row): Line => [formatIsoMonth(row.month), money(row.closing)]),
    },
    {
      title: label('livestock'),
      lines: [
        [label('head'), qty(l.head, 0)],
        [label('pregnant'), qty(l.pregnant, 0)],
        [label('born'), qty(l.born, 0)],
        [label('sold'), qty(l.sold, 0)],
        [label('dead'), qty(l.dead, 0)],
        [label('mortality'), pct(l.mortalityPercent)],
        [label('lambingExpected'), qty(l.lambingExpected, 0)],
        [label('avgWeight'), qty(l.avgWeightKg)],
      ],
    },
    {
      title: label('crops'),
      lines: [
        [label('sown'), `${d.crops.sown} / ${d.crops.total}`],
        [label('harvestPlanned'), qty(d.crops.harvestPlannedT)],
        [label('harvestActual'), qty(d.crops.harvestActualT)],
      ],
    },
    {
      title: label('feed'),
      lines: d.feed.length
        ? d.feed.map((row): Line => [row.name, qty(row.days)])
        : [[label('noData'), '—']],
    },
  ];
}

function block(section: { title: string; lines: Line[] }): Content {
  return {
    margin: [0, 0, 0, 12],
    stack: [
      { text: printable(section.title), bold: true, fontSize: 11, color: '#2F5D3A', margin: [0, 0, 0, 3] },
      {
        table: {
          widths: ['*', 'auto'],
          body: section.lines.map(([name, value]) => [
            { text: printable(name) },
            { text: value, alignment: 'right', bold: true },
          ]),
        },
        layout: {
          hLineWidth: () => 0.3,
          vLineWidth: () => 0,
          hLineColor: () => '#D5DAD2',
          paddingTop: () => 2,
          paddingBottom: () => 2,
          paddingLeft: () => 0,
          paddingRight: () => 0,
        },
      },
    ],
  };
}

export function investorPdfDefinition(d: InvestorData, lang: Lang): TDocumentDefinitions {
  const parts = sections(d, lang);
  const left = parts.filter((_, i) => i === 0 || i === 1);
  const right = parts.filter((_, i) => i > 1);
  return {
    pageSize: 'A4',
    pageMargins: [40, 36, 40, 36],
    defaultStyle: { font: 'Roboto', fontSize: 9.5 },
    info: { title: printable(t(lang, 'investor.title')) },
    content: [
      { text: printable(d.tenantName), fontSize: 10, color: '#444444' },
      { text: printable(t(lang, 'investor.title')), fontSize: 18, bold: true, margin: [0, 2, 0, 2] },
      {
        text: printable(
          `${d.farmName} · ${formatIsoMonth(d.month)} · ${t(lang, 'investor.asOf', { date: formatIsoDate(d.asOf) })}`,
        ),
        fontSize: 9.5,
        color: '#555555',
        margin: [0, 0, 0, 14],
      },
      { columnGap: 24, columns: [{ stack: left.map(block) }, { stack: right.map(block) }] },
      { text: printable(t(lang, 'investor.currency')), fontSize: 8, color: '#777777', margin: [0, 4, 0, 0] },
      { text: printable(t(lang, 'investor.disclaimer')), fontSize: 8, color: '#777777', margin: [0, 2, 0, 0] },
    ],
  };
}

export const investorPdf = (d: InvestorData, lang: Lang) => renderPdf(investorPdfDefinition(d, lang));

/** Short text for the notification, in the recipient's language. */
export function investorMessage(d: InvestorData, locale: string): string {
  const lang = resolveLang(locale);
  const line = (key: string, value: string) => `${t(lang, `investor.${key}`)}: ${value}`;
  const money = (value: number) => formatNumber(value, 0, lang);
  return [
    line('income', money(d.finance.income)),
    line('expense', money(d.finance.expense)),
    line('cash', money(d.finance.cash)),
    line('head', formatNumber(d.livestock.head, 0, lang)),
  ].join('\n');
}

const SNAPSHOT_EVENT = 'report.investor_generated';

/** Month before today's, the month an investor report covers. */
export function reportingMonth(now: string): string {
  const [year, month] = monthOf(now).split('-').map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/**
 * Store the month's PDF so later edits do not change what investors were sent, then tell them.
 * Safe to run twice: a month is generated once.
 */
export async function sendMonthlyInvestorReport(month: string = reportingMonth(today())): Promise<'sent' | 'exists'> {
  const c = ctx();
  const [existing] = await tx()
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.farmId, c.farmId), eq(events.type, SNAPSHOT_EVENT), sql`${events.data}->>'month' = ${month}`))
    .limit(1);
  if (existing) return 'exists';

  const [tenant] = await tx().select({ locale: tenants.locale }).from(tenants).where(eq(tenants.id, c.tenantId));
  const lang = resolveLang(tenant?.locale);
  const data = await investorData(month);
  const body = await investorPdf(data, lang);

  const id = uuidv7();
  const storageKey = `${c.tenantId}/${id}.pdf`;
  await storage.put(storageKey, body, 'application/pdf');
  await tx().insert(files).values({
    id,
    tenantId: c.tenantId,
    farmId: c.farmId,
    createdBy: c.userId,
    storageKey,
    name: `investor_${month}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: body.length,
  });
  await recordEvent({ type: SNAPSHOT_EVENT, entityType: 'file', entityId: id, data: { month, fileId: id } });

  await notifyRole('investor', {
    severity: 'info',
    title: (locale) => `${t(resolveLang(locale), 'investor.title')} · ${formatIsoMonth(month)}`,
    body: (locale) => investorMessage(data, locale),
    link: `/reports?tab=investor&month=${month}`,
    eventType: 'daily_summary',
  });
  return 'sent';
}

/** Stored monthly PDFs, newest first. */
export async function investorArchive() {
  const rows = await tx()
    .select({ data: events.data, occurredAt: events.occurredAt })
    .from(events)
    .where(and(eq(events.farmId, ctx().farmId), eq(events.type, SNAPSHOT_EVENT)))
    .orderBy(desc(events.occurredAt))
    .limit(36);
  const out = [];
  for (const row of rows) {
    const fileId = String(row.data.fileId);
    out.push({ month: String(row.data.month), generatedAt: row.occurredAt, url: await signedFileUrl(fileId) });
  }
  return out;
}
