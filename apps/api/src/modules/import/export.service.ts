/**
 * Downloads of the main lists (spec 19, 20.3). Rows come from each module's own list function, so
 * the money and personal-data rules that apply on screen apply here too; a hidden column is then
 * left out of the file rather than shown empty.
 */
import { PII_VIEW, type Permission } from '@yap/shared';
import { canSeeMoney, hasPermission } from '../../core/context';
import { forbidden } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import type { I18nName } from '../../db/schema';
import { listFields } from '../farm/fields.service';
import * as counterparties from '../finance/counterparties.service';
import * as transactions from '../finance/transactions.service';
import * as employees from '../hr/employees.service';
import { balances } from '../inventory/stock.service';
import { listAnimals } from '../livestock/animals.service';
import { enumLabel, localized, tr, type LanguageCode } from './i18n';
import { exportCsv, exportXlsx, type ExportColumn } from './workbook';

type Row = Record<string, unknown>;

interface EntityColumn {
  key: string;
  kind?: 'date' | 'number';
  /** Left out of the file when this is false. */
  visible?: () => boolean;
  value(row: Row, lang: LanguageCode): unknown;
}

interface Entity {
  key: string;
  permission: Permission;
  columns: EntityColumn[];
  fetch(params: ExportParams): Promise<Row[]>;
}

export interface ExportParams {
  from?: string;
  to?: string;
}

const PAGE = 200;
const MAX_EXPORT_ROWS = 100_000;

const canSeePii = () => hasPermission(PII_VIEW as Permission);
const canSeeRates = () => canSeePii() && (canSeeMoney() || hasPermission('payroll.view' as Permission));

/** Read a list function to the end, a page at a time. */
async function allPages<T>(load: (page: number) => Promise<{ data: T[]; meta: { total: number } }>): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; rows.length < MAX_EXPORT_ROWS; page++) {
    const result = await load(page);
    rows.push(...result.data);
    if (rows.length >= result.meta.total || result.data.length === 0) break;
  }
  return rows;
}

const field = (key: string, kind?: EntityColumn['kind']): EntityColumn => ({ key, kind, value: (row) => row[key] ?? null });
const enumField = (key: string, group: string): EntityColumn => ({
  key,
  value: (row, lang) => (row[key] ? enumLabel(lang, group, String(row[key])) : null),
});

export const ENTITIES: Entity[] = [
  {
    key: 'animals',
    permission: 'livestock.view',
    columns: [
      field('tag'),
      field('breedName'),
      enumField('sex', 'sex'),
      enumField('category', 'animalCategory'),
      enumField('status', 'animalStatus'),
      field('birthDate', 'date'),
      field('herdName'),
      field('currentWeightKg', 'number'),
      field('lastWeighedOn', 'date'),
      field('purchaseDate', 'date'),
      { ...field('purchasePrice', 'number'), visible: canSeeMoney },
    ],
    fetch: () =>
      allPages((page) => listAnimals({ page, pageSize: PAGE, scope: 'all' })) as unknown as Promise<Row[]>,
  },
  {
    key: 'fields',
    permission: 'farm.view',
    columns: [
      field('number'),
      field('name'),
      enumField('landUse', 'landUse'),
      field('areaHa', 'number'),
      field('soilType'),
      field('irrigationSource'),
      {
        key: 'crop',
        value: (row, lang) => {
          const crop = row.currentCrop as { cropName?: I18nName } | null;
          return crop?.cropName ? localized(crop.cropName, lang) : null;
        },
      },
      { key: 'variety', value: (row) => (row.currentCrop as { variety?: string } | null)?.variety ?? null },
    ],
    fetch: () =>
      allPages((page) => listFields({ page, pageSize: PAGE, status: 'active' })) as unknown as Promise<Row[]>,
  },
  {
    key: 'stock',
    permission: 'inventory.view',
    columns: [
      field('name'),
      enumField('category', 'itemCategory'),
      field('warehouseName'),
      field('qty', 'number'),
      enumField('unit', 'unit'),
      field('nearestExpiry', 'date'),
      { ...field('avgCost', 'number'), visible: canSeeMoney },
      { ...field('value', 'number'), visible: canSeeMoney },
    ],
    fetch: () => allPages((page) => balances({ page, pageSize: PAGE })),
  },
  {
    key: 'employees',
    permission: 'hr.view',
    columns: [
      { ...field('fullName'), visible: canSeePii },
      field('position'),
      field('division'),
      enumField('status', 'employeeStatus'),
      field('hireDate', 'date'),
      enumField('payType', 'payType'),
      { ...field('baseRate', 'number'), visible: canSeeRates },
      { ...field('phone'), visible: canSeePii },
    ],
    fetch: () => allPages((page) => employees.list({ page, pageSize: PAGE })) as unknown as Promise<Row[]>,
  },
  {
    key: 'counterparties',
    permission: 'finance.view',
    columns: [
      field('name'),
      field('tin'),
      enumField('type', 'counterpartyType'),
      field('phone'),
      field('address'),
      field('contactPerson'),
      { key: 'bankName', value: (row) => (row.bankDetails as { bankName?: string } | null)?.bankName ?? null },
      { key: 'bankAccount', value: (row) => (row.bankDetails as { account?: string } | null)?.account ?? null },
      { key: 'bankMfo', value: (row) => (row.bankDetails as { mfo?: string } | null)?.mfo ?? null },
    ],
    fetch: () => allPages((page) => counterparties.list({ page, pageSize: PAGE })) as unknown as Promise<Row[]>,
  },
  {
    key: 'transactions',
    permission: 'finance.view',
    columns: [
      field('date', 'date'),
      enumField('type', 'transactionType'),
      {
        key: 'category',
        value: (row, lang) => (row.categoryName ? localized(row.categoryName as I18nName, lang) : null),
      },
      field('amount', 'number'),
      field('currency'),
      field('amountBase', 'number'),
      enumField('paymentMethod', 'paymentMethod'),
      field('accountName'),
      field('counterpartyName'),
      field('costCenterName'),
      field('description'),
    ],
    fetch: (params) => transactions.exportRows(params) as unknown as Promise<Row[]>,
  },
];

export const ENTITY_KEYS = ENTITIES.map((e) => e.key) as [string, ...string[]];

export const listEntities = () => ENTITIES.map((e) => ({ key: e.key, allowed: hasPermission(e.permission) }));

export async function exportEntity(key: string, format: 'xlsx' | 'csv', lang: LanguageCode, params: ExportParams) {
  const entity = ENTITIES.find((e) => e.key === key)!;
  if (!hasPermission(entity.permission)) throw forbidden(undefined, 'FORBIDDEN', { required: entity.permission });

  const columns = entity.columns.filter((c) => !c.visible || c.visible());
  const rows = await entity.fetch(params);
  const table = rows.map((row) => columns.map((c) => c.value(row, lang)));
  const headers: ExportColumn[] = columns.map((c) => ({ header: tr(lang, `export.${key}.${c.key}`), kind: c.kind }));

  await recordEvent({ type: 'data.exported', entityType: key, data: { format, rows: rows.length } });

  const name = tr(lang, `export.${key}.file`);
  return format === 'csv'
    ? { body: exportCsv(headers, table), fileName: `${name}.csv`, contentType: 'text/csv; charset=utf-8' }
    : {
        body: await exportXlsx(name, headers, table),
        fileName: `${name}.xlsx`,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
}
