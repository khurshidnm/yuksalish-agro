/**
 * Readiness of a farm record (docs/assistant.md, "Farm records"). The model names what it read; code
 * finds each fact in the person's own words and in the books, or asks one question. Nothing here
 * writes: it runs as the AI role, which can only read.
 */
import { ANIMAL_ON_FARM_STATUSES, diffDays, round } from '@yap/shared';
import { ageInMonths, maxLiveWeightKg } from '@yap/shared/formulas/livestock';
import {
  careWords,
  dateEvidence,
  deathWords,
  placedQuantities,
  quantitiesOfTag,
  quoteFromWords,
  statedTags,
  type PlacedQuantity,
  type StatedTag,
} from '@yap/shared/formulas/record-words';
import { convertQty, unitOf, type UnitWord } from '@yap/shared/formulas/units';
import { and, eq, or, sql } from 'drizzle-orm';
import { schema } from '../../../db/client';
import { ctx, today, tx } from '../../../core/context';
import { costCenterCandidates, itemCandidates, resolve, singledOut, warehouseCandidates, type Candidate, type TargetType } from './resolve';
import { MAX_RECORD_AGE_DAYS, OLD_RECORD_DAYS, type FarmRecordKind } from './routing';
import type { FarmAnimal, FarmFields, FarmInput, FarmStockLine, FarmValidated, UsedQuantity } from './farm-types';
import type { DraftEnv, Question, Warning } from './types';

const { animals, animalExits, animalIdentifiers, dailyLogs, healthRecords, herds, items: stockItems, rationLines, species, weightRecords } = schema;

const MAX_OPTIONS = 8;
const WEIGHT_UNITS: UnitWord[] = ['g', 'kg', 'sentner', 't'];
const DOSE_UNITS: UnitWord[] = ['ml', 'l', 'g', 'kg', 'dose', 'vial', 'pcs'];
/** What one animal is given at a time. A weight in kilograms beside it is not a dose. */
const GIVEN_UNITS: UnitWord[] = ['ml', 'l', 'g'];
const FEED_UNITS: UnitWord[] = ['g', 'kg', 'sentner', 't', 'bale', 'l', 'pcs'];

class FarmDraft {
  readonly questions: Question[] = [];
  readonly warnings: Warning[] = [];
  readonly used: UsedQuantity[] = [];

  constructor(
    readonly input: FarmInput,
    readonly env: DraftEnv,
    /** Quantities other cards of this conversation already rest on. */
    readonly taken: UsedQuantity[],
  ) {}

  get texts(): string[] {
    return this.env.userTexts;
  }

  ask(field: string, code: string, hint: string, options: Question['options'] = []): null {
    if (!this.questions.some((q) => q.field === field)) this.questions.push({ field, code, hint, options: options.slice(0, MAX_OPTIONS) });
    return null;
  }

  warn(code: string, params: Record<string, unknown> = {}) {
    if (!this.warnings.some((w) => w.code === code)) this.warnings.push({ code, params });
  }
}

const emptyFields = (date: string): FarmFields => ({
  date,
  animal: null,
  herd: null,
  weightKg: null,
  cause: null,
  healthType: null,
  drug: null,
  dose: null,
  doseUnit: null,
  headCount: null,
  stockOut: [],
});

