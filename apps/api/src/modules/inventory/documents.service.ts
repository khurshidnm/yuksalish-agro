/** Warehouse paperwork as PDF (spec 9.2), in the language of the person printing it. */
import { resources, type LanguageCode } from '@yap/shared/i18n';
import { and, asc, eq } from 'drizzle-orm';
import type { TableCell } from 'pdfmake/interfaces';
import { schema } from '../../db/client';
import { canSeeMoney, ctx, tx } from '../../core/context';
import { notFound } from '../../core/errors';
import * as counts from './counts.service';
import { renderDocument, type DocumentLayout } from './pdf';

const { costCenters, counterparties, farms, items, stockBatches, stockCounts, stockMovements, users, warehouses } = schema;

type Strings = Record<string, string>;

function strings(lang: LanguageCode) {
  const bundle = resources[lang] as unknown as {
    inventory: { pdf?: Strings; reason?: Strings };
    enums: { unit?: Strings };
  };
  const pdf = bundle.inventory.pdf ?? {};
  return {
    t: (key: string) => pdf[key] ?? key,
    unit: (unit: string) => bundle.enums.unit?.[unit] ?? unit,
    reason: (reason: string | null) => (reason ? (bundle.inventory.reason?.[reason] ?? reason) : ''),
  };
}

function formatter(lang: LanguageCode) {
  // Uzbek writes numbers as Russian does, and `uz` number data is unreliable across ICU builds.
  const locale = lang === 'en' ? 'en-US' : 'ru-RU';
  const money = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const quantity = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  return {
    money: (value: number) => money.format(value),
    qty: (value: number) => quantity.format(value),
    date: (iso: string) => iso.split('-').reverse().join('.'),
  };
}

async function farmName(): Promise<string> {
  const [farm] = await tx().select({ name: farms.name }).from(farms).where(eq(farms.id, ctx().farmId));
  return farm?.name ?? '';
}

const right = (text: string): TableCell => ({ text, alignment: 'right' });
const head = (text: string, alignRight = false): TableCell => ({
  text,
  bold: true,
  ...(alignRight ? { alignment: 'right' as const } : {}),
});

