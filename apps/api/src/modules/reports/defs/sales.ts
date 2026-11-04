import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { PURCHASE_REQUEST_STATUSES, SALE_STATUSES } from '@yap/shared';
import { schema } from '../../../db/client';
import { ctx, tx } from '../../../core/context';
import { salesAnalysis } from '../../sales/summary';
import { enumLabel } from '../i18n';
import type { ReportDefinition } from '../types';
import { col, filter } from './_helpers';

const { counterparties, items, prices, purchaseRequests, sales } = schema;

const moneyColumns = () => [
  col.money('amount', { sum: true }),
  col.money('cost', { sum: true }),
  col.money('margin', { sum: true }),
  col.pct('marginPercent'),
];

export const salesReports: ReportDefinition[] = [
  {
    key: 'sales.by_product',
    module: 'sales',
    money: true,
    filters: [filter.period('this_year')],
    columns: [col.text('product'), col.enum('unit', 'unit'), col.num('qty', 3), col.money('avgPrice'), ...moneyColumns()],
    chart: { kind: 'bar', x: 'product', series: ['amount', 'cost'] },
    compare: { filter: 'period', by: ['product', 'unit'], values: ['amount', 'qty'] },
    async run({ from, to, lang }) {
      const { byProduct } = await salesAnalysis({ from, to });
      return {
        rows: byProduct.map((r) => ({
          ...r,
          product: r.itemName ?? (r.animalCategory ? enumLabel(lang, 'animalCategory', r.animalCategory) : null),
        })),
      };
    },
  },
  {
    key: 'sales.by_buyer',
    module: 'sales',
    money: true,
    filters: [filter.period('this_year')],
    columns: [col.text('buyer'), col.int('documents', { sum: true }), ...moneyColumns()],
    compare: { filter: 'period', by: ['buyer'], values: ['amount'] },
    async run({ from, to }) {
      const { byBuyer } = await salesAnalysis({ from, to });
      return { rows: byBuyer.map((r) => ({ ...r, buyer: r.name })) };
    },
  },
  {
    key: 'sales.by_month',
    module: 'sales',
    money: true,
    filters: [filter.period('this_year')],
    columns: [col.month('month'), ...moneyColumns()],
    chart: { kind: 'bar', x: 'month', series: ['amount', 'cost'] },
    async run({ from, to }) {
      const { byMonth } = await salesAnalysis({ from, to });
      return { rows: byMonth };
    },
  },
  {
    key: 'sales.documents',
    module: 'sales',
    money: true,
    filters: [filter.period('this_year'), filter.select('status', SALE_STATUSES, 'saleStatus')],
    columns: [
      col.date('date'),
      col.text('number'),
      col.text('buyer'),
      col.enum('status', 'saleStatus'),
      col.date('deliveryDate'),
      col.text('currency'),
      col.money('totalAmount'),
    ],
    async run({ from, to, status }) {
      const rows = await tx()
        .select({
          date: sales.date,
          number: sales.number,
          buyer: counterparties.name,
          status: sales.status,
          deliveryDate: sales.deliveryDate,
          currency: sales.currency,
          totalAmount: sales.totalAmount,
        })
        .from(sales)
        .innerJoin(counterparties, eq(counterparties.id, sales.counterpartyId))
        .where(
          and(
            eq(sales.farmId, ctx().farmId),
            gte(sales.date, from),
            lte(sales.date, to),
            status ? eq(sales.status, status) : undefined,
          ),
        )
        .orderBy(desc(sales.date));
      return { rows };
    },
  },
  {
    key: 'sales.prices',
    module: 'sales',
    money: true,
    filters: [filter.period('this_year')],
    columns: [col.date('date'), col.text('item'), col.text('kind'), col.money('price'), col.text('source')],
    async run({ from, to }) {
      const rows = await tx()
        .select({ date: prices.date, item: items.name, kind: prices.kind, price: prices.price, source: prices.source })
        .from(prices)
        .innerJoin(items, eq(items.id, prices.itemId))
        .where(and(eq(prices.farmId, ctx().farmId), gte(prices.date, from), lte(prices.date, to)))
        .orderBy(desc(prices.date));
      return { rows };
    },
  },
  {
    key: 'sales.purchases',
    module: 'sales',
    filters: [filter.period('this_year'), filter.select('status', PURCHASE_REQUEST_STATUSES, 'purchaseRequestStatus')],
    columns: [
      col.date('date'),
      col.text('item'),
      col.num('qty', 3),
      col.num('receivedQty', 3),
      col.enum('unit', 'unit'),
      col.text('supplier'),
      col.enum('status', 'purchaseRequestStatus'),
      col.money('expectedPrice'),
    ],
    async run({ from, to, status }) {
      const date = sql<string>`to_char(${purchaseRequests.createdAt} at time zone ${ctx().timezone}, 'YYYY-MM-DD')`;
      const rows = await tx()
        .select({
          date,
          item: items.name,
          qty: purchaseRequests.qty,
          receivedQty: purchaseRequests.receivedQty,
          unit: items.unit,
          supplier: counterparties.name,
          status: purchaseRequests.status,
          expectedPrice: purchaseRequests.expectedPrice,
        })
        .from(purchaseRequests)
        .innerJoin(items, eq(items.id, purchaseRequests.itemId))
        .leftJoin(counterparties, eq(counterparties.id, purchaseRequests.counterpartyId))
        .where(
          and(
            eq(purchaseRequests.farmId, ctx().farmId),
            sql`${date} >= ${from}`,
            sql`${date} <= ${to}`,
            status ? eq(purchaseRequests.status, status) : undefined,
          ),
        )
        .orderBy(desc(purchaseRequests.createdAt));
      return { rows };
    },
  },
];
