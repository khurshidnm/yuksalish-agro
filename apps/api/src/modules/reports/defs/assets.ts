import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import { ASSET_TYPES, MAINTENANCE_TYPES, deviationPercent, round } from '@yap/shared';
import { schema } from '../../../db/client';
import { ctx, tx } from '../../../core/context';
import { sumOf } from '../../../core/query';
import { assetCosts } from '../../assets/costs.service';
import type { ReportDefinition, Row } from '../types';
import { PII, col, filter } from './_helpers';

const { assetUsageLogs, assets, depreciationEntries, employees, fields, maintenanceRecords } = schema;

const nullableRound = (value: number | null, digits: number) => (value === null ? null : round(value, digits));

export const assetReports: ReportDefinition[] = [
  {
    key: 'assets.register',
    module: 'assets',
    filters: [filter.select('type', ASSET_TYPES, 'assetType')],
    columns: [
      col.text('asset'),
      col.enum('type', 'assetType'),
      col.text('inventoryNo'),
      col.enum('status', 'assetStatus'),
      col.num('motoHours', 2),
      col.bool('rented'),
      col.date('purchaseDate'),
      col.money('purchasePrice', { sum: true }),
    ],
    async run({ type }) {
      const rows = await tx()
        .select({
          asset: assets.name,
          type: assets.type,
          inventoryNo: assets.inventoryNo,
          status: assets.status,
          motoHours: assets.motoHours,
          rented: assets.rented,
          purchaseDate: assets.purchaseDate,
          purchasePrice: assets.purchasePrice,
        })
        .from(assets)
        .where(and(eq(assets.farmId, ctx().farmId), type ? eq(assets.type, type) : undefined))
        .orderBy(asc(assets.name));
      return { rows };
    },
  },
  {
    key: 'assets.usage',
    module: 'assets',
    filters: [filter.period('this_month'), filter.asset],
    columns: [
      col.date('date'),
      col.text('asset'),
      col.text('operator', { sensitive: PII }),
      col.text('field'),
      col.enum('workType', 'operationType'),
      col.num('motoHours', 2, { sum: true }),
      col.num('volumeHa', 2, { sum: true }),
      col.num('fuelL', 2, { sum: true }),
    ],
    async run({ from, to, assetId }) {
      const rows = await tx()
        .select({
          date: assetUsageLogs.date,
          asset: assets.name,
          operator: employees.fullName,
          field: fields.number,
          workType: assetUsageLogs.workType,
          motoHours: assetUsageLogs.motoHours,
          volumeHa: assetUsageLogs.volumeHa,
          fuelL: assetUsageLogs.fuelL,
        })
        .from(assetUsageLogs)
        .innerJoin(assets, eq(assets.id, assetUsageLogs.assetId))
        .leftJoin(employees, eq(employees.id, assetUsageLogs.operatorEmployeeId))
        .leftJoin(fields, eq(fields.id, assetUsageLogs.fieldId))
        .where(
          and(
            eq(assetUsageLogs.farmId, ctx().farmId),
            gte(assetUsageLogs.date, from),
            lte(assetUsageLogs.date, to),
            assetId ? eq(assetUsageLogs.assetId, assetId) : undefined,
          ),
        )
        .orderBy(desc(assetUsageLogs.date));
      return { rows };
    },
  },
  {
    key: 'assets.fuel',
    module: 'assets',
    filters: [filter.period('this_month')],
    columns: [
      col.text('asset'),
      col.num('motoHours', 2, { sum: true }),
      col.num('volumeHa', 2, { sum: true }),
      col.num('fuelL', 2, { sum: true }),
      col.num('litersPerHour', 2),
      col.num('normLPerHour', 2),
      col.pct('deviationPercent'),
      col.money('fuelCost', { sum: true }),
    ],
    chart: { kind: 'bar', x: 'asset', series: ['fuelL'] },
    async run({ from, to }) {
      const rows = await tx()
        .select({
          asset: assets.name,
          normLPerHour: assets.fuelNormLPerHour,
          motoHours: sumOf(assetUsageLogs.motoHours),
          volumeHa: sumOf(assetUsageLogs.volumeHa),
          fuelL: sumOf(assetUsageLogs.fuelL),
          fuelCost: sumOf(assetUsageLogs.fuelCost),
        })
        .from(assetUsageLogs)
        .innerJoin(assets, eq(assets.id, assetUsageLogs.assetId))
        .where(and(eq(assetUsageLogs.farmId, ctx().farmId), gte(assetUsageLogs.date, from), lte(assetUsageLogs.date, to)))
        .groupBy(assets.id, assets.name, assets.fuelNormLPerHour)
        .orderBy(asc(assets.name));
      return {
        rows: rows.map((r) => {
          const litersPerHour = r.motoHours > 0 ? r.fuelL / r.motoHours : null;
          const deviation =
            litersPerHour !== null && r.normLPerHour ? deviationPercent(litersPerHour, r.normLPerHour) : null;
          return {
            ...r,
            litersPerHour: nullableRound(litersPerHour, 2),
            deviationPercent: nullableRound(deviation, 1),
          };
        }),
      };
    },
  },
  {
    key: 'assets.maintenance',
    module: 'assets',
    filters: [filter.period('this_year'), filter.select('type', MAINTENANCE_TYPES, 'maintenanceType')],
    columns: [
      col.date('date'),
      col.text('asset'),
      col.enum('type', 'maintenanceType'),
      col.text('description'),
      col.num('downtimeHours', 2, { sum: true }),
      col.date('nextDueDate'),
      col.money('cost', { sum: true }),
    ],
    async run({ from, to, type }) {
      const rows = await tx()
        .select({
          date: maintenanceRecords.date,
          asset: assets.name,
          type: maintenanceRecords.type,
          description: maintenanceRecords.description,
          downtimeHours: maintenanceRecords.downtimeHours,
          nextDueDate: maintenanceRecords.nextDueDate,
          cost: maintenanceRecords.cost,
        })
        .from(maintenanceRecords)
        .innerJoin(assets, eq(assets.id, maintenanceRecords.assetId))
        .where(
          and(
            eq(maintenanceRecords.farmId, ctx().farmId),
            gte(maintenanceRecords.date, from),
            lte(maintenanceRecords.date, to),
            type ? eq(maintenanceRecords.type, type) : undefined,
          ),
        )
        .orderBy(desc(maintenanceRecords.date));
      return { rows };
    },
  },
  {
    key: 'assets.cost_per_hour',
    module: 'assets',
    money: true,
    filters: [filter.period('this_year')],
    columns: [
      col.text('asset'),
      col.num('hours', 2, { sum: true }),
      col.num('hectares', 2, { sum: true }),
      col.money('fuel', { sum: true }),
      col.money('labor', { sum: true }),
      col.money('repairs', { sum: true }),
      col.money('depreciation', { sum: true }),
      col.money('total', { sum: true }),
      col.money('costPerHour'),
      col.money('costPerHectare'),
    ],
    async run({ from, to }) {
      const list = await tx()
        .select({ id: assets.id, name: assets.name })
        .from(assets)
        .where(eq(assets.farmId, ctx().farmId))
        .orderBy(asc(assets.name));
      const rows: Row[] = [];
      for (const asset of list) {
        const costs = await assetCosts(asset.id, from, to);
        rows.push({
          ...costs,
          asset: asset.name,
          costPerHour: nullableRound(costs.costPerHour, 2),
          costPerHectare: nullableRound(costs.costPerHectare, 2),
        });
      }
      return { rows };
    },
  },
  {
    key: 'assets.depreciation',
    module: 'assets',
    money: true,
    filters: [filter.period('this_year')],
    columns: [col.month('month'), col.text('asset'), col.money('amount', { sum: true })],
    async run({ from, to }) {
      const rows = await tx()
        .select({ month: depreciationEntries.month, asset: assets.name, amount: depreciationEntries.amount })
        .from(depreciationEntries)
        .innerJoin(assets, eq(assets.id, depreciationEntries.assetId))
        .where(
          and(
            eq(depreciationEntries.farmId, ctx().farmId),
            gte(depreciationEntries.month, from.slice(0, 7)),
            lte(depreciationEntries.month, to.slice(0, 7)),
          ),
        )
        .orderBy(desc(depreciationEntries.month), asc(assets.name));
      return { rows };
    },
  },
];
