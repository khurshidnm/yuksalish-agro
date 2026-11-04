/**
 * The 8 import templates of spec 25.2. Each defines its columns, how a row is judged (new, already
 * there, or broken), and how it is written. Writing always goes through the owning module's
 * service, so cost centers, journal events and audit behave exactly as in manual entry.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  ASSET_STATUSES,
  ASSET_TYPES,
  COUNTERPARTY_TYPES,
  addDays,
  diffDays,
  expectedLambingDate,
  round,
  type CostTreatment,
  type Permission,
} from '@yap/shared';
import { kgPerUnit } from '@yap/shared/formulas/feed';
import { schema } from '../../db/client';
import { ctx, hasPermission, today, tx } from '../../core/context';
import { AppError } from '../../core/errors';
import { normalizePhone } from '../auth/auth.service';
import * as assets from '../assets/assets.service';
import * as plans from '../crops/plans.service';
import * as seasons from '../crops/seasons.service';
import { areaGeometry, measureBoundary } from '../farm/geometry';
import { createField } from '../farm/fields.service';
import * as budget from '../finance/budget.service';
import * as counterparties from '../finance/counterparties.service';
import * as transactions from '../finance/transactions.service';
import { createEmployee } from '../hr/employees.service';
import { createItem } from '../inventory/items.service';
import { createReceipt } from '../inventory/stock.service';
import * as warehouses from '../inventory/warehouses.service';
import { createAnimal } from '../livestock/animals.service';
import { createPregnancy } from '../livestock/breeding.service';
import { createHerd } from '../livestock/herds.service';
import type { ApplyResult, RawRow, RefsEnv, RowCheck, Template } from './check';
import { enumChoice, enumLabel, localized, tr, type Choice, type LanguageCode } from './i18n';
import { Lookup, cellText, matchKey, parseAgeMonths, parseBankDetails, parseCoordinates, parseDate } from './values';

const {
  accounts,
  animalIdentifiers,
  animals,
  assets: assetsTable,
  breeds,
  budgets,
  costCenters,
  counterparties: counterpartiesTable,
  cropPlans,
  crops,
  employees,
  fields,
  financeCategories,
  herds,
  items,
  species,
  stockBatches,
  transactions: transactionsTable,
  warehouses: warehousesTable,
} = schema;

const farm = () => ctx().farmId;

function choiceOf<T>(entries: { value: T; names: (string | null | undefined)[]; label: string }[]): Choice<T> {
  const lookup = new Lookup<T>();
  for (const entry of entries) lookup.add(entry.value, entry.names);
  return { lookup, labels: entries.map((e) => e.label) };
}

function columnValues(rows: RawRow[], key: string): string[] {
  return [...new Set(rows.map((r) => cellText(r.values[key])).filter(Boolean))];
}

// ─── Shared references ─────────────────────────────────────────────────────

type CategoryRef = typeof financeCategories.$inferSelect;

async function categoryChoice(lang: LanguageCode, kinds: string[]): Promise<Choice<CategoryRef>> {
  const rows = await tx()
    .select()
    .from(financeCategories)
    .where(
      and(
        eq(financeCategories.tenantId, ctx().tenantId),
        eq(financeCategories.active, true),
        inArray(financeCategories.kind, kinds),
      ),
    );
  return choiceOf(
    rows.map((row) => ({
      value: row,
      names: [row.name.uz, row.name.ru, row.name.en, row.key],
      label: localized(row.name, lang),
    })),
  );
}

interface CounterpartyRef {
  id: string;
  name: string;
}

async function counterpartyChoice(): Promise<Lookup<CounterpartyRef>> {
  const rows = await tx()
    .select({ id: counterpartiesTable.id, name: counterpartiesTable.name, tin: counterpartiesTable.tin })
    .from(counterpartiesTable)
    .where(and(eq(counterpartiesTable.farmId, farm()), eq(counterpartiesTable.active, true)));
  const lookup = new Lookup<CounterpartyRef>();
  for (const row of rows) lookup.add({ id: row.id, name: row.name }, [row.name, row.tin]);
  return lookup;
}

/** A name in a sheet may be the first time the system hears of this counterparty. */
async function ensureCounterparty(lookup: Lookup<CounterpartyRef>, name: string): Promise<string> {
  const existing = lookup.get(name);
  if (existing) return existing.id;
  const created = await counterparties.create({ name, type: 'supplier' });
  lookup.add({ id: created.id, name: created.name }, [created.name]);
  return created.id;
}

function readCounterparty(
  c: RowCheck,
  key: string,
  lookup: Lookup<CounterpartyRef>,
): { id?: string; newName?: string } | undefined {
  const name = c.text(key, { max: 200 });
  if (name === undefined) return undefined;
  const found = lookup.get(name);
  if (found) return { id: found.id };
  if (!hasPermission('finance.create')) return c.error(key, 'unknownCounterparty', { value: name });
  c.warn(key, 'newCounterparty');
  return { newName: name };
}

// ─── Dalalar ───────────────────────────────────────────────────────────────

type Field = typeof fields.$inferSelect;
type Season = Awaited<ReturnType<typeof seasons.list>>[number];

interface InferredSeason {
  name: string;
  kind: 'autumn' | 'summer';
  startDate: string;
  endDate: string;
}

interface FieldRefs {
  fields: Map<string, Field>;
  crops: Choice<{ id: string; label: string }>;
  seasons: Season[];
  plans: (typeof cropPlans.$inferSelect)[];
  createdSeasons: Map<string, string>;
}

interface FieldRow {
  number: string;
  existingFieldId?: string;
  areaHa?: number;
  boundary?: unknown;
  irrigationSource?: string;
  cropId?: string;
  variety?: string;
  sowingDate?: string;
  seedRate?: number;
  seasonId?: string;
  newSeason?: InferredSeason;
}