/** Layout is separate from rendering so that tests can read what a document contains. */
export async function documentLayout(docNo: string, lang: LanguageCode): Promise<DocumentLayout> {
  const m = stockMovements;
  const rows = await tx()
    .select({
      type: m.type,
      date: m.date,
      qty: m.qty,
      unitCost: m.unitCost,
      totalCost: m.totalCost,
      reason: m.reason,
      notes: m.notes,
      itemName: items.name,
      unit: items.unit,
      warehouseName: warehouses.name,
      costCenterName: costCenters.name,
      batchNo: stockBatches.batchNo,
      invoiceNo: stockBatches.invoiceNo,
      expiryDate: stockBatches.expiryDate,
      counterpartyName: counterparties.name,
      createdByName: users.fullName,
    })
    .from(m)
    .innerJoin(items, eq(items.id, m.itemId))
    .innerJoin(warehouses, eq(warehouses.id, m.warehouseId))
    .innerJoin(stockBatches, eq(stockBatches.id, m.batchId))
    .leftJoin(costCenters, eq(costCenters.id, m.costCenterId))
    .leftJoin(counterparties, eq(counterparties.id, stockBatches.counterpartyId))
    .leftJoin(users, eq(users.id, m.createdBy))
    .where(and(eq(m.farmId, ctx().farmId), eq(m.docNo, docNo)))
    .orderBy(asc(m.createdAt));
  if (rows.length === 0) throw notFound('Document');

  // Corrections from a stock count carry the count's number: their paper is the count act.
  if (rows[0].type.startsWith('adjustment')) {
    const [count] = await tx()
      .select({ id: stockCounts.id })
      .from(stockCounts)
      .where(and(eq(stockCounts.farmId, ctx().farmId), eq(stockCounts.docNo, docNo)));
    if (!count) throw notFound('Document');
    return countLayout(count.id, lang);
  }

  const { t, unit, reason } = strings(lang);
  const f = formatter(lang);
  const money = canSeeMoney();
  const first = rows[0];
  const isTransfer = first.type.startsWith('transfer');
  const lines = isTransfer ? rows.filter((r) => r.type === 'transfer_out') : rows;
  const total = lines.reduce((sum, r) => sum + r.totalCost, 0);

  const details: [string, string][] = [[t('date'), f.date(first.date)]];
  let title = t('receiptTitle');
  let signatures = [t('signDelivered'), t('signReceived')];

  if (first.type === 'receipt') {
    details.push([t('warehouse'), first.warehouseName]);
    if (first.counterpartyName) details.push([t('supplier'), first.counterpartyName]);
    if (first.invoiceNo) details.push([t('invoice'), first.invoiceNo]);
  } else if (first.type === 'issue') {
    title = t('issueTitle');
    signatures = [t('signRequested'), t('signIssued')];
    details.push([t('warehouse'), first.warehouseName]);
    if (first.costCenterName) details.push([t('costCenter'), first.costCenterName]);
    if (first.reason) details.push([t('reason'), reason(first.reason)]);
  } else {
    title = t('transferTitle');
    signatures = [t('signIssued'), t('signReceived')];
    const destination = rows.find((r) => r.type === 'transfer_in');
    details.push([t('from'), lines[0]?.warehouseName ?? first.warehouseName]);
    if (destination) details.push([t('to'), destination.warehouseName]);
  }
  if (first.notes) details.push([t('notes'), first.notes]);
  if (first.createdByName) details.push([t('createdBy'), first.createdByName]);

  const withBatch = first.type === 'receipt';
  const header: TableCell[] = [
    head('№'),
    head(t('item')),
    ...(withBatch ? [head(t('batch'))] : []),
    head(t('unit')),
    head(t('qty'), true),
    ...(money ? [head(t('price'), true), head(t('amount'), true)] : []),
  ];
  const body = lines.map((line, index): TableCell[] => [
    String(index + 1),
    line.itemName,
    ...(withBatch ? [[line.batchNo, line.expiryDate ? `${t('expiry')}: ${f.date(line.expiryDate)}` : null].filter(Boolean).join('\n')] : []),
    unit(line.unit),
    right(f.qty(line.qty)),
    ...(money ? [right(f.money(line.unitCost)), right(f.money(line.totalCost))] : []),
  ]);

  return {
    title,
    docNo,
    farm: await farmName(),
    details,
    table: [header, ...body],
    widths: [20, '*', ...(withBatch ? [90] : []), 40, 60, ...(money ? [65, 75] : [])],
    footer: money ? [`${t('total')}: ${f.money(total)} ${ctx().currency}`] : [],
    signatures,
  };
}

export async function documentPdf(docNo: string, lang: LanguageCode): Promise<Buffer> {
  return renderDocument(await documentLayout(docNo, lang));
}

export async function countLayout(id: string, lang: LanguageCode): Promise<DocumentLayout> {
  const count = await counts.get(id);
  const { t, unit } = strings(lang);
  const f = formatter(lang);
  const money = canSeeMoney();
  const totalDiff = count.lines.reduce((sum, line) => sum + (line.diffCost ?? 0), 0);

  const details: [string, string][] = [
    [t('date'), f.date(count.date)],
    [t('warehouse'), count.warehouseName ?? ''],
    [t('status'), count.status === 'approved' ? t('statusApproved') : t('statusDraft')],
  ];
  if (count.approvedByName) details.push([t('approvedBy'), count.approvedByName]);
  if (count.notes) details.push([t('notes'), count.notes]);

  return {
    title: t('countTitle'),
    docNo: count.docNo ?? '',
    farm: await farmName(),
    details,
    table: [
      [
        head('№'),
        head(t('item')),
        head(t('unit')),
        head(t('system'), true),
        head(t('actual'), true),
        head(t('difference'), true),
        ...(money ? [head(t('amount'), true)] : []),
      ],
      ...count.lines.map((line, index): TableCell[] => [
        String(index + 1),
        line.itemName,
        unit(line.unit),
        right(f.qty(line.systemQty)),
        right(f.qty(line.actualQty)),
        right(f.qty(line.diffQty)),
        ...(money ? [right(f.money(line.diffCost ?? 0))] : []),
      ]),
    ],
    widths: [20, '*', 40, 60, 60, 60, ...(money ? [70] : [])],
    footer: money ? [`${t('total')}: ${f.money(totalDiff)} ${ctx().currency}`] : [],
    signatures: [t('signCommission'), t('signStorekeeper')],
  };
}

export async function countPdf(id: string, lang: LanguageCode): Promise<Buffer> {
  return renderDocument(await countLayout(id, lang));
}
