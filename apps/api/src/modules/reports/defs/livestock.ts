import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  ANIMAL_CATEGORIES,
  ANIMAL_EXIT_TYPES,
  ANIMAL_ON_FARM_STATUSES,
  ANIMAL_STATUSES,
  HEALTH_RECORD_TYPES,
  diffDays,
  monthRange,
  mortalityPercent,
  round,
} from '@yap/shared';
import { schema } from '../../../db/client';
import { canSeeMoney, ctx, today, tx } from '../../../core/context';
import { monthsBetween } from '../../finance/budget.service';
import { herdCost } from '../../finance/summary';
import { lambingCalendar, ramRating, reproductionKpis } from '../../livestock/breeding.summary';
import { vaccinationDue } from '../../livestock/health.service';
import { growthKpis, herdMovement, herdSummary, mortality } from '../../livestock/summary';
import { enumLabel } from '../i18n';
import type { ReportDefinition, ReportNote, Row } from '../types';
import { PII, col, filter } from './_helpers';

const {
  animalExits,
  animals,
  breeds,
  counterparties,
  dailyLogs,
  employees,
  healthRecords,
  herds,
  items,
  lambingRecords,
} = schema;

const movementColumns = () => [
  col.int('opening'),
  col.int('born', { sum: true }),
  col.int('purchased', { sum: true }),
  col.int('sold', { sum: true }),
  col.int('slaughtered', { sum: true }),
  col.int('dead', { sum: true }),
  col.int('lost', { sum: true }),
  col.int('closing'),
];

/** A month of the range, clipped so the first and last rows respect the chosen dates. */
function clippedMonths(from: string, to: string) {
  return monthsBetween(from.slice(0, 7), to.slice(0, 7)).map((month) => {
    const range = monthRange(month);
    return { month, from: range.from < from ? from : range.from, to: range.to > to ? to : range.to };
  });
}

