import { and, eq, sql } from 'drizzle-orm';
import { addDays, monthOf, monthRange, round, straightLineMonthly, todayIso, unitsOfProductionDepreciation } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { postTransaction } from '../../core/ledger';
import { sumOf } from '../../core/query';
import { assetCostCenter, getAssetRow, isInOpening } from './assets.service';

const { assets, assetUsageLogs, depreciationEntries: t, farms, financeCategories } = schema;

type Asset = typeof assets.$inferSelect;

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

export function previousMonth(month: string): string {
  return monthOf(addDays(`${month}-01`, -1));
}

function nextMonth(month: string): string {
  return monthOf(addDays(monthRange(month).to, 1));
}

/** Every month from `first` to `last`, both included, oldest first. */
export function monthsFrom(first: string, last: string): string[] {
  const months: string[] = [];
  for (let m = first; m <= last; m = nextMonth(m)) months.push(m);
  return months;
}

const onTheBooks = () => and(eq(assets.farmId, ctx().farmId), sql`${assets.status} <> 'written_off'`);

/** Depreciation for one month, never exceeding what is left to depreciate. */
async function amountFor(asset: Asset, month: string): Promise<number> {
  const price = asset.purchasePrice ?? 0;
  const purchaseMonth = asset.purchaseDate ? monthOf(asset.purchaseDate) : null;
  // Depreciation starts the month after the machine enters service.
  if (asset.rented || price <= 0 || !purchaseMonth || month <= purchaseMonth) return 0;
  if (isInOpening(asset, month)) return 0;

  const [{ posted }] = await tx()
    .select({ posted: sumOf(t.amount) })
    .from(t)
    .where(eq(t.assetId, asset.id));
  const remaining = Math.max(0, price - asset.salvageValue - asset.openingDepreciation - posted);

  if (asset.depreciationMethod === 'units') {
    if (!asset.totalUnits) return 0;
    const { from, to } = monthRange(month);
    const [{ hours }] = await tx()
      .select({ hours: sumOf(assetUsageLogs.motoHours) })
      .from(assetUsageLogs)
      .where(and(eq(assetUsageLogs.assetId, asset.id), sql`${assetUsageLogs.date} between ${from} and ${to}`));
    const amount = unitsOfProductionDepreciation(price, asset.salvageValue, asset.totalUnits, hours) ?? 0;
    return round(Math.min(amount, remaining), 2);
  }

  if (!asset.usefulLifeMonths) return 0;
  const monthly = straightLineMonthly(price, asset.salvageValue, asset.usefulLifeMonths) ?? 0;
  // Counted from the purchase, so a machine older than its useful life stays at zero even when
  // the platform started after it was bought.
  const elapsed = monthsBetween(purchaseMonth, month) - 1;
  if (elapsed >= asset.usefulLifeMonths) return 0;
  return round(Math.min(monthly, remaining), 2);
}

/**
 * Post one month for every machine. Safe to repeat: depreciation_entries is unique per asset and
 * month, so a machine already done is skipped. Non-cash, so account balances do not move.
 */
export async function runDepreciation(month: string): Promise<{ month: string; posted: number; total: number }> {
  const c = ctx();
  if (month >= monthOf(today())) {
    throw badRequest('MONTH_NOT_CLOSED', 'Depreciation is posted after the month has ended');
  }
  const [category] = await tx()
    .select({ id: financeCategories.id })
    .from(financeCategories)
    .where(and(eq(financeCategories.tenantId, c.tenantId), eq(financeCategories.key, 'depreciation')));
  if (!category) throw badRequest('CATEGORY_NOT_FOUND', 'Finance category depreciation does not exist');

  // Locked, because each amount is capped by what is already posted: two months at once would
  // both see the same amount left and go past it.
  const rows = await tx().select().from(assets).where(onTheBooks()).orderBy(assets.id).for('update');

  let posted = 0;
  let total = 0;
  for (const asset of rows) {
    const amount = await amountFor(asset, month);
    if (amount <= 0) continue;

    const [entry] = await tx()
      .insert(t)
      .values({ tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId, assetId: asset.id, month, amount })
      .onConflictDoNothing()
      .returning();
    if (!entry) continue;

    const transaction = await postTransaction({
      date: monthRange(month).to,
      type: 'expense',
      categoryId: category.id,
      amount,
      paymentMethod: 'non_cash',
      costCenterId: await assetCostCenter(asset),
      autoApprove: true,
      description: `Amortizatsiya: ${asset.name} (${month})`,
      sourceType: 'depreciation',
      sourceId: entry.id,
    });
    await tx().update(t).set({ transactionId: transaction.id }).where(eq(t.id, entry.id));
    posted += 1;
    total += amount;
  }

  if (posted > 0) {
    await recordEvent({ type: 'asset.depreciation_posted', data: { month, posted, total: round(total, 2) } });
  }
  return { month, posted, total: round(total, 2) };
}

/** Oldest first: each month is capped by what the one before it left. */
export async function postMonths(months: string[]) {
  const runs = [];
  for (const month of months) runs.push(await runDepreciation(month));
  const posted = runs.filter((run) => run.posted > 0);
  return {
    months: posted,
    posted: posted.reduce((sum, run) => sum + run.posted, 0),
    total: round(posted.reduce((sum, run) => sum + run.total, 0), 2),
  };
}

async function farmStartMonth(): Promise<string> {
  const c = ctx();
  const [farm] = await tx().select({ createdAt: farms.createdAt }).from(farms).where(eq(farms.id, c.farmId));
  return monthOf(todayIso(c.timezone, farm.createdAt));
}

/**
 * Months to post now: every ended month in which some machine still has an amount due, so a machine
 * added after a month ran gets that month, and a run that failed or a server that was down catches
 * up. The ledger starts at the month the farm was created, or at the first month posted if that is
 * earlier, and nothing reaches back past it. The opening figure holds its own months (amountFor).
 */
export async function monthsToRun(): Promise<string[]> {
  const entries = await tx().select({ assetId: t.assetId, month: t.month }).from(t).where(eq(t.farmId, ctx().farmId));
  const posted = new Set(entries.map((entry) => `${entry.assetId} ${entry.month}`));
  const start = entries.reduce((first, entry) => (entry.month < first ? entry.month : first), await farmStartMonth());
  const machines = await tx().select().from(assets).where(onTheBooks());

  const due: string[] = [];
  for (const month of monthsFrom(start, previousMonth(monthOf(today())))) {
    for (const machine of machines) {
      if (posted.has(`${machine.id} ${month}`) || (await amountFor(machine, month)) <= 0) continue;
      due.push(month);
      break;
    }
  }
  return due;
}

export async function listDepreciation(assetId: string) {
  await getAssetRow(assetId);
  return tx().select().from(t).where(eq(t.assetId, assetId)).orderBy(sql`${t.month} desc`);
}