/** "№1", "Dala 1" and "1" are the same field. */
export function fieldNumberOf(text: string): string {
  return text
    .replace(/^\s*(dala|дала|поле|field)(?=[\s№#\d-])[\s-]*/iu, '')
    .replace(/^[№#]\s*/, '')
    .trim();
}

/** Autumn sowing runs from September, and its harvest falls in the next calendar year. */
function inferSeason(date: string, lang: LanguageCode): InferredSeason {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  if (month >= 9 || month <= 2) {
    const start = month >= 9 ? year : year - 1;
    return {
      name: tr(lang, 'defaults.autumnSeason', { years: `${start}/${String(start + 1).slice(2)}` }),
      kind: 'autumn',
      startDate: `${start}-09-01`,
      endDate: `${start + 1}-08-31`,
    };
  }
  return {
    name: tr(lang, 'defaults.summerSeason', { year }),
    kind: 'summer',
    startDate: `${year}-03-01`,
    endDate: `${year}-10-31`,
  };
}

function findSeason(refs: FieldRefs, date: string | undefined): Season | undefined {
  if (date) return refs.seasons.find((s) => s.startDate <= date && date <= s.endDate);
  return refs.seasons.find((s) => s.isCurrent);
}

const fieldsTemplate: Template<FieldRefs, FieldRow> = {
  key: 'fields',
  modules: ['farm', 'crops'],
  requires: [['farm.create'], ['crops.create']],
  link: '/farm/fields',
  columns: [
    { key: 'number', type: 'text', required: true, example: 'D-1', aliases: ['Dala', 'Dala raqami', 'Поле', 'Номер поля', 'Field', 'Field number'], width: 12 },
    { key: 'areaHa', type: 'number', example: 20, aliases: ['Maydon', 'Gektar', 'Площадь', 'Area'], width: 12 },
    { key: 'crop', type: 'text', list: 'crops', aliases: ['Ekin turi', 'Культура', 'Crop'], width: 16 },
    { key: 'variety', type: 'text', example: 'Krasnodarskaya-99', aliases: ['Navi', 'Сорт', 'Variety'], width: 20 },
    { key: 'sowingDate', type: 'date', example: '2026-10-25', aliases: ['Ekish', 'Дата посева', 'Sowing date'], width: 14 },
    { key: 'seedRate', type: 'number', example: 220, aliases: ['Urug\' me\'yori', 'Норма посева', 'Seed rate'], width: 14 },
    { key: 'irrigationSource', type: 'text', aliases: ['Sug\'orish', 'Источник орошения', 'Irrigation'], width: 18 },
    { key: 'coordinates', type: 'text', aliases: ['Koordinatalar', 'Координаты', 'Coordinates'], width: 30 },
  ],

  async refs({ lang }: RefsEnv) {
    const fieldRows = await tx().select().from(fields).where(eq(fields.farmId, farm()));
    const cropRows = await tx()
      .select()
      .from(crops)
      .where(and(eq(crops.tenantId, ctx().tenantId), eq(crops.active, true)));
    const planRows = await tx()
      .select()
      .from(cropPlans)
      .where(and(eq(cropPlans.farmId, farm()), ne(cropPlans.status, 'cancelled')));
    return {
      fields: new Map(fieldRows.map((row) => [matchKey(row.number), row])),
      crops: choiceOf(
        cropRows.map((row) => {
          const label = localized(row.name, lang);
          return { value: { id: row.id, label }, names: [row.name.uz, row.name.ru, row.name.en, row.key], label };
        }),
      ),
      seasons: await seasons.list(),
      plans: planRows,
      createdSeasons: new Map(),
    };
  },

  lists: (refs) => ({ crops: refs.crops.labels }),

  async check(c, refs) {
    const text = c.text('number', { max: 20 });
    if (text === undefined) return undefined;
    const number = fieldNumberOf(text);
    const key = matchKey(number);
    const existing = refs.fields.get(key);

    const crop = c.pick('crop', refs.crops);
    const sowingDate = c.date('sowingDate');

    let seasonId: string | undefined;
    let newSeason: InferredSeason | undefined;
    if (crop) {
      const season = findSeason(refs, sowingDate);
      if (season) seasonId = season.id;
      else newSeason = inferSeason(sowingDate ?? c.today, c.lang);
    }

    if (existing) {
      const samePlan = seasonId && refs.plans.some((p) => p.fieldId === existing.id && p.seasonId === seasonId && p.cropId === crop?.id);
      if (!crop || samePlan) return c.skip('fieldExists', { number });
    }
    if (!c.unique(`field:${key}`, 'number')) return undefined;

    const areaHa = c.number('areaHa', { above: 0, max: 100_000 });
    const variety = c.text('variety', { max: 120 });
    const seedRate = c.number('seedRate', { min: 0, max: 2000 });
    const irrigationSource = c.text('irrigationSource', { max: 120 });

    let boundary: unknown;
    let measured: number | undefined;
    const coordinates = c.text('coordinates');
    if (coordinates !== undefined && !existing) {
      const parsed = parseCoordinates(coordinates);
      if (parsed.kind === 'invalid') c.error('coordinates', 'invalidCoordinates');
      else if (parsed.kind === 'point') c.warn('coordinates', 'coordinatesPoint');
      else {
        const geometry = areaGeometry.safeParse(parsed.geometry);
        if (!geometry.success) c.error('coordinates', 'invalidCoordinates');
        else {
          try {
            measured = await measureBoundary(geometry.data);
            boundary = geometry.data;
          } catch (err) {
            if (!(err instanceof AppError)) throw err;
            c.error('coordinates', 'invalidOutline');
          }
        }
      }
    }

    if (!existing && measured === undefined && areaHa === undefined && c.blank('areaHa')) {
      c.error('areaHa', 'required');
    }
    if (measured !== undefined && areaHa !== undefined && Math.abs(measured - areaHa) / areaHa > 0.05) {
      c.warn('areaHa', 'areaDiffersFromOutline', { measured: round(measured, 2) });
    }

    if (existing) {
      if (existing.landUse !== 'arable') c.error('crop', 'fieldNotArable', { number });
      if (areaHa !== undefined && Math.abs(existing.areaHa - areaHa) / existing.areaHa > 0.01) {
        c.warn('areaHa', 'areaDiffersFromField', { existing: round(existing.areaHa, 2) });
      }
      const taken = refs.plans.some((p) => p.fieldId === existing.id && p.seasonId === seasonId);
      if (taken) c.error('crop', 'seasonTaken', { number });
    }

    if (newSeason) c.warn('crop', 'seasonWillBeCreated', { name: newSeason.name });

    return {
      number,
      existingFieldId: existing?.id,
      areaHa,
      boundary,
      irrigationSource,
      cropId: crop?.id,
      variety,
      sowingDate,
      seedRate,
      seasonId,
      newSeason,
    };
  },

  async apply(p, refs): Promise<ApplyResult> {
    const fieldId =
      p.existingFieldId ??
      (
        await createField({
          number: p.number,
          areaHa: p.areaHa,
          boundary: p.boundary as never,
          irrigationSource: p.irrigationSource,
        })
      ).id;

    if (!p.cropId) return { fieldsCreated: 1 };

    let seasonId = p.seasonId;
    if (!seasonId) {
      const wanted = p.newSeason!;
      seasonId = refs.createdSeasons.get(wanted.name);
      if (!seasonId) {
        seasonId = (await seasons.create(wanted)).id;
        refs.createdSeasons.set(wanted.name, seasonId);
      }
    }
    const sown = p.sowingDate !== undefined && p.sowingDate <= today();
    await plans.create({
      seasonId,
      fieldId,
      cropId: p.cropId,
      variety: p.variety,
      sowingDatePlan: p.sowingDate,
      sowingDateFact: sown ? p.sowingDate : undefined,
      seedRateKgHa: p.seedRate,
      status: sown ? 'sown' : 'planned',
    });
    return { plansCreated: 1 };
  },
};

// ─── Hayvonlar ─────────────────────────────────────────────────────────────

interface BreedRef {
  id: string;
  speciesId: string;
}

interface AnimalRefs {
  existingTags: Set<string>;
  identifiers: Map<string, string>;
  breeds: Choice<BreedRef>;
  sheepId: string | undefined;
  gestationBySpecies: Map<string, number>;
  counterparties: Lookup<CounterpartyRef>;
  herds: Lookup<string>;
  defaultHerdId: string | undefined;
  sex: Choice<'female' | 'male'>;
}

interface AnimalRow {
  tag: string;
  speciesId: string;
  breedId?: string;
  sex: 'female' | 'male';
  category: 'ewe' | 'ram' | 'lamb_male' | 'lamb_female';
  birthDate?: string;
  birthDateEstimated: boolean;
  origin: 'born' | 'purchased';
  purchaseDate?: string;
  purchasePrice?: number;
  sellerId?: string;
  newSeller?: string;
  herdId?: string;
  newHerd?: string;
  weightKg?: number;
  matingDate?: string;
}

const AGE_LAMB_MONTHS = 12;

/** "tug'ilgan sana yoki yoshi": one column, either a date or an age. */
function readBirth(c: RowCheck): { date?: string; estimated: boolean; ageMonths?: number } | undefined {
  const cell = c.cell('birth');
  if (cell === undefined) return { estimated: false };
  const date = parseDate(cell);
  if (date) {
    if (date > c.today) return c.error('birth', 'futureDate');
    return { date, estimated: false, ageMonths: diffDays(date, c.today) / 30.44 };
  }
  const months = parseAgeMonths(cell);
  if (months === null) return c.error('birth', 'invalidBirth');
  return { date: addDays(c.today, -Math.round(months * 30.44)), estimated: true, ageMonths: months };
}

function categoryOf(sex: 'female' | 'male', ageMonths: number | undefined): AnimalRow['category'] {
  const lamb = ageMonths !== undefined && ageMonths < AGE_LAMB_MONTHS;
  if (sex === 'female') return lamb ? 'lamb_female' : 'ewe';
  return lamb ? 'lamb_male' : 'ram';
}

const animalsTemplate: Template<AnimalRefs, AnimalRow> = {
  key: 'animals',
  modules: ['livestock'],
  // Registering animals is livestock.update. Shepherds hold livestock.create for their daily logs.
  requires: [['livestock.update']],
  link: '/livestock/animals',
  columns: [
    { key: 'tag', type: 'text', required: true, example: 'YA-0001', aliases: ['Birka', 'Бирка', 'Номер бирки', 'Tag', 'Ear tag'], width: 14 },
    { key: 'breed', type: 'text', list: 'breeds', aliases: ['Zot', 'Порода', 'Breed'], width: 14 },
    { key: 'sex', type: 'text', required: true, list: 'sex', aliases: ['Jins', 'Пол', 'Sex'], width: 12 },
    { key: 'birth', type: 'any', example: '2023-03-15', aliases: ["Tug'ilgan sana", 'Yoshi', 'Yosh', 'Дата рождения', 'Возраст', 'Birth date', 'Age'], width: 16 },
    { key: 'weightKg', type: 'number', example: 62.5, aliases: ['Vazn', 'Вес', 'Weight'], width: 10 },
    { key: 'pregnancyDate', type: 'date', example: '2026-10-05', aliases: ["Bo'g'ozlik", 'Дата случки', 'Mating date', 'Pregnancy date'], width: 16 },
    { key: 'purchaseDate', type: 'date', example: '2026-10-20', aliases: ['Sotib olingan sana', 'Дата покупки', 'Purchase date'], width: 16 },
    { key: 'purchasePrice', type: 'money', money: true, example: 4_200_000, aliases: ['Narxi', 'Цена', 'Price'], width: 14 },
    { key: 'seller', type: 'text', money: true, list: 'counterparties', aliases: ['Sotuvchi', 'Продавец', 'Seller'], width: 22 },
    { key: 'herd', type: 'text', list: 'herds', aliases: ['Poda', 'Стадо', 'Herd'], width: 20 },
  ],

  async refs({ lang, rows }) {
    const tenantId = ctx().tenantId;
    const tags = columnValues(rows, 'tag').map((t) => t.toUpperCase());
    const existing = tags.length
      ? await tx()
          .select({ tag: animals.tag })
          .from(animals)
          .where(and(eq(animals.tenantId, tenantId), inArray(sql`upper(${animals.tag})`, tags)))
      : [];
    const identifierRows = tags.length
      ? await tx()
          .select({ value: animalIdentifiers.value, tag: animals.tag })
          .from(animalIdentifiers)
          .innerJoin(animals, eq(animals.id, animalIdentifiers.animalId))
          .where(
            and(
              eq(animalIdentifiers.tenantId, tenantId),
              eq(animalIdentifiers.type, 'ear_tag'),
              inArray(sql`upper(${animalIdentifiers.value})`, tags),
            ),
          )
      : [];

    const speciesRows = await tx().select().from(species).where(eq(species.tenantId, tenantId));
    const breedRows = await tx()
      .select()
      .from(breeds)
      .where(and(eq(breeds.tenantId, tenantId), eq(breeds.active, true)));
    const herdRows = await tx()
      .select({ id: herds.id, name: herds.name })
      .from(herds)
      .where(and(eq(herds.farmId, farm()), eq(herds.status, 'active')));

    const herdLookup = new Lookup<string>();
    for (const herd of herdRows) herdLookup.add(herd.id, [herd.name]);

    return {
      existingTags: new Set(existing.map((row) => row.tag.toUpperCase())),
      identifiers: new Map(identifierRows.map((row) => [row.value.toUpperCase(), row.tag])),
      breeds: choiceOf(
        breedRows.map((row) => ({
          value: { id: row.id, speciesId: row.speciesId },
          names: [row.name.uz, row.name.ru, row.name.en, row.key],
          label: localized(row.name, lang),
        })),
      ),
      sheepId: speciesRows.find((s) => s.key === 'sheep')?.id,
      gestationBySpecies: new Map(speciesRows.map((s) => [s.id, s.gestationDays])),
      counterparties: await counterpartyChoice(),
      herds: herdLookup,
      defaultHerdId: herdRows.length === 1 ? herdRows[0].id : undefined,
      sex: enumChoice(lang, 'sex', ['female', 'male'] as const, {
        female: ["urg'ochi", 'sovliq', 'ayol', 'ж', 'жен', 'женский', 'самка', 'f'],
        male: ['erkak', "qo'chqor", 'м', 'муж', 'мужской', 'самец', 'm'],
      }),
    };
  },

  lists: (refs) => ({
    breeds: refs.breeds.labels,
    sex: refs.sex.labels,
    herds: refs.herds.labels,
    counterparties: refs.counterparties.labels,
  }),

  check(c, refs) {
    const tag = c.text('tag', { max: 40 });
    if (tag === undefined) return undefined;
    const key = tag.toUpperCase();
    if (refs.existingTags.has(key)) return c.skip('animalExists', { tag });
    const owner = refs.identifiers.get(key);
    if (owner) return c.error('tag', 'tagOnOtherAnimal', { tag: owner });
    if (!c.unique(`animal:${key}`, 'tag')) return undefined;

    const breed = c.pick('breed', refs.breeds);
    const speciesId = breed?.speciesId ?? refs.sheepId;
    const sex = c.pick('sex', refs.sex);
    const birth = readBirth(c);
    const weightKg = c.number('weightKg', { above: 0, max: 2000 });
    const purchaseDate = c.date('purchaseDate', { notFuture: true });
    const purchasePrice = c.money('purchasePrice');
    const seller = readCounterparty(c, 'seller', refs.counterparties);
    const matingDate = c.date('pregnancyDate', { notFuture: true });

    if (purchasePrice !== undefined && !purchaseDate && c.blank('purchaseDate')) {
      c.error('purchaseDate', 'priceNeedsDate');
    }

    let origin: AnimalRow['origin'] | undefined;
    if (purchaseDate) origin = 'purchased';
    else if (birth?.date && !birth.estimated) origin = 'born';
    else if (c.blank('purchaseDate') && birth) c.error('birth', 'originUnknown');

    if (matingDate) {
      if (sex === 'male') c.error('pregnancyDate', 'maleCannotBePregnant');
      if (birth?.date && matingDate < birth.date) c.error('pregnancyDate', 'matingBeforeBirth');
      const gestation = speciesId ? refs.gestationBySpecies.get(speciesId) : undefined;
      if (expectedLambingDate(matingDate, gestation) < c.today) c.warn('pregnancyDate', 'lambingDatePassed');
    }

    let herdId: string | undefined;
    let newHerd: string | undefined;
    const herdName = c.text('herd', { max: 120 });
    if (herdName !== undefined) {
      herdId = refs.herds.get(herdName);
      if (!herdId) {
        newHerd = herdName;
        c.warn('herd', 'herdWillBeCreated');
      }
    } else if (refs.defaultHerdId) {
      herdId = refs.defaultHerdId;
    } else {
      c.warn('herd', 'noHerd');
    }

    if (!speciesId || !sex || !origin) return undefined;
    return {
      tag,
      speciesId,
      breedId: breed?.id,
      sex,
      category: categoryOf(sex, birth?.ageMonths),
      birthDate: birth?.date,
      birthDateEstimated: birth?.estimated ?? false,
      origin,
      purchaseDate,
      purchasePrice,
      sellerId: seller?.id,
      newSeller: seller?.newName,
      herdId,
      newHerd,
      weightKg,
      matingDate,
    };
  },

  async apply(p, refs) {
    const sellerId = p.newSeller ? await ensureCounterparty(refs.counterparties, p.newSeller) : p.sellerId;
    let herdId = p.herdId;
    if (p.newHerd) {
      herdId = refs.herds.get(p.newHerd);
      if (!herdId) {
        herdId = (await createHerd({ name: p.newHerd })).id;
        refs.herds.add(herdId, [p.newHerd]);
      }
    }
    const animal = await createAnimal({
      tag: p.tag,
      speciesId: p.speciesId,
      breedId: p.breedId,
      sex: p.sex,
      category: p.category,
      birthDate: p.birthDate,
      birthDateEstimated: p.birthDateEstimated,
      origin: p.origin,
      purchaseDate: p.purchaseDate,
      purchasePrice: p.purchasePrice,
      sellerId,
      herdId,
      currentWeightKg: p.weightKg,
    });
    if (!p.matingDate) return undefined;
    await createPregnancy({
      eweId: animal.id,
      matingDate: p.matingDate,
      source: p.origin === 'purchased' ? 'purchase' : 'mating',
    });
    return { pregnancies: 1 };
  },
};

// ─── Ozuqa qoldig'i ────────────────────────────────────────────────────────

type ItemRow = typeof items.$inferSelect;

interface FeedRefs {
  items: Lookup<ItemRow>;
  warehouseId: string | undefined;
  /** Opening batches, by item and date. */
  opening: Map<string, { qty: number; unitCost: number }>;
  unit: Choice<'kg' | 't' | 'bale'>;
  lang: LanguageCode;
}

interface FeedRow {
  itemId?: string;
  newItem?: { name: string; unit: string };
  qty: number;
  unitCost: number;
  date: string;
}

const openingKey = (itemId: string, date: string) => `${itemId}|${date}`;

/** Sheet units per one stored unit: 1 t into a kg item gives 1000. */
function unitFactor(sheetUnit: string, storedUnit: string, weightPerUnit: number | null | undefined): number | null {
  if (sheetUnit === storedUnit) return 1;
  const from = kgPerUnit(sheetUnit, sheetUnit === 'bale' ? weightPerUnit : null);
  const to = kgPerUnit(storedUnit, storedUnit === 'bale' ? weightPerUnit : null);
  return from && to ? from / to : null;
}

const feedTemplate: Template<FeedRefs, FeedRow> = {
  key: 'feed',
  modules: ['inventory'],
  // The price is what values all later consumption, so quantity alone would quietly cost feed at zero.
  requires: [['inventory.create'], ['finance.view']],
  link: '/inventory/stock',
  columns: [
    { key: 'item', type: 'text', required: true, list: 'items', aliases: ['Ozuqa', 'Корм', 'Feed'], width: 22 },
    { key: 'qty', type: 'number', required: true, example: 120, aliases: ['Miqdor', 'Количество', 'Quantity'], width: 12 },
    { key: 'unit', type: 'text', required: true, list: 'units', aliases: ["O'lchov", 'Единица', 'Unit'], width: 12 },
    { key: 'date', type: 'date', required: true, example: '2026-10-15', aliases: ['Kirim', 'Дата', 'Date'], width: 14 },
    { key: 'price', type: 'money', required: true, money: true, example: 1_800_000, aliases: ['Narx', 'Цена', 'Price'], width: 14 },
  ],

  async refs({ lang }) {
    const itemRows = await tx()
      .select()
      .from(items)
      .where(and(eq(items.farmId, farm()), eq(items.active, true)));
    const lookup = new Lookup<ItemRow>();
    for (const row of itemRows) lookup.add(row, [row.name]);

    const [warehouse] = await tx()
      .select({ id: warehousesTable.id })
      .from(warehousesTable)
      .where(and(eq(warehousesTable.farmId, farm()), eq(warehousesTable.type, 'feed'), eq(warehousesTable.active, true)))
      .limit(1);

    const batches = await tx()
      .select()
      .from(stockBatches)
      .where(and(eq(stockBatches.farmId, farm()), eq(stockBatches.source, 'opening')));

    return {
      items: lookup,
      warehouseId: warehouse?.id,
      opening: new Map(batches.map((b) => [openingKey(b.itemId, b.receivedDate), { qty: b.qtyReceived, unitCost: b.unitCost }])),
      unit: enumChoice(lang, 'unit', ['kg', 't', 'bale'] as const, {
        t: ['tonna', 'тонна', 'тн', 'т'],
        kg: ['kilogramm', 'кг', 'килограмм'],
        bale: ["bog'", 'тюк', 'bog'],
      }),
      lang,
    };
  },

  lists: (refs) => ({ items: refs.items.labels, units: refs.unit.labels }),

  check(c, refs) {
    const name = c.text('item', { max: 200 });
    const qty = c.number('qty', { above: 0 });
    const unit = c.pick('unit', refs.unit);
    const date = c.date('date', { notFuture: true });
    const price = c.money('price');
    if (name === undefined || qty === undefined || !unit || date === undefined || price === undefined) return undefined;

    const item = refs.items.get(name);
    // Rations are in kg, so a new feed is kept in kg even when the sheet counts tons.
    const storedUnit = item?.unit ?? (unit === 't' ? 'kg' : unit);
    const factor = unitFactor(unit, storedUnit, item?.kgPerUnit);
    if (factor === null) {
      return c.error('unit', 'unitMismatch', { unit: enumLabel(c.lang, 'unit', storedUnit) });
    }
    const stockQty = round(qty * factor, 3);
    const unitCost = round(price / factor, 4);

    if (item) {
      const existing = refs.opening.get(openingKey(item.id, date));
      if (existing) {
        if (Math.abs(existing.qty - stockQty) < 0.001 && Math.abs(existing.unitCost - unitCost) < 0.01) {
          return c.skip('stockExists', { name });
        }
        return c.error('qty', 'stockDiffers', { name, date });
      }
    }
    if (!c.unique(`feed:${item?.id ?? matchKey(name)}|${date}`, 'item')) return undefined;

    if (!item) {
      c.warn('item', 'newItem');
      if (storedUnit === 'bale') c.warn('unit', 'baleWeightNeeded');
    }
    if (!refs.warehouseId) c.warn(undefined, 'warehouseWillBeCreated');
    return { itemId: item?.id, newItem: item ? undefined : { name, unit: storedUnit }, qty: stockQty, unitCost, date };
  },

  async apply(p, refs) {
    if (!refs.warehouseId) {
      const created = await warehouses.create({ name: tr(refs.lang, 'defaults.feedWarehouse'), type: 'feed' });
      refs.warehouseId = created.id;
    }
    let itemId = p.itemId;
    if (!itemId) {
      const known = refs.items.get(p.newItem!.name);
      if (known) itemId = known.id;
      else {
        const created = await createItem({
          name: p.newItem!.name,
          category: 'feed',
          unit: p.newItem!.unit as 'kg',
          defaultWarehouseId: refs.warehouseId,
        });
        refs.items.add(created as ItemRow, [created.name]);
        itemId = created.id;
      }
    }
    await createReceipt({
      warehouseId: refs.warehouseId,
      date: p.date,
      source: 'opening',
      lines: [{ itemId, qty: p.qty, unitCost: p.unitCost }],
    });
    return undefined;
  },
};

// ─── Xodimlar ──────────────────────────────────────────────────────────────

interface EmployeeRefs {
  phones: Set<string>;
  people: Set<string>;
  payType: Choice<'monthly' | 'daily' | 'piece' | 'seasonal'>;
}

interface EmployeeRow {
  fullName: string;
  position: string;
  payType: 'monthly' | 'daily' | 'piece' | 'seasonal';
  baseRate: number;
  hireDate: string;
  phone?: string;
  contractEndDate?: string;
}

const personKey = (name: string, hireDate: string) => `${matchKey(name)}|${hireDate}`;

function readPhone(c: RowCheck, key: string): string | undefined {
  const text = c.text(key, { max: 30 });
  if (text === undefined) return undefined;
  const digits = text.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return c.error(key, 'invalidPhone');
  return normalizePhone(text);
}

const employeesTemplate: Template<EmployeeRefs, EmployeeRow> = {
  key: 'employees',
  modules: ['hr'],
  // Pay rates are money and personal data at once, as in the employee card.
  requires: [['hr.create'], ['pii.view' as Permission], ['finance.view', 'payroll.view']],
  link: '/hr/employees',
  columns: [
    { key: 'fullName', type: 'text', required: true, pii: true, aliases: ['Ism', 'F.I.Sh', 'ФИО', 'Имя', 'Name', 'Full name'], width: 28 },
    { key: 'position', type: 'text', required: true, aliases: ['Lavozim', 'Должность', 'Position'], width: 18 },
    { key: 'payType', type: 'text', required: true, list: 'payTypes', aliases: ['Ish haqi turi', 'Вид оплаты', 'Pay type'], width: 14 },
    { key: 'rate', type: 'money', required: true, money: true, pii: true, example: 4_500_000, aliases: ['Ish haqi', 'Miqdori', 'Оклад', 'Ставка', 'Rate', 'Salary'], width: 14 },
    { key: 'hireDate', type: 'date', required: true, example: '2026-09-01', aliases: ['Ishga qabul', 'Дата приёма', 'Hire date'], width: 14 },
    { key: 'phone', type: 'text', pii: true, example: '+998901234567', aliases: ['Telefon', 'Телефон', 'Phone'], width: 16 },
    { key: 'contractEndDate', type: 'date', aliases: ['Shartnoma tugashi', 'Конец договора', 'Contract end'], width: 14 },
  ],

  async refs({ lang }) {
    const rows = await tx()
      .select({ fullName: employees.fullName, hireDate: employees.hireDate, phone: employees.phone })
      .from(employees)
      .where(eq(employees.farmId, farm()));
    return {
      phones: new Set(rows.flatMap((r) => (r.phone ? [normalizePhone(r.phone)] : []))),
      people: new Set(rows.map((r) => personKey(r.fullName, r.hireDate))),
      payType: enumChoice(lang, 'payType', ['monthly', 'daily', 'piece', 'seasonal'] as const, {
        monthly: ['oklad', 'оклад', 'месячная', 'помесячно'],
        daily: ['подневная', 'посуточно'],
        piece: ['сдельная'],
        seasonal: ['сезонная'],
      }),
    };
  },

  lists: (refs) => ({ payTypes: refs.payType.labels }),

  check(c, refs) {
    const fullName = c.text('fullName', { max: 160 });
    const hireDate = c.date('hireDate');
    const phone = readPhone(c, 'phone');
    if (fullName === undefined) return undefined;
    if (fullName.length < 2) return c.error('fullName', 'tooShort');
    if (phone && refs.phones.has(phone)) return c.skip('employeeExists', { name: fullName });
    if (hireDate && refs.people.has(personKey(fullName, hireDate))) return c.skip('employeeExists', { name: fullName });
    if (hireDate && !c.unique(phone ? `phone:${phone}` : `person:${personKey(fullName, hireDate)}`, phone ? 'phone' : 'fullName')) {
      return undefined;
    }

    const position = c.text('position', { max: 120 });
    const payType = c.pick('payType', refs.payType);
    const baseRate = c.money('rate');
    const contractEndDate = c.date('contractEndDate');
    if (payType === 'seasonal' && !contractEndDate && c.blank('contractEndDate')) {
      c.error('contractEndDate', 'seasonalNeedsEnd');
    }
    if (position === undefined || !payType || baseRate === undefined || !hireDate) return undefined;
    return { fullName, position, payType, baseRate, hireDate, phone, contractEndDate };
  },

  async apply(p) {
    await createEmployee(p);
    return undefined;
  },
};

// ─── Texnika ───────────────────────────────────────────────────────────────

interface AssetRefs {
  inventoryNumbers: Set<string>;
  names: Set<string>;
  type: Choice<(typeof ASSET_TYPES)[number]>;
  status: Choice<(typeof ASSET_STATUSES)[number]>;
}

interface AssetRow {
  name: string;
  type: (typeof ASSET_TYPES)[number];
  inventoryNo?: string;
  purchaseDate?: string;
  purchasePrice?: number;
  status?: (typeof ASSET_STATUSES)[number];
}

const assetsTemplate: Template<AssetRefs, AssetRow> = {
  key: 'machinery',
  modules: ['assets'],
  requires: [['assets.create']],
  link: '/assets',
  columns: [
    { key: 'name', type: 'text', required: true, example: 'MTZ-82', aliases: ['Nomi', 'Название', 'Name'], width: 24 },
    { key: 'type', type: 'text', required: true, list: 'assetTypes', aliases: ['Turi', 'Тип', 'Type'], width: 14 },
    { key: 'inventoryNo', type: 'text', example: 'INV-001', aliases: ['Inventar', 'Инвентарный номер', 'Inventory number'], width: 16 },
    { key: 'purchaseDate', type: 'date', example: '2024-03-15', aliases: ['Xarid sanasi', 'Дата покупки', 'Purchase date'], width: 14 },
    { key: 'purchasePrice', type: 'money', money: true, example: 350_000_000, aliases: ['Xarid narxi', 'Narxi', 'Цена', 'Price'], width: 16 },
    { key: 'status', type: 'text', list: 'assetStatuses', aliases: ['Holati', 'Состояние', 'Status'], width: 16 },
  ],

  async refs({ lang }) {
    const rows = await tx()
      .select({ name: assetsTable.name, inventoryNo: assetsTable.inventoryNo })
      .from(assetsTable)
      .where(eq(assetsTable.farmId, farm()));
    return {
      inventoryNumbers: new Set(rows.flatMap((r) => (r.inventoryNo ? [matchKey(r.inventoryNo)] : []))),
      names: new Set(rows.map((r) => matchKey(r.name))),
      type: enumChoice(lang, 'assetType', ASSET_TYPES),
      status: enumChoice(lang, 'assetStatus', ASSET_STATUSES, {
        working: ['ishlaydi', 'soz', 'исправен', 'работает'],
        repair: ['nosoz', 'неисправен'],
      }),
    };
  },

  lists: (refs) => ({ assetTypes: refs.type.labels, assetStatuses: refs.status.labels }),

  check(c, refs) {
    const name = c.text('name', { max: 200 });
    const inventoryNo = c.text('inventoryNo', { max: 60 });
    if (name === undefined) return undefined;
    if (inventoryNo ? refs.inventoryNumbers.has(matchKey(inventoryNo)) : refs.names.has(matchKey(name))) {
      return c.skip('assetExists', { name });
    }
    const key = inventoryNo ? `inv:${matchKey(inventoryNo)}` : `name:${matchKey(name)}`;
    if (!c.unique(`asset:${key}`, inventoryNo ? 'inventoryNo' : 'name')) return undefined;

    const type = c.pick('type', refs.type);
    const purchaseDate = c.date('purchaseDate', { notFuture: true });
    const purchasePrice = c.money('purchasePrice');
    const status = c.pick('status', refs.status);
    if (!type) return undefined;
    return { name, type, inventoryNo, purchaseDate, purchasePrice, status };
  },

  async apply(p) {
    await assets.create(p);
    return undefined;
  },
};

// ─── Kontragentlar ─────────────────────────────────────────────────────────

interface CounterpartyRefs {
  tins: Set<string>;
  names: Set<string>;
  type: Choice<(typeof COUNTERPARTY_TYPES)[number]>;
}

interface CounterpartyRow {
  name: string;
  tin?: string;
  type: (typeof COUNTERPARTY_TYPES)[number];
  phone?: string;
  bankDetails?: { bankName?: string; account?: string; mfo?: string };
}

const counterpartiesTemplate: Template<CounterpartyRefs, CounterpartyRow> = {
  key: 'counterparties',
  modules: ['finance'],
  requires: [['finance.create'], ['finance.view']],
  link: '/finance/counterparties',
  columns: [
    { key: 'name', type: 'text', required: true, aliases: ['Nomi', 'Название', 'Name'], width: 28 },
    { key: 'tin', type: 'text', example: '305123456', aliases: ['STIR', 'ИНН', 'TIN'], width: 14 },
    { key: 'type', type: 'text', required: true, list: 'counterpartyTypes', aliases: ['Toifa', 'Тип', 'Type', 'Category'], width: 18 },
    { key: 'phone', type: 'text', example: '+998712345678', aliases: ['Telefon', 'Телефон', 'Phone'], width: 16 },
    { key: 'bank', type: 'text', aliases: ['Bank', 'Банк', 'Bank details'], width: 36 },
  ],

  async refs({ lang }) {
    const rows = await tx()
      .select({ name: counterpartiesTable.name, tin: counterpartiesTable.tin })
      .from(counterpartiesTable)
      .where(and(eq(counterpartiesTable.farmId, farm()), eq(counterpartiesTable.active, true)));
    return {
      tins: new Set(rows.flatMap((r) => (r.tin ? [r.tin.replace(/\D/g, '')] : []))),
      names: new Set(rows.map((r) => matchKey(r.name))),
      type: enumChoice(lang, 'counterpartyType', COUNTERPARTY_TYPES, {
        supplier: ['sotuvchi', 'поставщик', 'yetkazuvchi'],
        buyer: ['покупатель', 'mijoz', 'клиент'],
        service: ['xizmat', 'услуги'],
        government: ['davlat', 'госорган'],
      }),
    };
  },

  lists: (refs) => ({ counterpartyTypes: refs.type.labels }),

  check(c, refs) {
    const name = c.text('name', { max: 200 });
    const tinText = c.text('tin', { max: 30 });
    const tin = tinText?.replace(/\D/g, '');
    if (name === undefined) return undefined;
    if (tin ? refs.tins.has(tin) : refs.names.has(matchKey(name))) return c.skip('counterpartyExists', { name });
    if (!c.unique(tin ? `tin:${tin}` : `cp:${matchKey(name)}`, tin ? 'tin' : 'name')) return undefined;
    if (tin && tin.length !== 9 && tin.length !== 14) c.warn('tin', 'tinLength');

    const type = c.pick('type', refs.type);
    const phone = readPhone(c, 'phone');
    const bankText = c.text('bank', { max: 300 });
    if (!type) return undefined;
    return { name, tin, type, phone, bankDetails: bankText ? (parseBankDetails(bankText) ?? undefined) : undefined };
  },

  async apply(p) {
    await counterparties.create(p);
    return undefined;
  },
};

// ─── Boshlang'ich xarajatlar ───────────────────────────────────────────────

const STOCK_CATEGORIES = new Set(['feed', 'seed', 'fertilizer', 'crop_protection', 'fuel', 'spare_parts', 'veterinary']);

interface CostCenterRef {
  id: string;
  type: string;
}

type PaymentMethod = 'cash' | 'bank' | 'card' | 'debt';

interface ExpenseRefs {
  categories: Choice<CategoryRef>;
  costCenters: Choice<CostCenterRef>;
  payment: Choice<PaymentMethod>;
  accountByType: Map<string, string>;
  counterparties: Lookup<CounterpartyRef>;
  /** Natural keys of expenses already in the journal. */
  existing: Set<string>;
}

interface ExpenseRow {
  date: string;
  categoryId: string;
  amount: number;
  paymentMethod: PaymentMethod;
  accountId?: string;
  costCenterId: string;
  costTreatment: CostTreatment;
  counterpartyId?: string;
  newCounterparty?: string;
  description?: string;
}

const expenseKey = (date: string, categoryId: string, amount: number, costCenterId: string, note: string | null | undefined) =>
  `${date}|${categoryId}|${round(amount, 2)}|${costCenterId}|${matchKey(note ?? '')}`;

/** Rule 3: how this spending reaches cost centers, without a column a person would have to learn. */
function treatmentOf(category: CategoryRef, costCenter: CostCenterRef): CostTreatment {
  if (category.key === 'animal_purchase') return 'animal';
  if (category.group === 'investment') return 'capex';
  if (STOCK_CATEGORIES.has(category.key) && costCenter.type === 'general') return 'inventory';
  return 'expense';
}

const expensesTemplate: Template<ExpenseRefs, ExpenseRow> = {
  key: 'expenses',
  modules: ['finance'],
  requires: [['finance.create'], ['finance.view']],
  link: '/finance/transactions',
  columns: [
    { key: 'date', type: 'date', required: true, example: '2026-10-05', aliases: ['Sana', 'Дата', 'Date'], width: 14 },
    { key: 'category', type: 'text', required: true, list: 'categories', aliases: ['Modda', 'Статья', 'Category'], width: 26 },
    { key: 'amount', type: 'money', required: true, money: true, example: 1_500_000, aliases: ['Summa', 'Сумма', 'Amount'], width: 16 },
    { key: 'paymentMethod', type: 'text', required: true, list: 'paymentMethods', aliases: ["To'lov usuli", 'Способ оплаты', 'Payment method'], width: 16 },
    { key: 'costCenter', type: 'text', required: true, list: 'costCenters', aliases: ['Xarajat markazi', 'Центр затрат', 'Cost center'], width: 22 },
    { key: 'note', type: 'text', aliases: ['Izoh', 'Комментарий', 'Note'], width: 30 },
    { key: 'counterparty', type: 'text', list: 'counterparties', aliases: ['Kontragent', 'Контрагент', 'Counterparty'], width: 24 },
  ],

  async refs({ lang, rows }) {
    const centerRows = await tx()
      .select({ id: costCenters.id, type: costCenters.type, name: costCenters.name, refId: costCenters.refId })
      .from(costCenters)
      .where(and(eq(costCenters.farmId, farm()), eq(costCenters.active, true)));
    const fieldRows = await tx()
      .select({ number: fields.number, name: fields.name, costCenterId: fields.costCenterId })
      .from(fields)
      .where(eq(fields.farmId, farm()));
    const fieldNames = new Map(fieldRows.map((f) => [f.costCenterId, f]));

    const generalAliases = ['Umumiy', 'Umumiy ferma', 'Ferma', 'Общие', 'Общехозяйственные', 'General'];
    const centers = choiceOf(
      centerRows.map((row) => {
        const field = fieldNames.get(row.id);
        const label = row.type === 'general' ? enumLabel(lang, 'costCenterType', 'general') : row.name;
        const names =
          row.type === 'general'
            ? [label, ...generalAliases, enumLabel('uz', 'costCenterType', 'general'), enumLabel('ru', 'costCenterType', 'general')]
            : [label, row.name, ...(field ? [field.number, `Dala ${field.number}`, `Поле ${field.number}`, field.name] : [])];
        return { value: { id: row.id, type: row.type }, names, label };
      }),
    );

    const accountRows = await tx()
      .select({ id: accounts.id, type: accounts.type })
      .from(accounts)
      .where(and(eq(accounts.farmId, farm()), eq(accounts.active, true), eq(accounts.currency, ctx().currency)));
    const accountByType = new Map<string, string>();
    for (const row of accountRows) if (!accountByType.has(row.type)) accountByType.set(row.type, row.id);

    const dates = columnValues(rows, 'date')
      .map((d) => parseDate(d))
      .filter((d): d is string => !!d);
    const existingRows = dates.length
      ? await tx()
          .select({
            date: transactionsTable.date,
            categoryId: transactionsTable.categoryId,
            amount: transactionsTable.amount,
            costCenterId: transactionsTable.costCenterId,
            description: transactionsTable.description,
          })
          .from(transactionsTable)
          .where(
            and(
              eq(transactionsTable.farmId, farm()),
              eq(transactionsTable.type, 'expense'),
              ne(transactionsTable.status, 'rejected'),
              inArray(transactionsTable.date, [...new Set(dates)]),
            ),
          )
      : [];

    return {
      categories: await categoryChoice(lang, ['expense']),
      costCenters: centers,
      payment: enumChoice(lang, 'paymentMethod', ['cash', 'bank', 'card', 'debt'] as const, {
        cash: ['naqd pul', 'наличные', 'нал'],
        bank: ["o'tkazma", "bank o'tkazmasi", 'перечисление', 'безнал', 'hisob raqam'],
        card: ['plastik', 'карта', 'plastik karta'],
        debt: ['qarz', 'в долг', 'в кредит', 'nasiya'],
      }),
      accountByType,
      counterparties: await counterpartyChoice(),
      existing: new Set(
        existingRows.map((r) => expenseKey(r.date, r.categoryId ?? '', r.amount, r.costCenterId ?? '', r.description)),
      ),
    };
  },

  lists: (refs) => ({
    categories: refs.categories.labels,
    paymentMethods: refs.payment.labels,
    costCenters: refs.costCenters.labels,
    counterparties: refs.counterparties.labels,
  }),

  check(c, refs) {
    const date = c.date('date', { notFuture: true });
    const category = c.pick('category', refs.categories);
    const amount = c.money('amount', { above: 0 });
    const costCenter = c.pick('costCenter', refs.costCenters);
    const paymentMethod = c.pick('paymentMethod', refs.payment);
    const description = c.text('note', { max: 500 });
    if (!date || !category || amount === undefined || !costCenter) return undefined;

    const key = expenseKey(date, category.id, amount, costCenter.id, description);
    if (refs.existing.has(key)) return c.skip('expenseExists');
    // Two identical lines cannot be told from a double entry, so a person must make them differ.
    if (!c.unique(`expense:${key}`, 'amount')) return undefined;
    if (!paymentMethod) return undefined;

    const counterparty = readCounterparty(c, 'counterparty', refs.counterparties);
    let accountId: string | undefined;
    if (paymentMethod === 'debt') {
      if (!counterparty) c.error('counterparty', 'debtNeedsCounterparty');
    } else {
      accountId = refs.accountByType.get(paymentMethod);
      if (!accountId) c.error('paymentMethod', 'noAccount', { method: enumLabel(c.lang, 'paymentMethod', paymentMethod) });
    }

    const costTreatment = treatmentOf(category, costCenter);
    if (costTreatment === 'inventory') c.warn('costCenter', 'treatedAsStock');

    return {
      date,
      categoryId: category.id,
      amount,
      paymentMethod,
      accountId,
      costCenterId: costCenter.id,
      costTreatment,
      counterpartyId: counterparty?.id,
      newCounterparty: counterparty?.newName,
      description,
    };
  },

  async apply(p, refs) {
    const counterpartyId = p.newCounterparty ? await ensureCounterparty(refs.counterparties, p.newCounterparty) : p.counterpartyId;
    const row = await transactions.create({
      date: p.date,
      type: 'expense',
      amount: p.amount,
      categoryId: p.categoryId,
      paymentMethod: p.paymentMethod,
      accountId: p.accountId,
      counterpartyId,
      costCenterId: p.costCenterId,
      costTreatment: p.costTreatment,
      description: p.description,
    });
    return row.status === 'pending' ? { pendingApproval: 1 } : undefined;
  },
};

// ─── Byudjet ───────────────────────────────────────────────────────────────

interface BudgetRefs {
  categories: Choice<CategoryRef>;
  existing: Map<string, number>;
}

interface BudgetRow {
  month: string;
  categoryId: string;
  amount: number;
}

const budgetKey = (month: string, categoryId: string) => `${month}|${categoryId}`;

const budgetTemplate: Template<BudgetRefs, BudgetRow> = {
  key: 'budget',
  modules: ['finance'],
  requires: [['finance.create'], ['finance.view']],
  link: '/finance/budget',
  columns: [
    { key: 'month', type: 'month', required: true, example: '2026-11', aliases: ['Oy', 'Месяц', 'Month'], width: 14 },
    { key: 'category', type: 'text', required: true, list: 'categories', aliases: ['Modda', 'Статья', 'Category'], width: 28 },
    { key: 'amount', type: 'money', required: true, money: true, example: 12_000_000, aliases: ['Reja', 'Summa', 'План', 'Сумма', 'Plan', 'Amount'], width: 16 },
  ],

  async refs({ lang }) {
    const rows = await tx()
      .select({ month: budgets.month, categoryId: budgets.categoryId, amount: budgets.amount })
      .from(budgets)
      .where(and(eq(budgets.farmId, farm()), sql`${budgets.costCenterId} is null`));
    return {
      categories: await categoryChoice(lang, ['expense', 'income']),
      existing: new Map(rows.map((r) => [budgetKey(r.month, r.categoryId), r.amount])),
    };
  },

  lists: (refs) => ({ categories: refs.categories.labels }),

  check(c, refs) {
    const month = c.month('month');
    const category = c.pick('category', refs.categories);
    const amount = c.money('amount');
    if (!month || !category || amount === undefined) return undefined;

    const key = budgetKey(month, category.id);
    const existing = refs.existing.get(key);
    if (existing !== undefined && Math.abs(existing - amount) < 0.01) return c.skip('budgetExists');
    if (existing === undefined && amount === 0) return c.skip('budgetZero');
    if (!c.unique(`budget:${key}`, 'category')) return undefined;
    if (existing !== undefined) c.willUpdate('budgetUpdate', { old: existing });
    return { month, categoryId: category.id, amount };
  },

  async applyAll(parsed) {
    const CHUNK = 2000;
    for (let i = 0; i < parsed.length; i += CHUNK) {
      await budget.saveEntries({ entries: parsed.slice(i, i + CHUNK) });
    }
    return undefined;
  },
};

export const TEMPLATES: Template[] = [
  fieldsTemplate,
  animalsTemplate,
  feedTemplate,
  employeesTemplate,
  assetsTemplate,
  counterpartiesTemplate,
  expensesTemplate,
  budgetTemplate,
];

export const TEMPLATE_KEYS = TEMPLATES.map((t) => t.key) as [string, ...string[]];

export function templateOf(key: string): Template {
  const template = TEMPLATES.find((t) => t.key === key);
  if (!template) throw new Error(`Unknown template ${key}`);
  return template;
}
