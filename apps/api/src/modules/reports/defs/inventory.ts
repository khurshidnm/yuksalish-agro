import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { ITEM_CATEGORIES, MOVEMENT_TYPES, deviationPercent, round } from '@yap/shared';
import { schema } from '../../../db/client';
import { ctx, tx } from '../../../core/context';
import { sumOf } from '../../../core/query';
import { winterPlan } from '../../feed/balance.service';
import { list as listRations } from '../../feed/rations.service';
import { expiring, balances, movements } from '../../inventory/stock.service';
import { feedBalance, feedConsumption, lowStock } from '../../inventory/summary';
import type { ReportDefinition } from '../types';
import { col, filter } from './_helpers';

const { dailyLogLines, dailyLogs, herds, items, stockCountLines, stockCounts, warehouses } = schema;

/** Everything, for a report: list endpoints page, but a report covers the whole farm. */
const ALL_ROWS = { page: 1, pageSize: 100_000 };

export const inventoryReports: ReportDefinition[] = [
  {
    key: 'inventory.balances',
    module: 'inventory',
    filters: [filter.warehouse, filter.select('itemCategory', ITEM_CATEGORIES, 'itemCategory')],
    columns: [
      col.text('item'),
      col.enum('itemCategory', 'itemCategory'),
      col.text('warehouse'),
      col.num('qty', 3),
      col.enum('unit', 'unit'),
      col.num('minQty', 3),
      col.date('nearestExpiry'),
      col.money('avgCost'),
      col.money('value', { sum: true, label: 'stockValue' }),
    ],
    async run({ warehouseId, itemCategory }) {
      const { data } = await balances({ ...ALL_ROWS, warehouseId, category: itemCategory });
      return {
        rows: data.map((r) => ({ ...r, item: r.name, itemCategory: r.category, warehouse: r.warehouseName })),
      };
    },
  },
  {
    key: 'inventory.movements',
    module: 'inventory',
    filters: [filter.period('this_month'), filter.warehouse, filter.select('type', MOVEMENT_TYPES, 'movementType')],
    columns: [
      col.date('date'),
      col.enum('type', 'movementType'),
      col.text('docNo'),
      col.text('item'),
      col.text('warehouse'),
      col.num('qty', 3),
      col.enum('unit', 'unit'),
      col.text('costCenter'),
      col.text('reason'),
      col.money('unitCost'),
      col.money('totalCost', { sum: true }),
    ],
    async run({ from, to, warehouseId, type }) {
      const { data } = await movements({ ...ALL_ROWS, from, to, warehouseId, type });
      return {
        rows: data.map((r) => ({ ...r, item: r.itemName, warehouse: r.warehouseName, costCenter: r.costCenterName })),
      };
    },
  },
  {
    key: 'inventory.expiring',
    module: 'inventory',
    filters: [filter.days(60, 730)],
    columns: [
      col.date('expiryDate'),
      col.bool('expired'),
      col.text('item'),
      col.enum('itemCategory', 'itemCategory'),
      col.text('warehouse'),
      col.text('batchNo'),
      col.num('qtyRemaining', 3),
      col.enum('unit', 'unit'),
      col.money('value', { sum: true, label: 'stockValue' }),
    ],
    async run({ days }) {
      const rows = await expiring(days);
      return {
        rows: rows.map((r) => ({
          ...r,
          item: r.itemName,
          itemCategory: r.category,
          warehouse: r.warehouseName,
          value: r.unitCost === null ? null : round(r.qtyRemaining * r.unitCost, 2),
        })),
      };
    },
  },
  {
    key: 'inventory.low_stock',
    module: 'inventory',
    filters: [],
    columns: [
      col.text('item'),
      col.num('stockQty', 3),
      col.enum('unit', 'unit'),
      col.num('minQty', 3),
      col.num('days', 1),
      col.num('minDays', 1),
      col.enum('reason', 'reports:lowStockReason'),
    ],
    async run() {
      const rows = await lowStock();
      return { rows: rows.map((r) => ({ ...r, item: r.name })) };
    },
  },
  {
    key: 'inventory.count_differences',
    module: 'inventory',
    filters: [filter.period('this_year'), filter.warehouse],
    columns: [
      col.date('date'),
      col.text('docNo'),
      col.text('warehouse'),
      col.text('item'),
      col.num('systemQty', 3),
      col.num('actualQty', 3),
      col.num('diffQty', 3),
      col.enum('unit', 'unit'),
      col.money('diffCost', { sum: true }),
    ],
    async run({ from, to, warehouseId }) {
      const rows = await tx()
        .select({
          date: stockCounts.date,
          docNo: stockCounts.docNo,
          warehouse: warehouses.name,
          item: items.name,
          systemQty: stockCountLines.systemQty,
          actualQty: stockCountLines.actualQty,
          diffQty: stockCountLines.diffQty,
          unit: items.unit,
          diffCost: stockCountLines.diffCost,
        })
        .from(stockCountLines)
        .innerJoin(stockCounts, eq(stockCounts.id, stockCountLines.countId))
        .innerJoin(warehouses, eq(warehouses.id, stockCounts.warehouseId))
        .innerJoin(items, eq(items.id, stockCountLines.itemId))
        .where(
          and(
            eq(stockCounts.farmId, ctx().farmId),
            eq(stockCounts.status, 'approved'),
            gte(stockCounts.date, from),
            lte(stockCounts.date, to),
            warehouseId ? eq(stockCounts.warehouseId, warehouseId) : undefined,
            sql`${stockCountLines.diffQty} <> 0`,
          ),
        )
        .orderBy(desc(stockCounts.date), asc(items.name));
      return { rows };
    },
  },
];

