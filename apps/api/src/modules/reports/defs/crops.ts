import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { OPERATION_TYPES, round, yieldPerHectare } from '@yap/shared';
import { schema } from '../../../db/client';
import { canSeeMoney, ctx, tx } from '../../../core/context';
import { sumOf } from '../../../core/query';
import { cropKpis } from '../../crops/summary';
import { planFact } from '../../crops/plan-fact.service';
import { fieldCosts } from '../../finance/summary';
import { enumLabel } from '../i18n';
import type { ReportDefinition, Row } from '../types';
import { PII, col, filter } from './_helpers';

const { assets, cropPlans, crops, employees, fieldOperations, fields, harvests, seasons, soilAnalyses } = schema;

export const cropReports: ReportDefinition[] = [
  {
    key: 'crops.field_costs',
    module: 'crops',
    money: true,
    filters: [filter.season],
    columns: [
      col.text('field'),
      col.name('crop'),
      col.num('areaHa', 2, { sum: true }),
      col.money('seed', { sum: true }),
      col.money('fertilizer', { sum: true }),
      col.money('water', { sum: true }),
      col.money('machinery', { sum: true }),
      col.money('labor', { sum: true }),
      col.money('overheadShare', { sum: true }),
      col.money('actual', { sum: true }),
      col.money('planned', { sum: true }),
      col.money('deviation', { sum: true }),
    ],
    compare: { filter: 'seasonId', by: ['field', 'crop'], values: ['actual'] },
    async run({ seasonId }) {
      const rows = await fieldCosts(seasonId);
      return {
        rows: rows.map((r) => ({
          field: r.number,
          crop: r.crop,
          areaHa: r.areaHa,
          ...r.breakdown,
          actual: r.actual,
          planned: r.planned,
          deviation: r.deviation,
        })),
      };
    },
  },
  {
    key: 'crops.yield',
    module: 'crops',
    filters: [filter.season],
    columns: [
      col.text('field'),
      col.name('crop'),
      col.enum('status', 'cropPlanStatus'),
      col.num('areaHa', 2, { sum: true }),
      col.num('expectedYieldTHa', 3),
      col.num('expectedHarvestT', 3, { sum: true }),
      col.num('harvestedT', 3, { sum: true }),
      col.num('actualYieldTHa', 3),
      col.pct('yieldDeviationPercent'),
    ],
    chart: { kind: 'bar', x: 'field', series: ['expectedHarvestT', 'harvestedT'] },
    async run({ seasonId }) {
      const { rows } = await planFact(seasonId);
      return {
        rows: rows.map((r) => ({
          ...r,
          field: r.fieldNumber,
          crop: r.cropName,
          yieldDeviationPercent: r.yieldDeviationPercent === null ? null : round(r.yieldDeviationPercent, 1),
        })),
      };
    },
  },
  {
    key: 'crops.operations',
    module: 'crops',
    filters: [filter.period('this_month'), filter.field, filter.select('type', OPERATION_TYPES, 'operationType')],
    columns: [
      col.date('date'),
      col.enum('type', 'operationType'),
      col.text('field'),
      col.name('crop'),
      col.num('areaDoneHa', 2, { sum: true }),
      col.num('waterM3', 2, { sum: true }),
      col.num('fuelL', 2, { sum: true }),
      col.text('asset'),
      col.text('employee', { sensitive: PII }),
      col.text('status'),
    ],
    async run({ from, to, fieldId, type, lang }) {
      const rows = await tx()
        .select({
          date: fieldOperations.date,
          type: fieldOperations.type,
          field: fields.number,
          crop: crops.name,
          areaDoneHa: fieldOperations.areaDoneHa,
          waterM3: fieldOperations.waterM3,
          fuelL: fieldOperations.fuelL,
          asset: assets.name,
          employee: employees.fullName,
          status: fieldOperations.status,
        })
        .from(fieldOperations)
        .innerJoin(fields, eq(fields.id, fieldOperations.fieldId))
        .leftJoin(cropPlans, eq(cropPlans.id, fieldOperations.cropPlanId))
        .leftJoin(crops, eq(crops.id, cropPlans.cropId))
        .leftJoin(assets, eq(assets.id, fieldOperations.assetId))
        .leftJoin(employees, eq(employees.id, fieldOperations.employeeId))
        .where(
          and(
            eq(fieldOperations.farmId, ctx().farmId),
            gte(fieldOperations.date, from),
            lte(fieldOperations.date, to),
            fieldId ? eq(fieldOperations.fieldId, fieldId) : undefined,
            type ? eq(fieldOperations.type, type) : undefined,
          ),
        )
        .orderBy(desc(fieldOperations.date));
      return { rows: rows.map((r) => ({ ...r, status: enumLabel(lang, 'reports:operationStatus', r.status) })) };
    },
  },
  {
    key: 'crops.rotation',
    module: 'crops',
    filters: [filter.field],
    columns: [
      col.text('field'),
      col.text('season'),
      col.name('crop'),
      col.text('variety'),
      col.num('areaHa', 2),
      col.num('harvestedT', 3),
      col.num('actualYieldTHa', 3),
    ],
    async run({ fieldId }) {
      const farm = ctx().farmId;
      const plans = await tx()
        .select({
          id: cropPlans.id,
          field: fields.number,
          season: seasons.name,
          crop: crops.name,
          variety: cropPlans.variety,
          areaHa: cropPlans.areaHa,
        })
        .from(cropPlans)
        .innerJoin(fields, eq(fields.id, cropPlans.fieldId))
        .innerJoin(seasons, eq(seasons.id, cropPlans.seasonId))
        .innerJoin(crops, eq(crops.id, cropPlans.cropId))
        .where(
          and(
            eq(cropPlans.farmId, farm),
            sql`${cropPlans.status} <> 'cancelled'`,
            fieldId ? eq(cropPlans.fieldId, fieldId) : undefined,
          ),
        )
        .orderBy(asc(fields.number), desc(seasons.startDate));
      const ids = plans.map((p) => p.id);
      const harvested = ids.length
        ? await tx()
            .select({ planId: harvests.cropPlanId, tons: sumOf(harvests.grossT) })
            .from(harvests)
            .where(inArray(harvests.cropPlanId, ids))
            .groupBy(harvests.cropPlanId)
        : [];
      const tons = new Map(harvested.map((h) => [h.planId, h.tons]));
      return {
        rows: plans.map((p) => {
          const harvestedT = tons.get(p.id) ?? 0;
          const value = harvestedT > 0 ? yieldPerHectare(harvestedT, p.areaHa) : null;
          return { ...p, harvestedT, actualYieldTHa: value === null ? null : round(value, 3) };
        }),
      };
    },
  },
  {
    key: 'crops.water_use',
    module: 'crops',
    filters: [filter.season],
    columns: [
      col.text('field'),
      col.name('crop'),
      col.num('areaHa', 2, { sum: true }),
      col.num('waterM3', 2, { sum: true }),
      col.num('waterM3PerHa', 1),
      col.num('harvestedT', 3, { sum: true }),
      col.num('waterM3PerTon', 1),
    ],
    async run({ seasonId }) {
      const { rows } = await planFact(seasonId);
      return {
        rows: rows.map((r) => ({
          ...r,
          field: r.fieldNumber,
          crop: r.cropName,
          waterM3PerHa: r.areaHa > 0 ? round(r.waterM3 / r.areaHa, 1) : null,
        })),
      };
    },
  },
  {
    key: 'crops.harvests',
    module: 'crops',
    filters: [filter.period('this_year'), filter.field],
    columns: [
      col.date('date'),
      col.text('field'),
      col.name('crop'),
      col.num('grossT', 3, { sum: true }),
      col.num('moisturePct', 2),
      col.text('quality'),
      col.text('asset'),
    ],
    async run({ from, to, fieldId }) {
      const rows = await tx()
        .select({
          date: harvests.date,
          field: fields.number,
          crop: crops.name,
          grossT: harvests.grossT,
          moisturePct: harvests.moisturePct,
          quality: harvests.quality,
          asset: assets.name,
        })
        .from(harvests)
        .innerJoin(fields, eq(fields.id, harvests.fieldId))
        .leftJoin(cropPlans, eq(cropPlans.id, harvests.cropPlanId))
        .leftJoin(crops, eq(crops.id, cropPlans.cropId))
        .leftJoin(assets, eq(assets.id, harvests.assetId))
        .where(
          and(
            eq(harvests.farmId, ctx().farmId),
            gte(harvests.date, from),
            lte(harvests.date, to),
            fieldId ? eq(harvests.fieldId, fieldId) : undefined,
          ),
        )
        .orderBy(desc(harvests.date));
      return { rows };
    },
  },
  {
    key: 'crops.soil',
    module: 'crops',
    filters: [filter.field],
    columns: [
      col.date('date'),
      col.text('field'),
      col.num('n', 3),
      col.num('p', 3),
      col.num('k', 3),
      col.num('ph', 2),
      col.num('humus', 3),
      col.num('salinity', 3),
      col.text('lab'),
    ],
    async run({ fieldId }) {
      const rows = await tx()
        .select({
          date: soilAnalyses.date,
          field: fields.number,
          n: soilAnalyses.n,
          p: soilAnalyses.p,
          k: soilAnalyses.k,
          ph: soilAnalyses.ph,
          humus: soilAnalyses.humus,
          salinity: soilAnalyses.salinity,
          lab: soilAnalyses.lab,
        })
        .from(soilAnalyses)
        .innerJoin(fields, eq(fields.id, soilAnalyses.fieldId))
        .where(and(eq(soilAnalyses.farmId, ctx().farmId), fieldId ? eq(soilAnalyses.fieldId, fieldId) : undefined))
        .orderBy(desc(soilAnalyses.date), asc(fields.number));
      return { rows };
    },
  },
  {
    key: 'crops.kpi',
    module: 'crops',
    filters: [filter.season],
    columns: [col.enum('indicator', 'reports:kpi'), col.num('value', 2), col.enum('unit', 'reports:kpiUnit')],
    async run({ seasonId }) {
      const kpi = await cropKpis(seasonId);
      const rows: Row[] = [
        { indicator: 'yield', value: kpi.yieldTHa === null ? null : round(kpi.yieldTHa, 2), unit: 'tons_per_ha' },
        { indicator: 'on_time', value: kpi.onTimePercent === null ? null : round(kpi.onTimePercent, 1), unit: 'percent' },
        { indicator: 'water_per_ton', value: kpi.waterM3PerTon === null ? null : round(kpi.waterM3PerTon, 1), unit: 'm3_per_ton' },
      ];
      if (canSeeMoney()) {
        const costs = await fieldCosts(seasonId);
        const harvested = costs.reduce((sum, c) => sum + c.harvestT, 0);
        const spent = costs.filter((c) => c.harvestT > 0).reduce((sum, c) => sum + c.actual, 0);
        rows.push({ indicator: 'cost_per_ton', value: harvested > 0 ? round(spent / harvested, 2) : null, unit: 'money' });
      }
      return { rows };
    },
  },
];