const isRealDate = (date: string) => {
  const parsed = new Date(`${date}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
};

/** The day the words pin down, or the day it was said. The model's date only has to agree, as for money. */
function checkDate(d: FarmDraft): string {
  const now = d.env.saidOn ?? today();
  const firstSaid = d.env.saidDays?.[0] ?? now;
  const given = d.input.date;
  const unclear = (hint = 'Ask which day this was.', days: string[] = []) => {
    d.ask('date', 'DATE_UNCLEAR', hint, days.map((day) => ({ id: day, label: day })));
    return now;
  };
  if (given !== undefined && !isRealDate(given)) return unclear();

  const days = d.env.saidDays ?? [];
  const newestFirst = [...d.texts].reverse();
  const evidence = newestFirst
    .map((text, i) => dateEvidence(text, days[d.texts.length - 1 - i] ?? now))
    .find((e) => e.dates.length > 0 || e.vague || e.future);
  const stated = evidence?.dates ?? [];
  if (evidence?.future && stated.length === 0) {
    d.ask('date', 'DATE_IN_FUTURE', 'This has not happened yet. Only what was done can be recorded. Ask on which day it was done.');
    return now;
  }
  let date: string;
  if (given !== undefined) {
    const agrees = !evidence?.vague && (stated.length > 0 ? stated.includes(given) : given === now || given === firstSaid);
    if (!agrees) return unclear('The date does not match their words. Ask which day this was.', stated);
    date = stated.length > 0 ? given : firstSaid;
  } else if (evidence?.vague) {
    return unclear('They did not say which day. Ask for the exact day.');
  } else if (stated.length > 1) {
    return unclear('They named several days. Ask which day this one was.', stated);
  } else {
    date = stated[0] ?? firstSaid;
  }
  if (date > now) {
    d.ask('date', 'DATE_IN_FUTURE', 'The date is in the future. Ask which day this was.');
    return now;
  }
  const age = diffDays(date, now);
  if (age > MAX_RECORD_AGE_DAYS) return unclear('This date is very old. Ask them to check it.');
  if (age > OLD_RECORD_DAYS) d.warn('OLD_DATE', { date });
  return date;
}

// ─── The animal ─────────────────────────────────────────────────────────────

const plainDigits = (text: string) => text.replace(/\D/g, '').replace(/^0+/, '');

/** Where in the person's words the tag stands: the message, and its place in it. */
interface SaidTag {
  at: number;
  tag: StatedTag;
}

/** The tag the model named, as the person said it. Newest message first, so a correction wins. */
function saidTag(d: FarmDraft, named: string): SaidTag | 'count' | null {
  const digits = plainDigits(named);
  if (digits === '') return null;
  let countOnly = false;
  for (let at = d.texts.length - 1; at >= 0; at--) {
    const matches = statedTags(d.texts[at]).filter((tag) => plainDigits(tag.digits) === digits);
    const sure = matches.filter((tag) => tag.marked || !tag.countLike);
    if (sure.length > 0) return { at, tag: sure[sure.length - 1] };
    countOnly ||= matches.length > 0;
  }
  return countOnly ? 'count' : null;
}

const animalColumns = {
  id: animals.id,
  tag: animals.tag,
  sex: animals.sex,
  category: animals.category,
  birthDate: animals.birthDate,
  status: animals.status,
  species: species.key,
  herdId: herds.id,
  herdName: herds.name,
};

const toAnimal = (row: AnimalRow, date: string): FarmAnimal => ({
  id: row.id,
  tag: row.tag,
  sex: row.sex ?? null,
  species: row.species ?? null,
  category: row.category ?? null,
  birthDate: row.birthDate ?? null,
  ageMonths: ageInMonths(row.birthDate, date),
  herd: row.herdId && row.herdName ? { id: row.herdId, name: row.herdName } : null,
});

const animalQuery = () =>
  tx().select(animalColumns).from(animals).leftJoin(species, eq(species.id, animals.speciesId)).leftJoin(herds, eq(herds.id, animals.herdId));

type AnimalRow = Awaited<ReturnType<typeof animalQuery>>[number];

const isOnFarm = (status: string) => (ANIMAL_ON_FARM_STATUSES as readonly string[]).includes(status);

/** The animal as the books have it now, for the card and for the second look at confirm. */
export async function animalNow(id: string, date: string): Promise<{ animal: FarmAnimal; onFarm: boolean } | null> {
  const [row] = await animalQuery().where(and(eq(animals.id, id), eq(animals.farmId, ctx().farmId)));
  return row ? { animal: toAnimal(row, date), onFarm: isOnFarm(row.status) } : null;
}

/** Animals of this farm that answer to the tag as it was said. A tag said with its letters must match whole. */
async function animalsByTag(tag: StatedTag): Promise<AnimalRow[]> {
  const whole = tag.tag.toUpperCase();
  const digits = plainDigits(tag.digits);
  const lastNumber = sql`ltrim(substring(${animals.tag} from '([0-9]+)[^0-9]*$'), '0')`;
  const identifier = sql`exists (select 1 from ${animalIdentifiers} i where i.animal_id = ${animals.id} and i.active and upper(i.value) in (${whole}, ${tag.digits}))`;
  const rows = await animalQuery().where(
    and(eq(animals.farmId, ctx().farmId), or(eq(sql`upper(${animals.tag})`, whole), identifier, eq(lastNumber, digits))),
  );
  const exact = rows.filter((row) => row.tag.toUpperCase() === whole);
  if (exact.length > 0) return exact;
  // "YA-0567" names one animal: another prefix with the same number is not it.
  return tag.tag === tag.digits ? rows : rows.filter((row) => plainDigits(row.tag) !== digits || row.tag.toUpperCase() === whole);
}

interface FoundAnimal {
  row: AnimalRow;
  said: SaidTag;
}

async function findAnimal(d: FarmDraft, kind: string): Promise<FoundAnimal | null> {
  const named = d.input.tag?.trim();
  if (!named) return d.ask('animal', 'ANIMAL_REQUIRED', 'Ask for the tag number of the animal.');
  const said = saidTag(d, named);
  if (said === null) {
    return d.ask('animal', 'ANIMAL_NOT_STATED', 'That tag number is not in their words. Ask for the tag number of the animal. Do not guess it.');
  }
  if (said === 'count') {
    return d.ask('animal', 'ANIMAL_COUNT_OR_TAG', `"${named}" may be a head count and not a tag. Ask for the tag number, said as a tag, for example "tag ${named}".`);
  }
  const rows = await animalsByTag(said.tag);
  if (rows.length === 0) {
    return d.ask('animal', 'ANIMAL_UNKNOWN', `No animal on this farm has the tag ${said.tag.tag}. Ask them to check the tag number.`);
  }
  const here = rows.filter((row) => isOnFarm(row.status));
  if (here.length > 1) {
    const options = here.map((row) => ({ id: row.tag, label: row.tag }));
    return d.ask('animal', 'ANIMAL_AMBIGUOUS', 'Several animals answer to that number. Ask which tag it was, in full.', options);
  }
  if (here.length === 0) {
    if (kind === 'death' && rows.length === 1) return d.ask('animal', 'ALREADY_RECORDED', `Animal ${rows[0].tag} has already left the farm in the books. Say so. Nothing was recorded.`);
    return d.ask('animal', 'ANIMAL_LEFT', `Animal ${rows[0].tag} is no longer on the farm in the books. Say so and ask them to check the tag.`);
  }
  return { row: here[0], said };
}

// ─── Quantities ─────────────────────────────────────────────────────────────

interface Said {
  quantity: PlacedQuantity;
  text: string;
}

const unitKey = (unit: string) => unitOf(unit) ?? unit;
const ofUnits = (quantities: PlacedQuantity[], units: readonly UnitWord[]) =>
  quantities.filter((q) => (units as readonly string[]).includes(unitKey(q.unit)));

/**
 * The quantities that may belong to this record. For an animal: its own in the sentence that named it,
 * and those of a later message that names no animal, which is the answer to our question.
 */
function quantitiesSaid(d: FarmDraft, units: readonly UnitWord[], animal?: SaidTag): Said[] {
  const found: Said[] = [];
  d.texts.forEach((text, at) => {
    if (!animal) found.push(...ofUnits(placedQuantities(text), units).map((quantity) => ({ quantity, text })));
    else if (at === animal.at) found.push(...quantitiesOfTag(text, animal.tag, units).map((quantity) => ({ quantity, text })));
    else if (at > animal.at && statedTags(text).every((tag) => tag.countLike && !tag.marked)) {
      found.push(...ofUnits(placedQuantities(text), units).map((quantity) => ({ quantity, text })));
    }
  });
  // A quantity said once backs one card, as money does.
  return found.filter((s) => !d.taken.some((t) => t.said === s.text && t.start === s.quantity.start));
}

/** One quantity, as the words have it. Several are settled by the model's reading only if it is one of them. */
function oneQuantity(d: FarmDraft, said: Said[], reading: Pick<FarmInput, 'qty' | 'unit' | 'weightKg'> = d.input): Said | null {
  const distinct = said.filter((s, i) => said.findIndex((o) => o.quantity.qty === s.quantity.qty && unitKey(o.quantity.unit) === unitKey(s.quantity.unit)) === i);
  if (distinct.length === 1) return distinct[0];
  const { qty, unit, weightKg } = reading;
  const wanted = distinct.filter(
    (s) => (s.quantity.qty === qty && (!unit || unitKey(unit) === unitKey(s.quantity.unit))) || (weightKg !== undefined && convertQty(s.quantity.qty, s.quantity.unit, 'kg') === weightKg),
  );
  // The newest stands when they said it again: "46 kilo. Yo'q, 47 kilo" is a correction.
  return wanted.length > 0 ? wanted[wanted.length - 1] : null;
}

const claim = (d: FarmDraft, said: Said) =>
  d.used.push({ qty: said.quantity.qty, unit: unitKey(said.quantity.unit), said: said.text, start: said.quantity.start });

// ─── Names ──────────────────────────────────────────────────────────────────

const option = (c: Candidate) => ({ id: c.id, label: c.name });

type Named = { status: 'found'; candidate: Candidate } | { status: 'ambiguous'; candidates: Candidate[] } | { status: 'none' };

/**
 * A herd, item or warehouse by name: the model's phrase has to stand in the words and single it out.
 * `alone` is false where the words may name several of them, each for its own line.
 */
async function named(d: FarmDraft, type: TargetType, phrase: string | undefined, candidates: Candidate[], alone = true): Promise<Named> {
  if (phrase) {
    const chosen = await resolve(type, phrase, candidates);
    if (chosen.status === 'found' && chosen.how !== 'id' && singledOut(d.texts, phrase, chosen.candidate, candidates)) {
      return { status: 'found', candidate: chosen.candidate };
    }
    if (chosen.status === 'ambiguous') return { status: 'ambiguous', candidates: chosen.candidates };
  }
  if (!alone) return { status: 'none' };
  // The model may leave out or misread a name they did say.
  const said = candidates.filter((c) => singledOut(d.texts, c.name, c, candidates));
  if (said.length === 1) return { status: 'found', candidate: said[0] };
  return said.length > 1 ? { status: 'ambiguous', candidates: said } : { status: 'none' };
}

async function pickHerd(d: FarmDraft): Promise<FarmFields['herd']> {
  const candidates = await costCenterCandidates(['herd']);
  const toHerd = (c: Candidate, defaulted: boolean) => ({ id: String(c.extra?.refId), name: c.name, defaulted });
  const found = await named(d, 'cost_center', d.input.herd, candidates);
  if (found.status === 'found') return toHerd(found.candidate, false);
  // The only herd, when they named none: the same rule as for money, and the card says so.
  if (found.status === 'none' && !d.input.herd && candidates.length === 1) return toHerd(candidates[0], true);
  return d.ask('herd', 'HERD_REQUIRED', 'Ask which herd this was.', (found.status === 'ambiguous' ? found.candidates : candidates).map(option));
}

async function warehouseOf(d: FarmDraft, item: Candidate): Promise<FarmStockLine['warehouse']> {
  const warehouses = await warehouseCandidates();
  const usual = warehouses.find((w) => w.id === item.extra?.defaultWarehouseId);
  const found = await named(d, 'warehouse', d.input.warehouse, warehouses);
  if (found.status === 'found') return { id: found.candidate.id, name: found.candidate.name };
  // The item's own warehouse is the owning service's rule too, and the card names it.
  if (usual && found.status === 'none') return { id: usual.id, name: usual.name };
  return d.ask('warehouse', 'WAREHOUSE_REQUIRED', 'Ask which warehouse it was taken from.', warehouses.map(option));
}

// ─── Kinds ──────────────────────────────────────────────────────────────────

async function weight(d: FarmDraft, f: FarmFields): Promise<string | null> {
  const found = await findAnimal(d, 'weight');
  if (!found) return null;
  f.animal = toAnimal(found.row, f.date);
  const said = oneQuantity(d, quantitiesSaid(d, WEIGHT_UNITS, found.said));
  const kg = said ? convertQty(said.quantity.qty, said.quantity.unit, 'kg') : null;
  if (!said || kg === null) {
    d.ask('weightKg', 'WEIGHT_REQUIRED', `Ask how many kilograms animal ${found.row.tag} weighed. A weight needs its unit, for example "46 kg".`);
  } else if (kg <= 0 || kg > maxLiveWeightKg(found.row.species ?? '')) {
    d.ask('weightKg', 'WEIGHT_NOT_PLAUSIBLE', `${kg} kg is not a possible live weight for this animal. Ask them to check the weight.`);
  } else if (found.row.birthDate && f.date < found.row.birthDate) {
    d.ask('date', 'WEIGHT_BEFORE_BIRTH', `Animal ${found.row.tag} was born on ${found.row.birthDate}, after this day. Ask which day it was weighed.`);
  } else {
    f.weightKg = round(kg, 2);
    claim(d, said);
  }
  return `weight:${found.row.id}`;
}

async function death(d: FarmDraft, f: FarmFields): Promise<string | null> {
  const found = await findAnimal(d, 'death');
  if (!found) return null;
  f.animal = toAnimal(found.row, f.date);
  if (!d.texts.some((text) => deathWords(text))) {
    d.ask('cause', 'DEATH_NOT_STATED', `They did not say that animal ${found.row.tag} died. Ask what happened to it. Do not record a death they did not state.`);
  }
  // Only as they said it: a model's tidy summary of a cause is not a fact.
  f.cause = d.input.cause ? quoteFromWords(d.texts, d.input.cause) : null;
  return `death:${found.row.id}`;
}

async function treatment(d: FarmDraft, f: FarmFields): Promise<string | null> {
  let said: SaidTag | undefined;
  if (d.input.tag) {
    const found = await findAnimal(d, 'treatment');
    if (!found) return null;
    f.animal = toAnimal(found.row, f.date);
    said = found.said;
  } else if (d.input.herd) {
    f.herd = await pickHerd(d);
    if (!f.herd) return null;
  } else {
    return d.ask('animal', 'CARE_TARGET_REQUIRED', 'Ask which animal (its tag number) or which herd was treated.');
  }
  f.healthType = careWords(d.texts.join(' . '));
  f.cause = d.input.cause ? quoteFromWords(d.texts, d.input.cause) : null;

  const items = await itemCandidates();
  const drug = await named(d, 'item', d.input.drug, items);
  const spoken = quantitiesSaid(d, DOSE_UNITS, said);
  const subject = f.animal ? `animal:${f.animal.id}` : `herd:${f.herd!.id}`;

  if (drug.status === 'ambiguous') {
    d.ask('drug', 'DRUG_AMBIGUOUS', 'Several stock items answer to that name. Ask which one was used.', drug.candidates.map(option));
    return `treatment:${subject}`;
  }
  if (drug.status === 'none') {
    // Not a stock item: it is kept as they named it, and nothing leaves the warehouse.
    const name = d.input.drug ? quoteFromWords(d.texts, d.input.drug) : null;
    if (!name) {
      d.ask('drug', 'DRUG_REQUIRED', 'Ask which drug or vaccine was used. Do not guess it.');
      return `treatment:${subject}`;
    }
    f.drug = { itemId: null, name };
    d.warn('DRUG_NOT_STOCKED');
    const dose = f.animal ? oneQuantity(d, spoken) : null;
    if (dose) {
      f.dose = dose.quantity.qty;
      f.doseUnit = unitKey(dose.quantity.unit);
      claim(d, dose);
    }
    return `treatment:${subject}:${name.toLowerCase()}`;
  }

  const item = drug.candidate;
  const unit = String(item.extra?.unit);
  f.drug = { itemId: item.id, name: item.name };
  const key = `treatment:${subject}:${item.id}`;
  // A dose in ml says nothing about vials: only what converts exactly may leave the warehouse.
  const inItemUnit = (s: Said) => convertQty(s.quantity.qty, s.quantity.unit, unit);
  // The warehouse counts to three decimals: 0.5 ml of something kept in litres cannot leave it as said.
  const countable = spoken.filter((s) => (inItemUnit(s) ?? 0) > 0 && round(inItemUnit(s)!, 3) === inItemUnit(s));
  const leaving = oneQuantity(d, countable);
  if (!leaving) {
    if (spoken.length > 0 && countable.length === 0) {
      d.ask('dose', 'DOSE_UNIT_MISMATCH', `The warehouse keeps ${item.name} in ${unit}. Ask how many ${unit} were used. Do not work it out yourself.`);
    } else {
      d.ask('dose', 'DOSE_REQUIRED', `Ask how much ${item.name} was used, with its unit. It is taken from the warehouse, so it cannot be guessed.`);
    }
    return key;
  }
  const warehouse = await warehouseOf(d, item);
  if (!warehouse) return key;
  if (f.animal) {
    // "5 ml" beside "1 flakon": the first is the dose the animal got, the second what left the shelf.
    const others = ofUnits(spoken.filter((s) => !countable.includes(s)).map((s) => s.quantity), GIVEN_UNITS);
    const given = oneQuantity(d, spoken.filter((s) => others.includes(s.quantity)));
    const dose = given ?? leaving;
    f.dose = dose.quantity.qty;
    f.doseUnit = unitKey(dose.quantity.unit);
    if (dose !== leaving) claim(d, dose);
  }
  f.stockOut = [{ itemId: item.id, name: item.name, unit, qty: round(inItemUnit(leaving)!, 3), warehouse }];
  claim(d, leaving);
  return key;
}

/**
 * Which amount belongs to which feed in one message, by where they stand: "300 kilo beda va 50 kilo
 * arpa" or "beda 300 kilo, arpa 50 kilo". An amount is tied to the one stock item beside it, read
 * the same way through the whole message. An amount with no feed beside it belongs to something else
 * ("1234 46 kilo chiqdi"). Two feeds beside one amount, or two ways to read the message, tie nothing
 * together, and the card asks.
 */
function feedsOfText(text: string, items: Candidate[]): Map<string, PlacedQuantity> {
  const placed = ofUnits(placedQuantities(text), FEED_UNITS);
  const itemsIn = (part: string) => items.filter((c) => singledOut([part], c.name, c, items));
  const none = new Map<string, PlacedQuantity>();
  if (placed.length === 0) return none;
  if (placed.length === 1) {
    const only = itemsIn(text);
    return only.length === 1 ? new Map([[only[0].id, placed[0]]]) : none;
  }
  const read = (parts: string[]): Map<string, PlacedQuantity> | null => {
    const tied = new Map<string, PlacedQuantity>();
    for (const [i, part] of parts.entries()) {
      const found = itemsIn(part);
      if (found.length === 0) continue;
      if (found.length > 1 || tied.has(found[0].id)) return null;
      tied.set(found[0].id, placed[i]);
    }
    return tied;
  };
  const end = (q: PlacedQuantity) => q.start + q.raw.length;
  const amountFirst = read(placed.map((q, i) => text.slice(q.start, placed[i + 1]?.start ?? text.length)));
  const feedFirst = read(placed.map((q, i) => text.slice(i === 0 ? 0 : end(placed[i - 1]), end(q))));
  if (!amountFirst || !feedFirst) return none;
  const same = (a: Map<string, PlacedQuantity>, b: Map<string, PlacedQuantity>) => a.size === b.size && [...a].every(([id, q]) => b.get(id) === q);
  if (same(amountFirst, feedFirst)) return amountFirst;
  // The reading that gives every amount its feed stands over one that leaves some without.
  const whole = [amountFirst, feedFirst].filter((reading) => reading.size === placed.length);
  if (whole.length === 1) return whole[0];
  if (whole.length === 0 && (amountFirst.size === 0 || feedFirst.size === 0)) return amountFirst.size > 0 ? amountFirst : feedFirst;
  return none;
}

/** The feeds of the herd's ration that this card does not hold: the daily log writes them as not given. */
async function restOfRation(herdId: string, held: Set<string>): Promise<string[]> {
  const rows = await tx()
    .select({ itemId: rationLines.itemId, name: stockItems.name })
    .from(herds)
    .innerJoin(rationLines, eq(rationLines.rationId, herds.rationId))
    .innerJoin(stockItems, eq(stockItems.id, rationLines.itemId))
    .where(and(eq(herds.id, herdId), eq(herds.farmId, ctx().farmId)));
  return rows.filter((row) => !held.has(row.itemId)).map((row) => row.name).sort();
}

async function herdLog(d: FarmDraft, f: FarmFields): Promise<string | null> {
  f.herd = await pickHerd(d);
  if (!f.herd) return null;
  const key = `herd_log:${f.herd.id}:${f.date}`;
  const items = await itemCandidates();
  const asked = d.input.feeds?.length ? d.input.feeds : [{ feed: d.input.feed, qty: d.input.qty, unit: d.input.unit }];

  // What the words tie together. A later message stands over an earlier one.
  const tiedTo = new Map<string, Said>();
  const loose: Said[] = [];
  for (const text of d.texts) {
    const free = (q: PlacedQuantity) => !d.taken.some((t) => t.said === text && t.start === q.start);
    const pairs = feedsOfText(text, items);
    for (const [id, quantity] of pairs) if (free(quantity)) tiedTo.set(id, { quantity, text });
    // An amount in a message that names no feed and no animal is the answer to our question.
    const namesNothing = !items.some((c) => singledOut([text], c.name, c, items)) && statedTags(text).every((tag) => tag.countLike && !tag.marked);
    if (pairs.size === 0 && namesNothing) loose.push(...ofUnits(placedQuantities(text), FEED_UNITS).filter(free).map((quantity) => ({ quantity, text })));
  }

  const wanted: { item: Candidate; line: (typeof asked)[number] }[] = [];
  for (const line of asked) {
    const feed = await named(d, 'item', line.feed, items, asked.length === 1);
    if (feed.status === 'ambiguous') {
      d.ask('feed', 'FEED_AMBIGUOUS', 'Several stock items answer to that name. Ask which feed was given.', feed.candidates.map(option));
      return key;
    }
    if (feed.status === 'none') {
      d.ask('feed', 'FEED_REQUIRED', 'Ask which feed from the warehouse was given. It has to be an item the warehouse keeps, named in their words.');
      return key;
    }
    if (!wanted.some((w) => w.item.id === feed.candidate.id)) wanted.push({ item: feed.candidate, line });
  }

  const untied = wanted.filter((w) => !tiedTo.has(w.item.id));
  const lines: FarmStockLine[] = [];
  const claims: Said[] = [];
  for (const w of wanted) {
    const unit = String(w.item.extra?.unit);
    const own = tiedTo.get(w.item.id);
    // An amount said alone can only answer for one feed.
    const alone = wanted.length === 1 || (untied.length === 1 && untied[0] === w) ? loose : [];
    const quantity = oneQuantity(d, [...(own ? [own] : []), ...alone], w.line);
    if (!quantity) {
      d.ask('qty', 'FEED_QTY_REQUIRED', `Ask how much ${w.item.name} was given, with its unit. Each feed needs its own amount beside it, for example "300 kg beda, 50 kg arpa". Do not share out or guess an amount.`);
      return key;
    }
    const qty = convertQty(quantity.quantity.qty, quantity.quantity.unit, unit);
    // The warehouse counts to three decimals: an amount that does not fit cannot leave it as said.
    if (qty === null || qty <= 0 || round(qty, 3) !== qty) {
      d.ask('qty', 'FEED_UNIT_MISMATCH', `The warehouse keeps ${w.item.name} in ${unit}. Ask how many ${unit} were given. Do not work it out yourself.`);
      return key;
    }
    // Which warehouse it leaves is the feeding record's own rule, decided when it is written.
    lines.push({ itemId: w.item.id, name: w.item.name, unit, qty, warehouse: null });
    claims.push(quantity);
  }
  f.stockOut = lines;
  claims.forEach((said) => claim(d, said));
  const rest = await restOfRation(f.herd.id, new Set(lines.map((line) => line.itemId)));
  if (rest.length > 0) d.warn('RATION_REST_NOT_GIVEN', { items: rest.join(', ') });
  return key;
}

/** Every kind this file can check. Which of them are offered is `FARM_RECORD_KINDS`. */
const KINDS: Record<string, (d: FarmDraft, f: FarmFields) => Promise<string | null>> = {
  weight,
  death,
  treatment,
  herd_log: herdLog,
};

/** `taken` is what the other cards of this conversation already rest on. */
export async function validateFarm(kind: FarmRecordKind, input: FarmInput, env: DraftEnv, taken: UsedQuantity[] = []): Promise<FarmValidated> {
  const d = new FarmDraft(input, env, taken);
  const fields = emptyFields(checkDate(d));
  const key = await KINDS[kind](d, fields);
  if (d.questions.length === 0 && (await alreadyInBooks(kind, fields))) {
    d.ask('date', 'ALREADY_RECORDED', 'This is already in the books for that day. Say so. Nothing was recorded.');
  }
  return { fields, questions: d.questions, warnings: d.warnings, key, used: d.used };
}

// ─── The books as they stand ────────────────────────────────────────────────

/** The same record already in the books: the animal weighed that day, its death, that herd's day, that treatment. */
export async function alreadyInBooks(kind: string, f: FarmFields): Promise<boolean> {
  const farm = ctx().farmId;
  const any = (rows: unknown[]) => rows.length > 0;
  if (kind === 'weight' && f.animal) {
    return any(await tx().select({ id: weightRecords.id }).from(weightRecords).where(and(eq(weightRecords.farmId, farm), eq(weightRecords.animalId, f.animal.id), eq(weightRecords.date, f.date))).limit(1));
  }
  if (kind === 'death' && f.animal) {
    return any(await tx().select({ id: animalExits.id }).from(animalExits).where(and(eq(animalExits.farmId, farm), eq(animalExits.animalId, f.animal.id), eq(animalExits.type, 'death'))).limit(1));
  }
  if (kind === 'herd_log' && f.herd) {
    return any(await tx().select({ id: dailyLogs.id }).from(dailyLogs).where(and(eq(dailyLogs.farmId, farm), eq(dailyLogs.herdId, f.herd.id), eq(dailyLogs.date, f.date))).limit(1));
  }
  if (kind === 'treatment' && f.healthType && (f.animal || f.herd)) {
    const target = f.animal ? eq(healthRecords.animalId, f.animal.id) : eq(healthRecords.herdId, f.herd!.id);
    const rows = await tx()
      .select({ itemId: healthRecords.itemId, notes: healthRecords.notes })
      .from(healthRecords)
      .where(and(eq(healthRecords.farmId, farm), target, eq(healthRecords.date, f.date), eq(healthRecords.type, f.healthType)));
    return rows.some((row) => (f.drug?.itemId ? row.itemId === f.drug.itemId : row.itemId === null && (row.notes ?? '') === (f.drug?.name ?? '')));
  }
  return false;
}