export const feedReports: ReportDefinition[] = [
  {
    key: 'feed.days_remaining',
    module: 'feed',
    filters: [],
    columns: [
      col.text('item'),
      col.num('stockQty', 3),
      col.enum('unit', 'unit'),
      col.num('plannedDaily', 3),
      col.num('actualDaily', 3),
      col.num('daysByPlan', 1),
      col.num('daysByActual', 1),
      col.num('days', 1),
      col.enum('basis', 'reports:feedBasis'),
      col.bool('belowMinimum'),
    ],
    chart: { kind: 'bar', x: 'item', series: ['days'] },
    async run() {
      const rows = await feedBalance();
      return { rows: rows.map((r) => ({ ...r, item: r.name })) };
    },
  },
  {
    key: 'feed.consumption_by_herd',
    module: 'feed',
    filters: [filter.period('this_month'), filter.herd],
    columns: [
      col.text('herd'),
      col.text('item'),
      col.enum('unit', 'unit'),
      col.num('plannedQty', 3, { sum: true }),
      col.num('actualQty', 3, { sum: true }),
      col.pct('deviationPercent'),
      col.money('totalCost', { sum: true }),
    ],
    compare: { filter: 'period', by: ['herd', 'item', 'unit'], values: ['actualQty'] },
    async run({ from, to, herdId }) {
      const rows = await tx()
        .select({
          herd: herds.name,
          item: items.name,
          unit: items.unit,
          plannedQty: sumOf(dailyLogLines.plannedQty),
          actualQty: sumOf(dailyLogLines.actualQty),
          totalCost: sumOf(dailyLogLines.totalCost),
        })
        .from(dailyLogLines)
        .innerJoin(dailyLogs, eq(dailyLogs.id, dailyLogLines.logId))
        .innerJoin(herds, eq(herds.id, dailyLogs.herdId))
        .innerJoin(items, eq(items.id, dailyLogLines.itemId))
        .where(
          and(
            eq(dailyLogs.farmId, ctx().farmId),
            gte(dailyLogs.date, from),
            lte(dailyLogs.date, to),
            herdId ? eq(dailyLogs.herdId, herdId) : undefined,
          ),
        )
        .groupBy(herds.name, items.name, items.unit)
        .orderBy(asc(herds.name), asc(items.name));
      return {
        rows: rows.map((r) => {
          const deviation = deviationPercent(r.actualQty, r.plannedQty);
          return { ...r, deviationPercent: deviation === null ? null : round(deviation, 1) };
        }),
      };
    },
  },
  {
    key: 'feed.daily_consumption',
    module: 'feed',
    filters: [filter.days(30, 365)],
    columns: [col.date('date'), col.num('qtyKg', 3, { sum: true })],
    chart: { kind: 'line', x: 'date', series: ['qtyKg'] },
    async run({ days }) {
      const rows = await feedConsumption(days);
      return { rows: rows.map((r) => ({ date: r.date, qtyKg: r.qty })) };
    },
  },
  {
    key: 'feed.ration_cost',
    module: 'feed',
    money: true,
    filters: [],
    columns: [
      col.text('ration'),
      col.enum('state', 'physiologicalState'),
      col.num('totalKgPerHeadDay', 3),
      col.money('costPerHeadDay'),
      col.int('seasonDays'),
      col.money('costPerSeason'),
    ],
    async run() {
      const { data } = await listRations({ ...ALL_ROWS });
      return { rows: data.map((r) => ({ ...r, ration: r.name })) };
    },
  },
  {
    key: 'feed.winter_plan',
    module: 'feed',
    filters: [],
    columns: [
      col.text('item'),
      col.num('requiredKg', 1, { sum: true }),
      col.num('stockKg', 1, { sum: true }),
      col.num('shortageKg', 1, { sum: true }),
      col.num('surplusKg', 1, { sum: true }),
      col.num('coverageDays', 1),
      col.date('runsOutOn'),
      col.num('hectares', 2),
      col.money('purchaseCost', { sum: true }),
    ],
    async run() {
      const plan = await winterPlan({});
      return { rows: plan.rows.map((r) => ({ ...r, item: r.name })) };
    },
  },
];
