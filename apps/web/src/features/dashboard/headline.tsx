import { Beef, CalendarClock, CircleDollarSign, HandCoins, HeartPulse, type LucideIcon, PiggyBank, ReceiptText, Skull, Sprout, TriangleAlert, Users, Wheat, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import type { StatTone } from '@/components';
import { MoneyText } from '@/components';
import { formatDateLong, formatNumber, formatPercent, formatQty } from '@/lib/format';
import { daysNumber, type LinkTo } from './shared';
import type { BlockKey, CropsData, DashboardData, FeedData, FinanceData, LivestockData, StaffData } from './types';

export interface TileSpec {
  key: string;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  to?: string;
  tone?: StatTone;
  icon?: LucideIcon;
}

const compact = (value: number) => <MoneyText value={value} compact className="whitespace-normal" />;

function financeTiles(d: FinanceData, t: TFunction, link: LinkTo): TileSpec[] {
  const { budget, debts } = d;
  return [
    {
      key: 'cash',
      label: t('finance.cash'),
      value: compact(d.cash.total),
      to: link('/finance/accounts', 'finance.view'),
      icon: PiggyBank,
      tone: d.cash.total < 0 ? 'danger' : 'neutral',
    },
    {
      key: 'expense',
      label: t('finance.monthExpense'),
      value: compact(d.month.expense),
      hint: <>{t('finance.monthIncome')}: <MoneyText value={d.month.income} compact /></>,
      to: link('/finance/transactions', 'finance.view'),
      icon: ReceiptText,
    },
    {
      key: 'budget',
      label: t('finance.budgetMonth'),
      value: budget.month.percent === null ? null : formatPercent(budget.month.percent, 0),
      to: link('/finance/budget', 'finance.view'),
      icon: CircleDollarSign,
      tone: budget.month.percent !== null && budget.month.percent > 100 ? 'danger' : 'neutral',
    },
    {
      key: 'debts',
      label: t('finance.overdueDebts'),
      value: compact(debts.overdue),
      hint: <>{t('finance.payable')}: <MoneyText value={debts.payable} compact /></>,
      to: link('/finance/debts', 'finance.view'),
      icon: HandCoins,
      tone: debts.overdue > 0 ? 'warning' : 'neutral',
    },
  ];
}

function livestockTiles(d: LivestockData, t: TFunction, link: LinkTo): TileSpec[] {
  const unwell = d.sick + d.quarantine;
  return [
    {
      key: 'head',
      label: t('livestock.total'),
      value: t('head', { value: formatNumber(d.total, 0) }),
      hint: t('livestock.pregnantHint', { value: formatNumber(d.pregnant, 0) }),
      to: link('/livestock/animals', 'livestock.view'),
      icon: Beef,
    },
    {
      key: 'lambing',
      label: t('livestock.nextLambing'),
      value: d.lambing.nextDate ? formatDateLong(d.lambing.nextDate) : null,
      hint: t('livestock.next7Days', { value: formatNumber(d.lambing.next7Days, 0) }),
      to: link('/livestock/breeding?tab=calendar', 'livestock.view'),
      icon: CalendarClock,
    },
    {
      key: 'unwell',
      label: t('livestock.unwell'),
      value: t('head', { value: formatNumber(unwell, 0) }),
      hint: t('livestock.unwellHint', { sick: formatNumber(d.sick, 0), quarantine: formatNumber(d.quarantine, 0) }),
      to: link('/livestock/animals?status=sick', 'livestock.view'),
      icon: HeartPulse,
      tone: unwell > 0 ? 'warning' : 'neutral',
    },
    {
      key: 'deaths',
      label: t('livestock.deaths30'),
      value: t('head', { value: formatNumber(d.mortality.dead, 0) }),
      hint: d.mortality.percent === null ? undefined : formatPercent(d.mortality.percent, 2),
      to: link('/livestock/exits', 'livestock.view'),
      icon: Skull,
      tone: d.mortality.dead > 0 ? 'warning' : 'neutral',
    },
  ];
}

function feedTiles(d: FeedData, t: TFunction, link: LinkTo): TileSpec[] {
  const balance = link('/feed/balance', 'feed.view') ?? link('/inventory/stock', 'inventory.view');
  return [
    {
      key: 'days',
      label: t('feed.lowestDays'),
      value: d.limiting ? t('days', { value: daysNumber(d.limiting.days) }) : null,
      hint: d.limiting?.name,
      to: balance,
      icon: Wheat,
      tone: d.lowStockCount > 0 ? 'warning' : 'neutral',
    },
    {
      key: 'low',
      label: t('feed.belowMinimum'),
      value: formatNumber(d.lowStockCount, 0),
      to: link('/inventory/stock', 'inventory.view') ?? balance,
      icon: TriangleAlert,
      tone: d.lowStockCount > 0 ? 'warning' : 'neutral',
    },
    {
      key: 'daily',
      label: t('feed.dailyUse'),
      value: d.avgDailyKg === null ? null : formatQty(d.avgDailyKg, 'kg', 0),
      to: balance,
      icon: Wheat,
    },
  ];
}

function cropsTiles(d: CropsData, t: TFunction, link: LinkTo): TileSpec[] {
  return [
    {
      key: 'sown',
      label: t('crops.sown'),
      value: t('crops.ofTotal', { value: formatNumber(d.status.sown, 0), total: formatNumber(d.status.total, 0) }),
      to: link('/crops/plans', 'crops.view'),
      icon: Sprout,
    },
    {
      key: 'overdue',
      label: t('crops.overdue'),
      value: formatNumber(d.overdueCount, 0),
      to: link('/crops/operations', 'crops.view'),
      icon: CalendarClock,
      tone: d.overdueCount > 0 ? 'warning' : 'neutral',
    },
    {
      key: 'harvest',
      label: t('crops.harvest'),
      value: t('crops.harvestValue', { actual: formatNumber(d.harvest.actualT, 1), planned: formatNumber(d.harvest.plannedT, 1) }),
      to: link('/crops/harvests', 'crops.view'),
      icon: Wheat,
    },
  ];
}

function staffTiles(d: StaffData, t: TFunction, link: LinkTo): TileSpec[] {
  const tiles: TileSpec[] = [];
  if (d.attendance) {
    tiles.push({
      key: 'present',
      label: t('staff.present'),
      value: t('crops.ofTotal', { value: formatNumber(d.attendance.present, 0), total: formatNumber(d.attendance.total, 0) }),
      to: link('/hr/timesheet', 'hr.view'),
      icon: Users,
    });
  }
  if (d.tasks) {
    tiles.push({
      key: 'tasks',
      label: t('staff.tasksDone'),
      value: formatNumber(d.tasks.doneToday, 0),
      hint: t('staff.tasksHint', { open: formatNumber(d.tasks.open, 0), overdue: formatNumber(d.tasks.overdue, 0) }),
      to: link('/tasks', 'tasks.view'),
      icon: Users,
      tone: d.tasks.overdue > 0 ? 'warning' : 'neutral',
    });
  }
  if (d.machinery) {
    tiles.push({
      key: 'machinery',
      label: t('staff.machinery'),
      value: t('crops.ofTotal', { value: formatNumber(d.machinery.byStatus.working ?? 0, 0), total: formatNumber(d.machinery.total, 0) }),
      hint: t('staff.machineryHint', { repair: formatNumber(d.machinery.byStatus.repair ?? 0, 0), due: formatNumber(d.machinery.maintenanceDue, 0) }),
      to: link('/assets', 'assets.view'),
      icon: Wrench,
      tone: (d.machinery.byStatus.repair ?? 0) > 0 ? 'warning' : 'neutral',
    });
  }
  if (d.fuel) {
    tiles.push({
      key: 'fuel',
      label: t('staff.fuel'),
      value: formatQty(d.fuel.liters, 'l', 0),
      hint: t('staff.fuelHint', { days: d.fuel.days }),
      to: link('/assets', 'assets.view'),
      icon: Wrench,
    });
  }
  return tiles;
}

export function blockTiles(key: BlockKey, data: DashboardData, t: TFunction, link: LinkTo): TileSpec[] {
  const b = data.blocks;
  switch (key) {
    case 'finance':
      return b.finance?.data ? financeTiles(b.finance.data, t, link) : [];
    case 'livestock':
      return b.livestock?.data ? livestockTiles(b.livestock.data, t, link) : [];
    case 'feed':
      return b.feed?.data ? feedTiles(b.feed.data, t, link) : [];
    case 'crops':
      return b.crops?.data ? cropsTiles(b.crops.data, t, link) : [];
    case 'staff':
      return b.staff?.data ? staffTiles(b.staff.data, t, link) : [];
    default:
      return [];
  }
}

const MAX_TILES = 8;

/**
 * The top of the page. The reader's main block in full, then the lead figure of every other block,
 * so one look covers the whole farm and the first row is what this role cares about most.
 */
export function headlineTiles(data: DashboardData, t: TFunction, link: LinkTo): TileSpec[] {
  const withTiles = data.order.map((key) => blockTiles(key, data, t, link)).filter((tiles) => tiles.length > 0);
  const [main = [], ...others] = withTiles;
  return [...main, ...others.map((tiles) => tiles[0])].slice(0, MAX_TILES);
}