export const livestockReports: ReportDefinition[] = [
  {
    key: 'livestock.herd_movement',
    module: 'livestock',
    filters: [filter.period('this_year')],
    columns: [col.month('month'), ...movementColumns()],
    chart: { kind: 'bar', x: 'month', series: ['born', 'purchased', 'sold', 'dead'] },
    async run({ from, to }) {
      const rows: Row[] = [];
      for (const part of clippedMonths(from, to)) rows.push({ month: part.month, ...(await herdMovement(part.from, part.to)) });
      // Whole-period figures from the same function, so the total row is exact, not a sum of openings.
      return { rows, totals: await herdMovement(from, to) };
    },
  },
  {
    key: 'livestock.herd_structure',
    module: 'livestock',
    filters: [],
    columns: [col.enum('group', 'reports:structureGroup'), col.text('value'), col.int('head', { sum: true })],
    async run({ lang }) {
      const summary = await herdSummary();
      const rows = [
        ...Object.entries(summary.byCategory).map(([key, head]) => ({
          group: 'category',
          value: enumLabel(lang, 'animalCategory', key),
          head,
        })),
        ...Object.entries(summary.byStatus).map(([key, head]) => ({
          group: 'status',
          value: enumLabel(lang, 'animalStatus', key),
          head,
        })),
      ];
      // Each animal appears once per grouping, so the total is the head count, not the row sum.
      return { rows, totals: { head: summary.total } };
    },
  },
  {
    key: 'livestock.animal_register',
    module: 'livestock',
    filters: [
      filter.herd,
      filter.select('category', ANIMAL_CATEGORIES, 'animalCategory'),
      filter.select('status', ANIMAL_STATUSES, 'animalStatus'),
    ],
    columns: [
      col.text('tag'),
      col.name('breed'),
      col.enum('sex', 'sex'),
      col.enum('category', 'animalCategory'),
      col.enum('status', 'animalStatus'),
      col.text('herd'),
      col.date('birthDate'),
      col.int('ageMonths'),
      col.num('currentWeightKg', 2),
      col.enum('origin', 'animalOrigin'),
      col.date('purchaseDate'),
      col.money('purchasePrice', { sum: true }),
      col.text('seller', { sensitive: ['money'] }),
    ],
    async run({ herdId, category, status }) {
      const rows = await tx()
        .select({
          tag: animals.tag,
          breed: breeds.name,
          sex: animals.sex,
          category: animals.category,
          status: animals.status,
          herd: herds.name,
          birthDate: animals.birthDate,
          currentWeightKg: animals.currentWeightKg,
          origin: animals.origin,
          purchaseDate: animals.purchaseDate,
          purchasePrice: animals.purchasePrice,
          seller: counterparties.name,
        })
        .from(animals)
        .leftJoin(breeds, eq(breeds.id, animals.breedId))
        .leftJoin(herds, eq(herds.id, animals.herdId))
        .leftJoin(counterparties, eq(counterparties.id, animals.sellerId))
        .where(
          and(
            eq(animals.farmId, ctx().farmId),
            herdId ? eq(animals.herdId, herdId) : undefined,
            category ? eq(animals.category, category) : undefined,
            status ? eq(animals.status, status) : inArray(animals.status, [...ANIMAL_ON_FARM_STATUSES]),
          ),
        )
        .orderBy(asc(animals.tag));
      const now = today();
      return {
        rows: rows.map((r) => ({
          ...r,
          ageMonths: r.birthDate ? Math.floor(diffDays(r.birthDate, now) / 30.44) : null,
        })),
      };
    },
  },
  {
    key: 'livestock.lambing',
    module: 'livestock',
    filters: [filter.period('this_year')],
    columns: [
      col.date('date'),
      col.text('ewe'),
      col.int('lambsBorn', { sum: true }),
      col.int('lambsAlive', { sum: true }),
      col.text('complications'),
    ],
    async run({ from, to }) {
      const rows = await tx()
        .select({
          date: lambingRecords.date,
          ewe: animals.tag,
          lambsBorn: lambingRecords.lambsBorn,
          lambsAlive: lambingRecords.lambsAlive,
          complications: lambingRecords.complications,
        })
        .from(lambingRecords)
        .innerJoin(animals, eq(animals.id, lambingRecords.eweId))
        .where(and(eq(lambingRecords.farmId, ctx().farmId), gte(lambingRecords.date, from), lte(lambingRecords.date, to)))
        .orderBy(desc(lambingRecords.date));
      const kpi = await reproductionKpis(from, to);
      return {
        rows,
        notes:
          kpi.lambingPercent === null
            ? []
            : [{ key: 'lambing_percent', params: { percent: kpi.lambingPercent, ewes: kpi.ewesWithOutcome } }],
      };
    },
  },
  {
    key: 'livestock.lambing_calendar',
    module: 'livestock',
    filters: [filter.days(180, 365)],
    columns: [col.date('date'), col.int('expected', { sum: true })],
    chart: { kind: 'bar', x: 'date', series: ['expected'] },
    run: async ({ days }) => ({ rows: await lambingCalendar(days) }),
  },
  {
    key: 'livestock.mortality',
    module: 'livestock',
    filters: [filter.period('this_year')],
    columns: [
      col.date('date'),
      col.text('tag'),
      col.enum('category', 'animalCategory'),
      col.text('herd'),
      col.enum('type', 'animalExitType'),
      col.text('reason'),
      col.text('vetConclusion'),
      col.money('lossAmount', { sum: true }),
    ],
    async run({ from, to }) {
      const rows = await tx()
        .select({
          date: animalExits.date,
          tag: animals.tag,
          category: animals.category,
          herd: herds.name,
          type: animalExits.type,
          reason: animalExits.reason,
          vetConclusion: animalExits.vetConclusion,
          lossAmount: animalExits.lossAmount,
        })
        .from(animalExits)
        .innerJoin(animals, eq(animals.id, animalExits.animalId))
        .leftJoin(herds, eq(herds.id, animals.herdId))
        .where(
          and(
            eq(animalExits.farmId, ctx().farmId),
            inArray(animalExits.type, ['death', 'loss']),
            gte(animalExits.date, from),
            lte(animalExits.date, to),
          ),
        )
        .orderBy(desc(animalExits.date));
      const movement = await herdMovement(from, to);
      const percent = mortalityPercent(movement.dead, movement.averageHead);
      const notes: ReportNote[] =
        percent === null ? [] : [{ key: 'mortality_percent', params: { percent: round(percent, 2), dead: movement.dead } }];
      return { rows, notes };
    },
  },
  {
    key: 'livestock.exits',
    module: 'livestock',
    filters: [filter.period('this_year'), filter.select('type', ANIMAL_EXIT_TYPES, 'animalExitType')],
    columns: [
      col.date('date'),
      col.enum('type', 'animalExitType'),
      col.text('tag'),
      col.enum('category', 'animalCategory'),
      col.num('liveWeightKg', 2, { sum: true }),
      col.num('carcassWeightKg', 2, { sum: true }),
      col.money('amount', { sum: true }),
      col.text('counterparty', { sensitive: ['money'] }),
      col.text('reason'),
    ],
    async run({ from, to, type }) {
      const rows = await tx()
        .select({
          date: animalExits.date,
          type: animalExits.type,
          tag: animals.tag,
          category: animals.category,
          liveWeightKg: animalExits.liveWeightKg,
          carcassWeightKg: animalExits.carcassWeightKg,
          amount: animalExits.amount,
          counterparty: counterparties.name,
          reason: animalExits.reason,
        })
        .from(animalExits)
        .innerJoin(animals, eq(animals.id, animalExits.animalId))
        .leftJoin(counterparties, eq(counterparties.id, animalExits.counterpartyId))
        .where(
          and(
            eq(animalExits.farmId, ctx().farmId),
            gte(animalExits.date, from),
            lte(animalExits.date, to),
            type ? eq(animalExits.type, type) : undefined,
          ),
        )
        .orderBy(desc(animalExits.date));
      return { rows };
    },
  },
  {
    key: 'livestock.weight_gain',
    module: 'livestock',
    filters: [filter.period('last_30_days')],
    columns: [
      col.text('herd'),
      col.int('animals', { sum: true }),
      col.num('gainKg', 2, { sum: true }),
      col.int('adgG'),
      col.num('dryMatterKg', 2, { sum: true }),
      col.num('feedConversion', 2),
    ],
    async run({ from, to }) {
      const list = await tx()
        .select({ id: herds.id, name: herds.name })
        .from(herds)
        .where(and(eq(herds.farmId, ctx().farmId), eq(herds.status, 'active')))
        .orderBy(asc(herds.name));
      const rows: Row[] = [];
      for (const herd of list) rows.push({ herd: herd.name, ...(await growthKpis(from, to, herd.id)) });
      const farm = await growthKpis(from, to);
      return { rows, totals: farm };
    },
  },
  {
    key: 'livestock.vaccination',
    module: 'livestock',
    filters: [filter.period('this_year'), filter.herd],
    columns: [
      col.date('date'),
      col.text('drug'),
      col.text('herd'),
      col.text('tag'),
      col.int('headCount', { sum: true }),
      col.num('qtyUsed', 3, { sum: true }),
      col.text('vet', { sensitive: PII }),
      col.date('nextDueDate'),
      col.money('totalCost', { sum: true }),
    ],
    run: ({ from, to, herdId }) => healthRows(['vaccination'], from, to, herdId),
  },
  {
    key: 'livestock.vaccination_due',
    module: 'livestock',
    filters: [filter.days(30, 365), filter.herd],
    columns: [
      col.text('plan'),
      col.text('herd'),
      col.date('dueDate'),
      col.enum('state', 'reports:dueState'),
      col.int('daysOverdue'),
      col.int('head', { sum: true }),
    ],
    async run({ days, herdId }) {
      const { rows } = await vaccinationDue({ herdId, horizonDays: days });
      return { rows: rows.map((r) => ({ ...r, plan: r.planName, herd: r.herdName })) };
    },
  },
  {
    key: 'livestock.treatments',
    module: 'livestock',
    filters: [
      filter.period('this_year'),
      filter.herd,
      filter.select('type', HEALTH_RECORD_TYPES, 'healthRecordType'),
    ],
    columns: [
      col.date('date'),
      col.enum('type', 'healthRecordType'),
      col.text('tag'),
      col.text('herd'),
      col.text('diagnosis'),
      col.text('drug'),
      col.num('qtyUsed', 3),
      col.text('result'),
      col.date('withdrawalUntil'),
      col.text('vet', { sensitive: PII }),
      col.money('totalCost', { sum: true }),
    ],
    run: ({ from, to, herdId, type }) =>
      healthRows(type ? [type] : ['treatment', 'prophylaxis', 'deworming', 'examination', 'quarantine'], from, to, herdId),
  },
  {
    key: 'livestock.ram_rating',
    module: 'livestock',
    filters: [],
    columns: [
      col.int('rank'),
      col.text('tag'),
      col.enum('status', 'animalStatus'),
      col.int('progeny'),
      col.int('weighed'),
      col.num('avgWeight100Kg', 1),
      col.int('avgGainGrams'),
      col.num('index', 1),
      col.bool('lowConfidence'),
    ],
    async run() {
      const { rams } = await ramRating();
      return { rows: rams };
    },
  },
  {
    key: 'livestock.daily_logs',
    module: 'livestock',
    filters: [filter.period('last_30_days'), filter.herd],
    columns: [
      col.date('date'),
      col.text('herd'),
      col.int('headCount'),
      col.num('waterL', 2, { sum: true }),
      col.enum('condition', 'herdCondition'),
      col.text('notes'),
    ],
    async run({ from, to, herdId }) {
      const rows = await tx()
        .select({
          date: dailyLogs.date,
          herd: herds.name,
          headCount: dailyLogs.headCount,
          waterL: dailyLogs.waterL,
          condition: dailyLogs.condition,
          notes: dailyLogs.notes,
        })
        .from(dailyLogs)
        .innerJoin(herds, eq(herds.id, dailyLogs.herdId))
        .where(
          and(
            eq(dailyLogs.farmId, ctx().farmId),
            gte(dailyLogs.date, from),
            lte(dailyLogs.date, to),
            herdId ? eq(dailyLogs.herdId, herdId) : undefined,
          ),
        )
        .orderBy(desc(dailyLogs.date), asc(herds.name));
      return { rows };
    },
  },
  {
    key: 'livestock.kpi',
    module: 'livestock',
    filters: [filter.period('this_year')],
    columns: [col.enum('indicator', 'reports:kpi'), col.num('value', 2), col.enum('unit', 'reports:kpiUnit')],
    async run({ from, to }) {
      const repro = await reproductionKpis(from, to);
      const growth = await growthKpis(from, to);
      const dead = await mortality(30);
      const summary = await herdSummary();
      const rows: Row[] = [
        { indicator: 'head_total', value: summary.total, unit: 'head' },
        { indicator: 'lambing_percent', value: repro.lambingPercent, unit: 'percent' },
        { indicator: 'survival_percent', value: repro.survivalPercent, unit: 'percent' },
        { indicator: 'adg', value: growth.adgG, unit: 'grams' },
        { indicator: 'feed_conversion', value: growth.feedConversion === null ? null : round(growth.feedConversion, 2), unit: 'ratio' },
        { indicator: 'mortality_30d', value: dead.percent === null ? null : round(dead.percent, 2), unit: 'percent' },
      ];
      // This figure is money, so the row is withheld, not just the column.
      if (canSeeMoney()) {
        rows.push({ indicator: 'cost_per_kg', value: (await herdCost()).costPerKg, unit: 'money' });
      }
      return { rows };
    },
  },
];

async function healthRows(types: string[], from: string, to: string, herdId?: string) {
  const rows = await tx()
    .select({
      date: healthRecords.date,
      type: healthRecords.type,
      drug: items.name,
      herd: herds.name,
      tag: animals.tag,
      diagnosis: healthRecords.diagnosis,
      headCount: healthRecords.headCount,
      qtyUsed: healthRecords.qtyUsed,
      result: healthRecords.result,
      vet: employees.fullName,
      nextDueDate: healthRecords.nextDueDate,
      withdrawalUntil: healthRecords.withdrawalUntil,
      totalCost: healthRecords.totalCost,
    })
    .from(healthRecords)
    .leftJoin(items, eq(items.id, healthRecords.itemId))
    .leftJoin(animals, eq(animals.id, healthRecords.animalId))
    .leftJoin(herds, sql`${herds.id} = coalesce(${healthRecords.herdId}, ${animals.herdId})`)
    .leftJoin(employees, eq(employees.id, healthRecords.vetEmployeeId))
    .where(
      and(
        eq(healthRecords.farmId, ctx().farmId),
        inArray(healthRecords.type, types),
        gte(healthRecords.date, from),
        lte(healthRecords.date, to),
        herdId ? sql`coalesce(${healthRecords.herdId}, ${animals.herdId}) = ${herdId}` : undefined,
      ),
    )
    .orderBy(desc(healthRecords.date));
  return { rows };
}
