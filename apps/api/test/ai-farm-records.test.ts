/**
 * Farm records by dictation (docs/assistant.md, "Farm records"): the model only names what it read,
 * code finds every fact in the person's words, and confirm writes through the owning module's service
 * as the person who confirmed.
 */
import { and, eq } from 'drizzle-orm';
import { DEFAULT_ROLE_PERMISSIONS, type Permission } from '@yap/shared';
import { latinToCyrillic } from '@yap/shared/i18n';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { ensureCostCenter } from '../src/core/costCenters';
import { receiveStock, stockOnHand } from '../src/core/inventory';
import { ensureConversation } from '../src/modules/ai/conversations';
import { setProvider } from '../src/modules/ai/provider';
import { renderFarmProposalText } from '../src/modules/ai/records/farm-render';
import { saveFarmDraft } from '../src/modules/ai/records/farm-service';
import type { FarmInput, FarmProposalView } from '../src/modules/ai/records/farm-types';
import { FARM_RECORD_KINDS, type FarmRecordKind } from '../src/modules/ai/records/routing';
import { listPending } from '../src/modules/ai/records/service';
import type { DraftEnv } from '../src/modules/ai/records/types';
import { createDailyLog } from '../src/modules/livestock/daily-logs.service';
import { createExit } from '../src/modules/livestock/exits.service';
import { createRecord as createHealthRecord } from '../src/modules/livestock/health.service';
import { createWeight } from '../src/modules/livestock/weights.service';
import { Scripted, call, daysAgo, say, today } from './ai-world';
import { createFixture, type Client, type Fixture, type FixtureOptions } from './helpers';

const { aiProposals, animalExits, animals, dailyLogLines, dailyLogs, events, healthRecords, herds, items, rationLines, rations, roles, species, stockMovements, warehouses, weightRecords } =
  schema;

interface Farm {
  f: Fixture;
  owner: Client;
  herdId: string;
  /** Animal ids by tag. */
  animal: Record<string, string>;
  /** Stock item ids by name. */
  item: Record<string, string>;
  vetStoreId: string;
  feedStoreId: string;
}

/**
 * What the vet store keeps. The unit matters: millilitres convert to litres exactly, and say nothing
 * about vials. Vitamin has no usual warehouse, so the person has to name one.
 */
const DRUGS = [
  { name: 'Ivermektin', unit: 'l', qty: 2, usual: true, withdrawalDays: 14 },
  { name: 'Oksitetratsiklin', unit: 'vial', qty: 10, usual: true, withdrawalDays: 21 },
  { name: 'Gijja dori', unit: 'dose', qty: 500, usual: true, withdrawalDays: null },
  { name: 'Vitamin', unit: 'vial', qty: 10, usual: false, withdrawalDays: null },
];
const DRUG_COST = 40_000;

/** What the feed store keeps: hay and grain by the kilogram, straw by the bale. */
const FEEDS = [
  { name: 'Beda', unit: 'kg', qty: 5000 },
  { name: 'Arpa', unit: 'kg', qty: 1000 },
  { name: 'Somon', unit: 'bale', qty: 200 },
];
const FEED_COST = 1500;

const TAGS = ['1234', '1235', '0567', '46', 'A-0777', 'B-0777'];

/** A farm with one herd, "1-otar", and a few ewes whose tags the tests say aloud. */
async function farm(options: FixtureOptions = {}): Promise<Farm> {
  const f = await createFixture(options);
  const owner = await f.as('owner');
  const base = { tenantId: f.tenantId, farmId: f.farmId };
  return f.run(async () => {
    const [sheep] = await tx().select().from(species).where(eq(species.key, 'sheep'));
    const [herd] = await tx().insert(herds).values({ ...base, name: '1-otar' }).returning();
    await tx().update(herds).set({ costCenterId: await ensureCostCenter('herd', herd.id, herd.name) }).where(eq(herds.id, herd.id));
    const rows = await tx()
      .insert(animals)
      .values(TAGS.map((tag) => ({ ...base, tag, speciesId: sheep.id, sex: 'female', category: 'ewe', origin: 'purchased', birthDate: daysAgo(430), herdId: herd.id })))
      .returning();
    const [vetStore] = await tx().insert(warehouses).values({ ...base, name: 'Vet ombor', type: 'vet' }).returning();
    const item: Record<string, string> = {};
    for (const drug of DRUGS) {
      const [row] = await tx()
        .insert(items)
        .values({ ...base, name: drug.name, category: 'vet_drug', unit: drug.unit, withdrawalDays: drug.withdrawalDays, defaultWarehouseId: drug.usual ? vetStore.id : null })
        .returning();
      await receiveStock({ itemId: row.id, warehouseId: vetStore.id, qty: drug.qty, unitCost: DRUG_COST, date: daysAgo(30), source: 'opening' });
      item[drug.name] = row.id;
    }
    const [feedStore] = await tx().insert(warehouses).values({ ...base, name: 'Yem ombori', type: 'feed' }).returning();
    for (const feed of FEEDS) {
      const [row] = await tx().insert(items).values({ ...base, name: feed.name, category: 'feed', unit: feed.unit, defaultWarehouseId: feedStore.id }).returning();
      await receiveStock({ itemId: row.id, warehouseId: feedStore.id, qty: feed.qty, unitCost: FEED_COST, date: daysAgo(30), source: 'opening' });
      item[feed.name] = row.id;
    }
    return { f, owner, herdId: herd.id, animal: Object.fromEntries(rows.map((row) => [row.tag, row.id])), item, vetStoreId: vetStore.id, feedStoreId: feedStore.id };
  });
}

/** One conversation: what is said in it, and the cards it holds. */
interface Talk {
  conversationId: string;
  draft(kind: FarmRecordKind, input: FarmInput, texts: string | string[], proposalId?: string, env?: Partial<DraftEnv>): ReturnType<typeof saveFarmDraft>;
  ready(kind: FarmRecordKind, input: FarmInput, texts: string | string[], proposalId?: string): Promise<FarmProposalView>;
  asked(kind: FarmRecordKind, input: FarmInput, texts: string | string[], proposalId?: string): Promise<string[]>;
}

async function talk(w: Farm, person: Client = w.owner): Promise<Talk> {
  const as = { userId: person.userId };
  const conversationId = await w.f.run(() => ensureConversation(undefined, 'x'), as);
  const draft: Talk['draft'] = (kind, input, texts, proposalId, env = {}) =>
    w.f.run(
      () => saveFarmDraft(kind, input, { userTexts: [texts].flat(), documentAmounts: [], channel: 'web', conversationId, ...env }, proposalId),
      as,
    );
  return {
    conversationId,
    draft,
    async ready(kind, input, texts, proposalId) {
      const result = await draft(kind, input, texts, proposalId);
      if (result.status !== 'ready') throw new Error(`not ready: ${JSON.stringify(result.questions)}`);
      return result.proposal;
    },
    async asked(kind, input, texts, proposalId) {
      const result = await draft(kind, input, texts, proposalId);
      if (result.status !== 'needs_info') throw new Error(`expected a question, got a card: ${JSON.stringify(result.proposal.fields)}`);
      return result.questions.map((q) => q.code);
    },
  };
}

const confirm = (client: Client, card: FarmProposalView, stamp = card.stamp) => client.post(`/ai/farm-proposals/${card.id}/confirm`, { stamp });
const undo = (client: Client, card: { id: string }) => client.post(`/ai/farm-proposals/${card.id}/undo`, {});

const eventsOf = (w: Farm, type: string) => w.f.run(() => tx().select().from(events).where(eq(events.type, type)));
const exitsOf = (w: Farm, tag: string) => w.f.run(() => tx().select().from(animalExits).where(eq(animalExits.animalId, w.animal[tag])));
const animalOf = async (w: Farm, tag: string) => (await w.f.run(() => tx().select().from(animals).where(eq(animals.id, w.animal[tag]))))[0];
const careOf = (w: Farm, tag: string) => w.f.run(() => tx().select().from(healthRecords).where(eq(healthRecords.animalId, w.animal[tag])));
const stockOf = (w: Farm, name: string) => w.f.run(() => stockOnHand(w.item[name]));
/** What left the warehouse, or came back to it, for one record. */
const movementsOf = (w: Farm, refType: string, refId: string) =>
  w.f.run(() => tx().select().from(stockMovements).where(and(eq(stockMovements.refType, refType), eq(stockMovements.refId, refId))));
const weightsOf = (w: Farm, tag: string) => w.f.run(() => tx().select().from(weightRecords).where(eq(weightRecords.animalId, w.animal[tag])));

/** A role as it is by default, plus the assistant and whatever the test adds. */
const grant = (f: Fixture, role: keyof typeof DEFAULT_ROLE_PERMISSIONS, ...more: Permission[]) =>
  f.run(() =>
    tx()
      .update(roles)
      .set({ permissions: [...new Set([...DEFAULT_ROLE_PERMISSIONS[role], 'ai.view', ...more])] })
      .where(eq(roles.id, f.roleIds[role])),
  );

const setPermissions = (f: Fixture, role: keyof typeof DEFAULT_ROLE_PERMISSIONS, permissions: string[]) =>
  f.run(() => tx().update(roles).set({ permissions }).where(eq(roles.id, f.roleIds[role])));

const offered = (provider: Scripted) => (provider.requests[0].tools ?? []).map((tool) => tool.name);

afterEach(() => setProvider(undefined));

// ─── Weight ─────────────────────────────────────────────────────────────────

const WEIGHED = "1234-qo'y 46 kilo chiqdi";

describe('weight: what the card rests on', () => {
  let w: Farm;
  beforeAll(async () => {
    w = await farm();
  });

  it('a tag and kilograms in the words make a card that names the animal plainly', async () => {
    const t = await talk(w);
    const card = await t.ready('weight', { tag: '1234', weightKg: 46 }, WEIGHED);
    expect(card).toMatchObject({ kind: 'weight', status: 'pending', needsAnswer: false, sourceText: WEIGHED });
    expect(card.fields).toMatchObject({
      date: today,
      weightKg: 46,
      animal: { id: w.animal['1234'], tag: '1234', sex: 'female', category: 'ewe', species: 'sheep', ageMonths: 14, herd: { name: '1-otar' } },
    });
    // Nothing is in the books until a person confirms.
    expect(await weightsOf(w, '1234')).toEqual([]);
  });

  it.each([
    ['Uzbek Latin', WEIGHED],
    ['Uzbek Cyrillic', latinToCyrillic(WEIGHED)],
    ['Russian', 'Овца номер 1234 весит 46 кг'],
    ['English', 'Sheep number 1234 weighed 46 kg'],
  ])('reads it in %s', async (_, text) => {
    const t = await talk(w);
    expect((await t.ready('weight', { tag: '1234', weightKg: 46 }, text)).fields).toMatchObject({ weightKg: 46, animal: { tag: '1234' } });
  });

  it('the kilograms come from the words, whatever the model claims', async () => {
    const t = await talk(w);
    expect((await t.ready('weight', { tag: '1234', weightKg: 64 }, WEIGHED)).fields.weightKg).toBe(46);
    const other = await talk(w);
    expect(await other.asked('weight', { tag: '1234', weightKg: 46 }, "1234-qo'yni bugun tortdim")).toEqual(['WEIGHT_REQUIRED']);
    // A bare number is not a weight: it needs its unit.
    expect(await other.asked('weight', { tag: '1234', weightKg: 46 }, "1234-qo'y 46 chiqdi")).toEqual(['WEIGHT_REQUIRED']);
  });

  it('the tag has to be in the words too', async () => {
    const t = await talk(w);
    expect(await t.asked('weight', { weightKg: 46 }, "qo'y 46 kilo chiqdi")).toEqual(['ANIMAL_REQUIRED']);
    expect(await t.asked('weight', { tag: '1235', weightKg: 46 }, WEIGHED)).toEqual(['ANIMAL_NOT_STATED']);
    expect(await t.asked('weight', { tag: '9999', weightKg: 46 }, "9999-qo'y 46 kilo chiqdi")).toEqual(['ANIMAL_UNKNOWN']);
  });

  it('"46 kilo" is never the animal with tag 46', async () => {
    const t = await talk(w);
    expect(await t.asked('weight', { tag: '46', weightKg: 46 }, "qo'y 46 kilo chiqdi")).toEqual(['ANIMAL_NOT_STATED']);
    const card = await t.ready('weight', { tag: '46', weightKg: 51 }, "46 raqamli qo'y 51 kilo chiqdi");
    expect(card.fields).toMatchObject({ weightKg: 51, animal: { tag: '46' } });
  });

  it.each([
    ["0567 raqamli qo'y 48 kilo chiqdi"],
    ['овца № 567 весит 48 кг'],
    ['овца номер 0567, 48 килограммов'],
    ['#567 weighed 48 kg'],
    ['567ni tortdim, 48 kilo'],
  ])('finds the animal however the tag was said: %s', async (text) => {
    const t = await talk(w);
    expect((await t.ready('weight', { tag: '567', weightKg: 48 }, text)).fields).toMatchObject({ weightKg: 48, animal: { tag: '0567' } });
  });

  it('a number that several animals answer to is a question, and the full tag settles it', async () => {
    const t = await talk(w);
    const result = await t.draft('weight', { tag: '777', weightKg: 50 }, '777 raqamli 50 kilo chiqdi');
    expect(result).toMatchObject({ status: 'needs_info', questions: [{ code: 'ANIMAL_AMBIGUOUS' }] });
    expect(result.status === 'needs_info' && result.questions[0].options.map((o) => o.label).sort()).toEqual(['A-0777', 'B-0777']);
    expect((await t.ready('weight', { tag: 'B-0777', weightKg: 50 }, 'B-0777 raqamli 50 kilo chiqdi')).fields.animal?.tag).toBe('B-0777');
  });

  it('two bare numbers side by side are not split by guessing: it asks for the weight', async () => {
    const t = await talk(w);
    expect(await t.asked('weight', { tag: '1234', weightKg: 46 }, '1234 46 kilo')).toEqual(['WEIGHT_REQUIRED']);
    expect((await t.ready('weight', { tag: '1234', weightKg: 46 }, ['1234 46 kilo', '46 kilo'])).fields.weightKg).toBe(46);
  });

  it.each([['0567 48 kilo chiqdi'], ['№567 48 кг'], ['tag 0567 48 kg']])(
    'a weight straight after a number said as a tag is that animal\'s weight: %s',
    async (text) => {
      const t = await talk(w);
      expect((await t.ready('weight', { tag: '567', weightKg: 48 }, text)).fields).toMatchObject({ weightKg: 48, animal: { tag: '0567' } });
    },
  );

  it('a full tag with its letters and the weight beside it make a card', async () => {
    const t = await talk(w);
    expect((await t.ready('weight', { tag: 'B-0777', weightKg: 50 }, 'B-0777 50 kilo chiqdi')).fields).toMatchObject({ weightKg: 50, animal: { tag: 'B-0777' } });
  });

  it('two animals in one sentence are two cards, each with its own weight', async () => {
    const t = await talk(w);
    const text = "1234-qo'y 46 kilo, 1235-qo'y 48 kilo chiqdi";
    // The model swapped the weights: the words put them back.
    const first = await t.ready('weight', { tag: '1234', weightKg: 48 }, text);
    const second = await t.ready('weight', { tag: '1235', weightKg: 46 }, text);
    expect(first.id).not.toBe(second.id);
    expect([first.fields.animal?.tag, first.fields.weightKg]).toEqual(['1234', 46]);
    expect([second.fields.animal?.tag, second.fields.weightKg]).toEqual(['1235', 48]);
  });

  it('a weight said once backs one card, never a second', async () => {
    const t = await talk(w);
    const text = "1234-qo'y va 1235-qo'y 46 kilo chiqdi";
    expect(await t.asked('weight', { tag: '1234', weightKg: 46 }, text)).toEqual(['WEIGHT_REQUIRED']);
    expect((await t.ready('weight', { tag: '1235', weightKg: 46 }, text)).fields.weightKg).toBe(46);

    const later = await talk(w);
    const said = "0567 raqamli qo'y 46 kilo chiqdi";
    await later.ready('weight', { tag: '0567', weightKg: 46 }, said);
    // The next message names another animal and no weight: the earlier 46 is not its weight.
    expect(await later.asked('weight', { tag: '46', weightKg: 46 }, [said, "46 raqamli qo'yni ham tortdim"])).toEqual(['WEIGHT_REQUIRED']);
  });

  it.each([
    ['Uzbek Latin', "kecha 1234-qo'y 46 kilo chiqdi"],
    ['Uzbek Cyrillic', latinToCyrillic("kecha 1234-qo'y 46 kilo chiqdi")],
    ['Russian', 'вчера овца номер 1234 весила 46 кг'],
    ['English', 'yesterday sheep number 1234 weighed 46 kg'],
  ])('"yesterday" in %s dates the card, and the model cannot move it', async (_, text) => {
    const t = await talk(w);
    expect((await t.ready('weight', { tag: '1234', weightKg: 46 }, text)).fields.date).toBe(daysAgo(1));
    const other = await talk(w);
    expect(await other.asked('weight', { tag: '1234', weightKg: 46, date: daysAgo(3) }, text)).toEqual(['DATE_UNCLEAR']);
  });

  it('refuses a day that has not come and a weight no sheep has', async () => {
    const t = await talk(w);
    expect(await t.asked('weight', { tag: '1234', weightKg: 46 }, "ertaga 1234-qo'y 46 kilo chiqadi")).toEqual(['DATE_IN_FUTURE']);
    expect(await t.asked('weight', { tag: '1234', weightKg: 460 }, "1234-qo'y 460 kilo chiqdi")).toEqual(['WEIGHT_NOT_PLAUSIBLE']);
  });

  it('saying it again corrects the card, and so does naming the card', async () => {
    const t = await talk(w);
    const card = await t.ready('weight', { tag: '1234', weightKg: 46 }, WEIGHED);
    const again = await t.draft('weight', { tag: '1234', weightKg: 47 }, "yo'q, 1234-qo'y 47 kilo chiqdi");
    expect(again).toMatchObject({ status: 'ready', replaced: true, proposal: { id: card.id, fields: { weightKg: 47 } } });
    // By the card: the new words need not repeat the tag.
    const byCard = await t.ready('weight', { tag: '1234', weightKg: 45 }, "yo'q, 45 kilo", card.id);
    expect(byCard).toMatchObject({ id: card.id, fields: { weightKg: 45, animal: { tag: '1234' } } });
    expect(byCard.stamp).not.toBe(card.stamp);
    expect(await w.f.run(() => tx().select().from(aiProposals).where(eq(aiProposals.conversationId, t.conversationId)))).toHaveLength(1);
  });

  it('a correction that raises a question leaves the card unconfirmable until it is answered', async () => {
    const t = await talk(w);
    const card = await t.ready('weight', { tag: '1234', weightKg: 46 }, WEIGHED);
    expect(await t.asked('weight', { tag: '1234', weightKg: 460 }, "yo'q, 460 kilo", card.id)).toEqual(['WEIGHT_NOT_PLAUSIBLE']);
    const refused = await confirm(w.owner, card);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PROPOSAL_NEEDS_ANSWER');
    expect(await weightsOf(w, '1234')).toEqual([]);
    const fixed = await t.ready('weight', { tag: '1234', weightKg: 47 }, '47 kilo', card.id);
    expect(fixed).toMatchObject({ id: card.id, needsAnswer: false, fields: { weightKg: 47 } });
  });
});

describe('weight: confirm writes through the livestock service', () => {
  it('records the weight as the person, with the journal events, and undo takes it back', async () => {
    const w = await farm();
    const t = await talk(w);
    const card = await t.ready('weight', { tag: '1234', weightKg: 46 }, "kecha 1234-qo'y 46 kilo chiqdi");

    const done = await confirm(w.owner, card);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.data).toMatchObject({ status: 'confirmed', canUndo: true, result: { type: 'weight_record' } });

    const [row] = await weightsOf(w, '1234');
    expect(row).toMatchObject({ id: done.data.result.id, weightKg: 46, date: daysAgo(1), createdBy: w.owner.userId });
    const [animal] = await w.f.run(() => tx().select().from(animals).where(eq(animals.id, w.animal['1234'])));
    expect(animal.currentWeightKg).toBe(46);
    // The owning service's own event, and the assistant's.
    expect(await eventsOf(w, 'animal.weighed')).toMatchObject([{ entityId: w.animal['1234'], createdBy: w.owner.userId }]);
    expect(await eventsOf(w, 'ai_proposal.confirmed')).toMatchObject([{ entityId: card.id, data: { kind: 'weight', resultType: 'weight_record', resultId: row.id } }]);

    // A second tap changes nothing.
    expect((await confirm(w.owner, card)).body.error.code).toBe('PROPOSAL_NOT_PENDING');
    expect(await weightsOf(w, '1234')).toHaveLength(1);

    const back = await undo(w.owner, card);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.data).toMatchObject({ status: 'undone', canUndo: false });
    expect(await weightsOf(w, '1234')).toEqual([]);
    expect(await eventsOf(w, 'ai_proposal.undone')).toHaveLength(1);
    expect((await undo(w.owner, card)).body.error.code).toBe('PROPOSAL_NOT_CONFIRMED');
  });

  it('confirm needs the card the person read', async () => {
    const w = await farm();
    const t = await talk(w);
    const card = await t.ready('weight', { tag: '1234', weightKg: 46 }, WEIGHED);
    const changed = await t.ready('weight', { tag: '1234', weightKg: 47 }, '47 kilo', card.id);
    const stale = await confirm(w.owner, card);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'PROPOSAL_CHANGED', details: { proposal: { stamp: changed.stamp } } });
    expect(await weightsOf(w, '1234')).toEqual([]);
    expect((await confirm(w.owner, changed)).status).toBe(200);
  });

  it('refuses what is already in the books, when drafting and again at confirm', async () => {
    const w = await farm();
    const t = await talk(w);
    const card = await t.ready('weight', { tag: '1234', weightKg: 46 }, WEIGHED);
    // Entered on the weighing screen in the meantime.
    await w.f.run(() => createWeight({ animalId: w.animal['1234'], date: today, weightKg: 46 }), { userId: w.owner.userId });

    const refused = await confirm(w.owner, card);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('FARM_RECORD_EXISTS');
    expect(await weightsOf(w, '1234')).toHaveLength(1);

    const other = await talk(w);
    expect(await other.asked('weight', { tag: '1234', weightKg: 46 }, WEIGHED)).toEqual(['ALREADY_RECORDED']);
  });

  it('refuses when the animal has left the farm since the card was made', async () => {
    const w = await farm();
    const t = await talk(w);
    const card = await t.ready('weight', { tag: '1234', weightKg: 46 }, WEIGHED);
    await w.f.run(() => tx().update(animals).set({ status: 'sold' }).where(eq(animals.id, w.animal['1234'])));

    const refused = await confirm(w.owner, card);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PROPOSAL_STALE');
    expect(await weightsOf(w, '1234')).toEqual([]);
    const other = await talk(w);
    expect(await other.asked('weight', { tag: '1234', weightKg: 46 }, WEIGHED)).toEqual(['ANIMAL_LEFT']);
  });

  it('the right to record a weight is checked at confirm, as on the weighing screen', async () => {
    const w = await farm();
    await grant(w.f, 'zootechnician');
    const zoo = await w.f.as('zootechnician');
    const t = await talk(w, zoo);
    const card = await t.ready('weight', { tag: '1234', weightKg: 46 }, WEIGHED);

    // The right is taken away between the card and the tap.
    await setPermissions(w.f, 'zootechnician', ['ai.view', 'livestock.view', 'livestock.create']);
    const refused = await confirm(zoo, card);
    expect(refused.status).toBe(403);
    expect(await weightsOf(w, '1234')).toEqual([]);
    // The manual screen says the same.
    expect((await zoo.post('/livestock/weights', { animalId: w.animal['1234'], weightKg: 46 })).status).toBe(403);

    await grant(w.f, 'zootechnician');
    const done = await confirm(zoo, card);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await weightsOf(w, '1234')).toMatchObject([{ createdBy: zoo.userId }]);
  });

  it('a card belongs to the person it was made for, and to their farm', async () => {
    const w = await farm();
    await grant(w.f, 'director');
    const t = await talk(w);
    const card = await t.ready('weight', { tag: '1234', weightKg: 46 }, WEIGHED);

    const director = await w.f.as('director');
    expect((await confirm(director, card)).status).toBe(403);
    expect((await director.get('/ai/farm-proposals')).data).toEqual([]);

    const elsewhere = await farm();
    expect((await confirm(elsewhere.owner, card)).status).toBe(404);
    expect((await elsewhere.owner.get(`/ai/farm-proposals/${card.id}`)).status).toBe(404);
    expect(await weightsOf(w, '1234')).toEqual([]);
    // A tag of another farm is not found from here.
    const far = await talk(elsewhere);
    await elsewhere.f.run(() => tx().delete(animals).where(and(eq(animals.farmId, elsewhere.f.farmId), eq(animals.tag, '1234'))));
    expect(await far.asked('weight', { tag: '1234', weightKg: 46 }, WEIGHED)).toEqual(['ANIMAL_UNKNOWN']);
  });

  it('stays out of the money cards', async () => {
    const w = await farm();
    const t = await talk(w);
    const card = await t.ready('weight', { tag: '1234', weightKg: 46 }, WEIGHED);
    expect(await w.f.run(() => listPending(), { userId: w.owner.userId })).toEqual([]);
    expect((await w.owner.get('/ai/proposals')).data).toEqual([]);
    expect((await w.owner.get(`/ai/proposals/${card.id}`)).status).toBe(404);
    expect((await w.owner.post(`/ai/proposals/${card.id}/confirm`, { stamp: card.stamp })).status).toBe(404);
    expect((await w.owner.get('/ai/farm-proposals')).data).toMatchObject([{ id: card.id }]);
  });
});

describe('weight: through the assistant', () => {
  it('the model drafts, a card comes back, and nothing is written', async () => {
    const w = await farm();
    setProvider(new Scripted([call('draft_weight', { tag: '1234', weightKg: 46 }), say('Tasdiqlang.')]));
    const res = await w.owner.post('/ai/chat', { message: WEIGHED });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const card = res.data.message.attachments.find((a: any) => a.type === 'farm_proposal');
    expect(card.proposal).toMatchObject({ kind: 'weight', status: 'pending', channel: 'web', fields: { weightKg: 46, animal: { tag: '1234' } } });
    expect(res.data.message.toolCalls[0]).toMatchObject({ name: 'draft_weight', status: 'ok' });
    expect(await weightsOf(w, '1234')).toEqual([]);
    expect((await confirm(w.owner, card.proposal)).status).toBe(200);
    expect(await weightsOf(w, '1234')).toMatchObject([{ weightKg: 46 }]);
  });

  it('a model inventing a weight gets a question for the person, and the answer completes the card', async () => {
    const w = await farm();
    const provider = new Scripted([call('draft_weight', { tag: '1234', weightKg: 46 }), say('Necha kilo chiqdi?')]);
    setProvider(provider);
    const first = await w.owner.post('/ai/chat', { message: "1234-qo'yni tortdim" });
    expect(first.data.message.attachments.filter((a: any) => a.type === 'farm_proposal')).toEqual([]);
    expect(first.data.message.attachments.find((a: any) => a.type === 'question').question.code).toBe('WEIGHT_REQUIRED');
    expect((provider.requests[1].messages.at(-1)!.content[0] as { content: string }).content).toContain('WEIGHT_REQUIRED');

    setProvider(new Scripted([call('draft_weight', { tag: '1234', weightKg: 46 }), say('Tasdiqlang.')]));
    const second = await w.owner.post('/ai/chat', { conversationId: first.data.conversationId, message: '46 kilo' });
    const card = second.data.message.attachments.find((a: any) => a.type === 'farm_proposal');
    expect(card.proposal.fields).toMatchObject({ weightKg: 46, animal: { tag: '1234' } });
  });

  it('two animals in one message come back as two cards', async () => {
    const w = await farm();
    setProvider(
      new Scripted([
        {
          ...call('draft_weight', { tag: '1234', weightKg: 46 }),
          content: [
            { type: 'tool_use', id: 'c-1', name: 'draft_weight', input: { tag: '1234', weightKg: 46 } },
            { type: 'tool_use', id: 'c-2', name: 'draft_weight', input: { tag: '1235', weightKg: 48 } },
          ],
        },
        say('Ikkalasini tasdiqlang.'),
      ]),
    );
    const res = await w.owner.post('/ai/chat', { message: "1234-qo'y 46 kilo, 1235-qo'y 48 kilo chiqdi" });
    const cards = res.data.message.attachments.filter((a: any) => a.type === 'farm_proposal').map((a: any) => a.proposal.fields);
    expect(cards.map((f: any) => [f.animal.tag, f.weightKg])).toEqual([['1234', 46], ['1235', 48]]);
  });

  it('offers the tool only to those who may record a weight, with livestock switched on', async () => {
    const tools = async (w: Farm, client: Client) => {
      const provider = new Scripted([say('...')]);
      setProvider(provider);
      await client.post('/ai/chat', { message: 'Salom' });
      return offered(provider);
    };
    const w = await farm();
    expect(await tools(w, w.owner)).toEqual(expect.arrayContaining(['draft_weight', 'cancel_farm_draft']));

    // A shepherd records deaths and feeding, not weights: the weighing screen asks for livestock.update.
    await grant(w.f, 'shepherd');
    expect(await tools(w, await w.f.as('shepherd'))).not.toContain('draft_weight');
    await grant(w.f, 'zootechnician');
    expect(await tools(w, await w.f.as('zootechnician'))).toContain('draft_weight');

    const off = await farm({ modules: ['dashboard', 'finance', 'ai'] });
    const names = await tools(off, off.owner);
    for (const kind of FARM_RECORD_KINDS) expect(names).not.toContain(`draft_${kind}`);
    expect(names).not.toContain('cancel_farm_draft');
  });

  it('a draft made without the right is refused by the service itself', async () => {
    const w = await farm();
    const shepherd = await w.f.as('shepherd');
    const drafting = w.f.run(
      () => saveFarmDraft('weight', { tag: '1234', weightKg: 46 }, { userTexts: [WEIGHED], documentAmounts: [], channel: 'web', conversationId: null }),
      { userId: shepherd.userId, permissions: [...DEFAULT_ROLE_PERMISSIONS.shepherd, 'ai.view'] },
    );
    await expect(drafting).rejects.toMatchObject({ status: 403 });
  });
});

// ─── Death ──────────────────────────────────────────────────────────────────

const DIED = "bugun 0567 raqamli qo'y o'ldi, ichi ketgan";

describe('death: what the card rests on', () => {
  let w: Farm;
  beforeAll(async () => {
    w = await farm();
  });

  it('names the animal plainly: tag, sex, age and herd, with the cause in their own words', async () => {
    const t = await talk(w);
    const card = await t.ready('death', { tag: '0567', cause: 'ichi ketgan' }, DIED);
    expect(card).toMatchObject({ kind: 'death', status: 'pending', canConfirm: true });
    expect(card.fields).toMatchObject({
      date: today,
      cause: 'ichi ketgan',
      weightKg: null,
      stockOut: [],
      animal: { id: w.animal['0567'], tag: '0567', sex: 'female', category: 'ewe', ageMonths: 14, herd: { name: '1-otar' } },
    });
    expect(await exitsOf(w, '0567')).toEqual([]);
  });

  it.each([
    ['Uzbek Latin', DIED, 'ichi ketgan'],
    ['Uzbek Cyrillic', latinToCyrillic(DIED), latinToCyrillic('ichi ketgan')],
    ['Russian', 'Сегодня овца номер 0567 пала, понос', 'понос'],
    ['English', 'Sheep number 0567 died today, scours', 'scours'],
  ])('reads it in %s', async (_, text, cause) => {
    const t = await talk(w);
    expect((await t.ready('death', { tag: '0567', cause }, text)).fields).toMatchObject({ cause, animal: { tag: '0567' }, date: today });
  });

  it('a cause the person never said does not reach the card', async () => {
    const t = await talk(w);
    const card = await t.ready('death', { tag: '0567', cause: 'pnevmoniya' }, "0567 raqamli qo'y o'ldi");
    expect(card.fields.cause).toBeNull();
  });

  it.each([
    ['a sick animal', "0567 raqamli qo'y kasal, yotibdi"],
    ['a death that is denied', 'Овца номер 0567 не сдохла'],
  ])('%s is not a death: it asks what happened', async (_, text) => {
    const t = await talk(w);
    expect(await t.asked('death', { tag: '0567' }, text)).toEqual(['DEATH_NOT_STATED']);
  });

  it('the tag has to be in the words, and a head count is not a tag', async () => {
    const t = await talk(w);
    expect(await t.asked('death', { tag: '0567' }, "bitta qo'y o'ldi")).toEqual(['ANIMAL_NOT_STATED']);
    expect(await t.asked('death', {}, "bitta qo'y o'ldi")).toEqual(['ANIMAL_REQUIRED']);
    // "46 ta" is a count outright; "46 qo'y" may be either, so it asks for the number said as a tag.
    expect(await t.asked('death', { tag: '46' }, "46 ta qo'y o'ldi")).toEqual(['ANIMAL_NOT_STATED']);
    expect(await t.asked('death', { tag: '46' }, "46 qo'y o'ldi")).toEqual(['ANIMAL_COUNT_OR_TAG']);
    expect((await t.ready('death', { tag: '46' }, "46 raqamli qo'y o'ldi")).fields.animal).toMatchObject({ tag: '46' });
    expect(await t.asked('death', { tag: '9999' }, "9999 raqamli qo'y o'ldi")).toEqual(['ANIMAL_UNKNOWN']);
    expect(await t.asked('death', { tag: '0777' }, "0777 raqamli qo'y o'ldi")).toEqual(['ANIMAL_AMBIGUOUS']);
  });

  it('two animals in one sentence are two cards, never one', async () => {
    const t = await talk(w);
    const text = "1234 va 1235 raqamli qo'ylar o'ldi";
    const first = await t.ready('death', { tag: '1234' }, text);
    const second = await t.ready('death', { tag: '1235' }, text);
    expect(second.id).not.toBe(first.id);
    expect([first.fields.animal!.tag, second.fields.animal!.tag]).toEqual(['1234', '1235']);
  });

  it.each([
    ['Uzbek Latin', "kecha 0567 raqamli qo'y o'ldi"],
    ['Uzbek Cyrillic', latinToCyrillic("kecha 0567 raqamli qo'y o'ldi")],
    ['Russian', 'Вчера овца номер 0567 пала'],
    ['English', 'Sheep number 0567 died yesterday'],
  ])('"yesterday" in %s is the day before, and the model cannot move it', async (_, text) => {
    const t = await talk(w);
    expect((await t.ready('death', { tag: '0567' }, text)).fields.date).toBe(daysAgo(1));
    const other = await talk(w);
    expect(await other.asked('death', { tag: '0567', date: daysAgo(3) }, text)).toEqual(['DATE_UNCLEAR']);
  });

  it('saying it again about the same animal corrects the card', async () => {
    const t = await talk(w);
    const card = await t.ready('death', { tag: '0567' }, "0567 raqamli qo'y o'ldi");
    const again = await t.ready('death', { tag: '0567', cause: 'ichi ketgan' }, ["0567 raqamli qo'y o'ldi", 'ichi ketgan edi']);
    expect(again.id).toBe(card.id);
    expect(again.fields.cause).toBe('ichi ketgan');
    expect(again.stamp).not.toBe(card.stamp);
  });
});

describe('death: confirm writes through the exits service', () => {
  it('takes the animal out of the flock as the person, and undo puts it back', async () => {
    const w = await farm();
    // What the animal cost stays in the books: the card and its answer carry no money.
    await w.f.run(() => tx().update(animals).set({ purchasePrice: 1_515_000 }).where(eq(animals.id, w.animal['0567'])));
    const t = await talk(w);
    const card = await t.ready('death', { tag: '0567', cause: 'ichi ketgan' }, "kecha 0567 raqamli qo'y o'ldi, ichi ketgan");

    const done = await confirm(w.owner, card);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.data).toMatchObject({ status: 'confirmed', canUndo: true, result: { type: 'animal_exit' } });
    expect(JSON.stringify(done.data)).not.toMatch(/1515000|lossAmount|purchasePrice/);

    const [exit] = await exitsOf(w, '0567');
    expect(exit).toMatchObject({ id: done.data.result.id, type: 'death', date: daysAgo(1), reason: 'ichi ketgan', createdBy: w.owner.userId, lossAmount: 1_515_000 });
    expect(await animalOf(w, '0567')).toMatchObject({ status: 'dead', exitDate: daysAgo(1) });
    expect(await eventsOf(w, 'animal.died')).toMatchObject([{ entityId: w.animal['0567'], createdBy: w.owner.userId, data: { exitId: exit.id, reason: 'ichi ketgan' } }]);
    expect(await eventsOf(w, 'ai_proposal.confirmed')).toMatchObject([{ entityId: card.id, data: { kind: 'death', resultType: 'animal_exit', resultId: exit.id } }]);

    expect((await confirm(w.owner, card)).body.error.code).toBe('PROPOSAL_NOT_PENDING');
    expect(await exitsOf(w, '0567')).toHaveLength(1);

    const back = await undo(w.owner, card);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.data).toMatchObject({ status: 'undone', canUndo: false });
    expect(await exitsOf(w, '0567')).toEqual([]);
    expect(await animalOf(w, '0567')).toMatchObject({ status: 'active', exitDate: null });
    expect(await eventsOf(w, 'animal.exit_undone')).toMatchObject([{ entityId: w.animal['0567'] }]);
  });

  it('a shepherd confirms a death as on the death screen, and is offered no undo', async () => {
    const w = await farm();
    await grant(w.f, 'shepherd');
    const shepherd = await w.f.as('shepherd');
    const t = await talk(w, shepherd);
    const card = await t.ready('death', { tag: '0567' }, DIED);

    const done = await confirm(shepherd, card);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // Taking an exit back is `livestock.delete` on its own page, which a shepherd does not hold.
    expect(done.data).toMatchObject({ status: 'confirmed', canUndo: false, undoUntil: null });
    expect(await exitsOf(w, '0567')).toMatchObject([{ type: 'death', createdBy: shepherd.userId }]);
    expect((await undo(shepherd, card)).status).toBe(409);
    expect(await exitsOf(w, '0567')).toHaveLength(1);
    expect((await shepherd.delete(`/livestock/exits/${done.data.result.id}`)).status).toBe(403);
  });

  it('the right to report a death is checked at confirm, as on the death screen', async () => {
    const w = await farm();
    await grant(w.f, 'shepherd');
    const shepherd = await w.f.as('shepherd');
    const t = await talk(w, shepherd);
    const card = await t.ready('death', { tag: '0567' }, DIED);

    await setPermissions(w.f, 'shepherd', ['ai.view', 'livestock.view']);
    const refused = await confirm(shepherd, card);
    expect(refused.status).toBe(403);
    expect(await exitsOf(w, '0567')).toEqual([]);
    expect(await animalOf(w, '0567')).toMatchObject({ status: 'active' });
    expect((await shepherd.post('/livestock/exits', { animalId: w.animal['0567'], type: 'death' })).status).toBe(403);
    expect((await shepherd.get(`/ai/farm-proposals/${card.id}`)).data).toMatchObject({ status: 'pending', canConfirm: false });
  });

  it('refuses a death already in the books, when drafting and again at confirm', async () => {
    const w = await farm();
    const t = await talk(w);
    const card = await t.ready('death', { tag: '0567' }, DIED);
    // Entered on the death screen in the meantime.
    await w.f.run(() => createExit({ animalId: w.animal['0567'], type: 'death', date: today }), { userId: w.owner.userId });

    const refused = await confirm(w.owner, card);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('FARM_RECORD_EXISTS');
    expect(await exitsOf(w, '0567')).toHaveLength(1);
    expect(await eventsOf(w, 'animal.died')).toHaveLength(1);

    const other = await talk(w);
    expect(await other.asked('death', { tag: '0567' }, DIED)).toEqual(['ALREADY_RECORDED']);
  });

  it('refuses when the animal left the farm another way since the card was made', async () => {
    const w = await farm();
    const t = await talk(w);
    const card = await t.ready('death', { tag: '0567' }, DIED);
    await w.f.run(() => tx().update(animals).set({ status: 'sold' }).where(eq(animals.id, w.animal['0567'])));

    const refused = await confirm(w.owner, card);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PROPOSAL_STALE');
    expect(await exitsOf(w, '0567')).toEqual([]);
  });

  it('two cards about one animal in two conversations write one death', async () => {
    const w = await farm();
    const first = await (await talk(w)).ready('death', { tag: '0567' }, DIED);
    const second = await (await talk(w)).ready('death', { tag: '0567' }, DIED);
    const results = await Promise.all([confirm(w.owner, first), confirm(w.owner, second)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('FARM_RECORD_EXISTS');
    expect(await exitsOf(w, '0567')).toHaveLength(1);
  });

  it('a card belongs to the person it was made for, and to their farm', async () => {
    const w = await farm();
    await grant(w.f, 'director');
    const t = await talk(w);
    const card = await t.ready('death', { tag: '0567' }, DIED);

    expect((await confirm(await w.f.as('director'), card)).status).toBe(403);
    const elsewhere = await farm();
    expect((await confirm(elsewhere.owner, card)).status).toBe(404);
    expect(await exitsOf(w, '0567')).toEqual([]);
    expect(await exitsOf(elsewhere, '0567')).toEqual([]);
    expect(await animalOf(elsewhere, '0567')).toMatchObject({ status: 'active' });
  });
});

describe('death: through the assistant', () => {
  it('the model drafts, a card comes back, and the animal stays in the flock until it is confirmed', async () => {
    const w = await farm();
    setProvider(new Scripted([call('draft_death', { tag: '0567', cause: 'ichi ketgan' }), say('Tasdiqlang.')]));
    const res = await w.owner.post('/ai/chat', { message: DIED });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const card = res.data.message.attachments.find((a: any) => a.type === 'farm_proposal');
    expect(card.proposal).toMatchObject({ kind: 'death', status: 'pending', fields: { cause: 'ichi ketgan', animal: { tag: '0567' } } });
    expect(await animalOf(w, '0567')).toMatchObject({ status: 'active' });
    expect((await confirm(w.owner, card.proposal)).status).toBe(200);
    expect(await animalOf(w, '0567')).toMatchObject({ status: 'dead' });
  });

  it('a model calling a sick animal dead gets a question for the person', async () => {
    const w = await farm();
    setProvider(new Scripted([call('draft_death', { tag: '0567' }), say('Unga nima bo\'ldi?')]));
    const res = await w.owner.post('/ai/chat', { message: "0567 raqamli qo'y kasal" });
    expect(res.data.message.attachments.filter((a: any) => a.type === 'farm_proposal')).toEqual([]);
    expect(res.data.message.attachments.find((a: any) => a.type === 'question').question.code).toBe('DEATH_NOT_STATED');
    expect(await exitsOf(w, '0567')).toEqual([]);
  });

  it('offers the tool to whoever may report a death on the death screen', async () => {
    const tools = async (client: Client) => {
      const provider = new Scripted([say('...')]);
      setProvider(provider);
      await client.post('/ai/chat', { message: 'Salom' });
      return offered(provider);
    };
    const w = await farm();
    await grant(w.f, 'shepherd');
    const shepherd = await w.f.as('shepherd');
    expect(await tools(shepherd)).toEqual(expect.arrayContaining(['draft_death', 'cancel_farm_draft']));
    await setPermissions(w.f, 'shepherd', ['ai.view', 'livestock.view']);
    expect(await tools(shepherd)).not.toContain('draft_death');
  });
});


// ─── Treatment ──────────────────────────────────────────────────────────────

const TREATED = '0567 ga 5 ml ivermektin qildim';

describe('treatment: what the card rests on', () => {
  let w: Farm;
  beforeAll(async () => {
    w = await farm();
  });

  it('shows the animal, the drug, the dose, and what leaves which warehouse', async () => {
    const t = await talk(w);
    const card = await t.ready('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' }, TREATED);
    expect(card).toMatchObject({ kind: 'treatment', status: 'pending', sourceText: TREATED, warnings: [] });
    expect(card.fields).toMatchObject({
      date: today,
      healthType: 'treatment',
      animal: { tag: '0567', sex: 'female', category: 'ewe', herd: { name: '1-otar' } },
      drug: { itemId: w.item.Ivermektin, name: 'Ivermektin' },
      dose: 5,
      doseUnit: 'ml',
      // Kept in litres, and 5 ml is exactly 0.005 of one.
      stockOut: [{ itemId: w.item.Ivermektin, name: 'Ivermektin', unit: 'l', qty: 0.005, warehouse: { id: w.vetStoreId, name: 'Vet ombor' } }],
    });
    // The drug's price is the warehouse's business: the card holds no money for anyone.
    expect(JSON.stringify(card)).not.toMatch(/cost|price|40000/i);
    expect(await careOf(w, '0567')).toEqual([]);
    expect(await stockOf(w, 'Ivermektin')).toBe(2);
  });

  it.each([
    ['Uzbek Latin', TREATED],
    ['Uzbek Cyrillic', latinToCyrillic(TREATED)],
    ['Russian', 'Овце № 567 сделал 5 мл ивермектин'],
    ['English', 'Gave 5 ml of Ivermektin to ewe number 567'],
  ])('reads it in %s', async (_, text) => {
    const t = await talk(w);
    const card = await t.ready('treatment', { tag: '567', drug: 'ivermektin', qty: 5, unit: 'ml' }, text);
    expect(card.fields).toMatchObject({ animal: { tag: '0567' }, drug: { itemId: w.item.Ivermektin }, dose: 5, doseUnit: 'ml', stockOut: [{ qty: 0.005, unit: 'l' }] });
  });

  it('tells a vaccination and a deworming from a treatment by their words', async () => {
    const t = await talk(w);
    expect((await t.ready('treatment', { tag: '0567', drug: 'gijja dori', qty: 1, unit: 'doza' }, '0567 ga 1 doza gijja dori berdim')).fields.healthType).toBe('deworming');
    expect((await t.ready('treatment', { tag: '1234', drug: 'vitamin', qty: 1, unit: 'flakon' }, 'Овце № 1234 сделали прививку, 1 флакон Vitamin из Vet ombor')).fields.healthType).toBe('vaccination');
  });

  it('the dose and the drug come from the words, whatever the model claims', async () => {
    const t = await talk(w);
    expect((await t.ready('treatment', { tag: '0567', drug: 'ivermektin', qty: 50, unit: 'ml' }, TREATED)).fields).toMatchObject({ dose: 5, stockOut: [{ qty: 0.005 }] });
    const other = await talk(w);
    expect(await other.asked('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' }, '0567 ga ivermektin qildim')).toEqual(['DOSE_REQUIRED']);
    // A bare number is not a dose, and a drug they never named is not theirs.
    expect(await other.asked('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' }, '0567 ga 5 ivermektin qildim')).toEqual(['DOSE_REQUIRED']);
    const third = await talk(w);
    expect(await third.asked('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' }, '0567 ga 5 ml ukol qildim')).toEqual(['DRUG_REQUIRED']);
    expect(await third.asked('treatment', { tag: '0567', qty: 5, unit: 'ml' }, '0567 ga 5 ml qildim')).toEqual(['DRUG_REQUIRED']);
  });

  it('the animal or the herd has to be in the words', async () => {
    const t = await talk(w);
    expect(await t.asked('treatment', { drug: 'ivermektin', qty: 5, unit: 'ml' }, "qo'yga 5 ml ivermektin qildim")).toEqual(['CARE_TARGET_REQUIRED']);
    expect(await t.asked('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' }, "qo'yga 5 ml ivermektin qildim")).toEqual(['ANIMAL_NOT_STATED']);
    expect(await t.asked('treatment', { tag: '9999', drug: 'ivermektin', qty: 5, unit: 'ml' }, '9999 ga 5 ml ivermektin qildim')).toEqual(['ANIMAL_UNKNOWN']);
    expect(await t.asked('treatment', { tag: '777', drug: 'ivermektin', qty: 5, unit: 'ml' }, '777 ga 5 ml ivermektin qildim')).toEqual(['ANIMAL_AMBIGUOUS']);
    // "5 ml" is never the animal, and a head count is not a tag.
    expect(await t.asked('treatment', { tag: '5', drug: 'ivermektin', qty: 5, unit: 'ml' }, "qo'yga 5 ml ivermektin qildim")).toEqual(['ANIMAL_NOT_STATED']);
    expect(await t.asked('treatment', { tag: '46', drug: 'ivermektin', qty: 5, unit: 'ml' }, "46 ta qo'yga 5 ml ivermektin qildim")).toEqual(['ANIMAL_NOT_STATED']);
  });

  it('millilitres are never turned into vials: it asks, and the answer leaves the warehouse', async () => {
    const t = await talk(w);
    const said = '0567 ga 5 ml oksitetratsiklin qildim';
    expect(await t.asked('treatment', { tag: '0567', drug: 'oksitetratsiklin', qty: 5, unit: 'ml' }, said)).toEqual(['DOSE_UNIT_MISMATCH']);
    // A model that works the vials out itself gets the same question.
    expect(await t.asked('treatment', { tag: '0567', drug: 'oksitetratsiklin', qty: 1, unit: 'flakon' }, said)).toEqual(['DOSE_UNIT_MISMATCH']);
    const card = await t.ready('treatment', { tag: '0567', drug: 'oksitetratsiklin', qty: 1, unit: 'flakon' }, [said, '1 flakon ketdi']);
    expect(card.fields).toMatchObject({ dose: 5, doseUnit: 'ml', stockOut: [{ name: 'Oksitetratsiklin', unit: 'vial', qty: 1, warehouse: { name: 'Vet ombor' } }] });
  });

  it('what the warehouse cannot count is asked for, not rounded', async () => {
    const t = await talk(w);
    // Half a millilitre is 0.0005 l: the warehouse counts to three decimals.
    expect(await t.asked('treatment', { tag: '0567', drug: 'ivermektin', qty: 0.5, unit: 'ml' }, '0567 ga 0.5 ml ivermektin qildim')).toEqual(['DOSE_UNIT_MISMATCH']);
  });

  it('a weight said beside it is not the dose', async () => {
    const t = await talk(w);
    const card = await t.ready('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' }, '0567 46 kilo chiqdi, 5 ml ivermektin qildim');
    expect(card.fields).toMatchObject({ dose: 5, doseUnit: 'ml', weightKg: null, stockOut: [{ qty: 0.005 }] });
  });

  it('a drug with no usual warehouse asks which one, and takes it when named', async () => {
    const t = await talk(w);
    expect(await t.asked('treatment', { tag: '0567', drug: 'vitamin', qty: 1, unit: 'flakon' }, '0567 ga 1 flakon vitamin qildim')).toEqual(['WAREHOUSE_REQUIRED']);
    const card = await t.ready('treatment', { tag: '0567', drug: 'vitamin', qty: 1, unit: 'flakon', warehouse: 'vet ombor' }, ['0567 ga 1 flakon vitamin qildim', 'vet ombordan']);
    expect(card.fields.stockOut).toMatchObject([{ name: 'Vitamin', qty: 1, warehouse: { id: w.vetStoreId } }]);
  });

  it('a drug the warehouse does not keep stays as they named it, and nothing leaves the warehouse', async () => {
    const t = await talk(w);
    const card = await t.ready('treatment', { tag: '0567', drug: 'biovit', qty: 5, unit: 'ml' }, '0567 ga 5 ml biovit qildim');
    expect(card.fields).toMatchObject({ drug: { itemId: null, name: 'biovit' }, dose: 5, doseUnit: 'ml', stockOut: [] });
    expect(card.warnings.map((warning) => warning.code)).toEqual(['DRUG_NOT_STOCKED']);
    // The model's own name for it is not theirs.
    const other = await talk(w);
    expect(await other.asked('treatment', { tag: '0567', drug: 'Tetravit', qty: 5, unit: 'ml' }, '0567 ga 5 ml biovit qildim')).toEqual(['DRUG_REQUIRED']);
  });

  it('two animals in one sentence are two cards, each with its own dose', async () => {
    const t = await talk(w);
    const text = '0567 ga 5 ml, 1234 ga 3 ml ivermektin qildim';
    const first = await t.ready('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' }, text);
    const second = await t.ready('treatment', { tag: '1234', drug: 'ivermektin', qty: 3, unit: 'ml' }, text);
    expect(second.id).not.toBe(first.id);
    expect([first.fields.dose, second.fields.dose]).toEqual([5, 3]);
    expect([first.fields.animal!.tag, second.fields.animal!.tag]).toEqual(['0567', '1234']);
  });

  it('a dose said once backs one card: the second animal is asked about', async () => {
    const t = await talk(w);
    const text = '0567 ga 5 ml ivermektin qildim, 1234 ga ham';
    await t.ready('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' }, text);
    expect(await t.asked('treatment', { tag: '1234', drug: 'ivermektin', qty: 5, unit: 'ml' }, text)).toEqual(['DOSE_REQUIRED']);
  });

  it.each([
    ['kecha 0567 ga 5 ml ivermektin qildim'],
    [latinToCyrillic('kecha 0567 ga 5 ml ivermektin qildim')],
    ['Вчера овце № 567 сделал 5 мл ивермектин'],
    ['Yesterday I gave 5 ml of Ivermektin to number 567'],
  ])('yesterday is read from the words: %s', async (text) => {
    const t = await talk(w);
    expect((await t.ready('treatment', { tag: '567', drug: 'ivermektin', qty: 5, unit: 'ml', date: daysAgo(1) }, text)).fields.date).toBe(daysAgo(1));
    const other = await talk(w);
    expect(await other.asked('treatment', { tag: '567', drug: 'ivermektin', qty: 5, unit: 'ml', date: daysAgo(3) }, text)).toEqual(['DATE_UNCLEAR']);
  });

  it('a whole herd: the herd is named in the words, and the total leaves the warehouse', async () => {
    const t = await talk(w);
    const text = '1-otarga gijja dori berdik, 300 doza ketdi';
    const card = await t.ready('treatment', { herd: '1-otar', drug: 'gijja dori', qty: 300, unit: 'doza' }, text);
    expect(card.fields).toMatchObject({
      animal: null,
      herd: { id: w.herdId, name: '1-otar', defaulted: false },
      healthType: 'deworming',
      dose: null,
      stockOut: [{ name: 'Gijja dori', unit: 'dose', qty: 300 }],
    });
    // A herd the model names and the person did not is a question, even on a farm with one herd.
    const other = await talk(w);
    expect(await other.asked('treatment', { herd: '1-otar', drug: 'gijja dori', qty: 300, unit: 'doza' }, 'gijja dori berdik, 300 doza ketdi')).toEqual(['HERD_REQUIRED']);
  });

  it('saying it again about the same animal and drug corrects the card', async () => {
    const t = await talk(w);
    const first = await t.ready('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' }, TREATED);
    const again = await t.draft('treatment', { tag: '0567', drug: 'ivermektin', qty: 6, unit: 'ml' }, [TREATED, "yo'q, 0567 ga 6 ml ivermektin qildim"]);
    expect(again).toMatchObject({ status: 'ready', replaced: true, proposal: { id: first.id, fields: { dose: 6, stockOut: [{ qty: 0.006 }] } } });
  });
});

describe('treatment: confirm writes through the health service', () => {
  it('takes the drug from the warehouse as the person, and undo returns it', async () => {
    const w = await farm();
    await grant(w.f, 'veterinarian');
    const vet = await w.f.as('veterinarian');
    const t = await talk(w, vet);
    const card = await t.ready('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml', cause: "yo'talayotgan edi" }, "kecha 0567 ga 5 ml ivermektin qildim, yo'talayotgan edi");

    const done = await confirm(vet, card);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.data).toMatchObject({ status: 'confirmed', canUndo: true, result: { type: 'health_record' } });
    // A vet does not see money, and the card carries none for anyone.
    expect(JSON.stringify(done.data)).not.toMatch(/cost|price|40000/i);

    const [record] = await careOf(w, '0567');
    expect(record).toMatchObject({
      id: done.data.result.id,
      type: 'treatment',
      date: daysAgo(1),
      diagnosis: "yo'talayotgan edi",
      itemId: w.item.Ivermektin,
      warehouseId: w.vetStoreId,
      qtyUsed: 0.005,
      dose: 5,
      doseUnit: 'ml',
      headCount: 1,
      // 0.005 l at 40 000 a litre: in the books, not on the card.
      totalCost: 200,
      withdrawalDays: 14,
      createdBy: vet.userId,
    });
    expect(await stockOf(w, 'Ivermektin')).toBe(1.995);
    expect(await movementsOf(w, 'health_record', record.id)).toMatchObject([{ type: 'issue', itemId: w.item.Ivermektin, warehouseId: w.vetStoreId, qty: 0.005, createdBy: vet.userId }]);
    expect(await eventsOf(w, 'animal.treated')).toMatchObject([{ entityId: w.animal['0567'], createdBy: vet.userId, data: { healthRecordId: record.id, itemId: w.item.Ivermektin, qty: 0.005 } }]);
    expect(await eventsOf(w, 'ai_proposal.confirmed')).toMatchObject([{ entityId: card.id, data: { kind: 'treatment', resultType: 'health_record', resultId: record.id } }]);

    expect((await confirm(vet, card)).body.error.code).toBe('PROPOSAL_NOT_PENDING');
    expect(await careOf(w, '0567')).toHaveLength(1);

    const back = await undo(vet, card);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.data).toMatchObject({ status: 'undone', canUndo: false });
    expect(await careOf(w, '0567')).toEqual([]);
    expect(await stockOf(w, 'Ivermektin')).toBe(2);
    expect(await eventsOf(w, 'health_record.deleted')).toMatchObject([{ entityId: w.animal['0567'], createdBy: vet.userId }]);
  });

  it('a whole herd is written against the herd, and a drug not in the warehouse moves no stock', async () => {
    const w = await farm();
    const t = await talk(w);
    const herd = await t.ready('treatment', { herd: '1-otar', drug: 'gijja dori', qty: 300, unit: 'doza' }, '1-otarga gijja dori berdik, 300 doza ketdi');
    expect((await confirm(w.owner, herd)).status).toBe(200);
    const [record] = await w.f.run(() => tx().select().from(healthRecords).where(eq(healthRecords.herdId, w.herdId)));
    expect(record).toMatchObject({ type: 'deworming', animalId: null, itemId: w.item['Gijja dori'], qtyUsed: 300, headCount: TAGS.length });
    expect(await stockOf(w, 'Gijja dori')).toBe(200);
    expect(await eventsOf(w, 'animal.dewormed')).toMatchObject([{ entityType: 'herd', entityId: w.herdId }]);

    const named = await t.ready('treatment', { tag: '0567', drug: 'biovit', qty: 5, unit: 'ml' }, '0567 ga 5 ml biovit qildim');
    const done = await confirm(w.owner, named);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await careOf(w, '0567')).toMatchObject([{ type: 'treatment', itemId: null, warehouseId: null, qtyUsed: null, dose: 5, doseUnit: 'ml', notes: 'biovit', totalCost: 0 }]);
    expect(await movementsOf(w, 'health_record', done.data.result.id)).toEqual([]);
  });

  it('a zootechnician confirms as on the vet journal, and is offered no undo', async () => {
    const w = await farm();
    await grant(w.f, 'zootechnician');
    const zoo = await w.f.as('zootechnician');
    const t = await talk(w, zoo);
    const card = await t.ready('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' }, TREATED);

    const done = await confirm(zoo, card);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // Deleting a vet record is `health.delete` on its own page, which this role does not hold.
    expect(done.data).toMatchObject({ status: 'confirmed', canUndo: false, undoUntil: null });
    expect((await undo(zoo, card)).status).toBe(409);
    expect((await zoo.delete(`/livestock/health/records/${done.data.result.id}`)).status).toBe(403);
    expect(await careOf(w, '0567')).toHaveLength(1);
    expect(await stockOf(w, 'Ivermektin')).toBe(1.995);
  });

  it('a shepherd may report a sick animal, not record a treatment: drafting and confirming are refused as on the vet journal', async () => {
    const w = await farm();
    await grant(w.f, 'shepherd');
    const shepherd = await w.f.as('shepherd');
    const t = await talk(w, shepherd);
    const input = { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' };
    const asShepherd = { userId: shepherd.userId, permissions: [...DEFAULT_ROLE_PERMISSIONS.shepherd, 'ai.view'] as Permission[] };
    const env: DraftEnv = { userTexts: [TREATED], documentAmounts: [], channel: 'web', conversationId: t.conversationId };
    await expect(w.f.run(() => saveFarmDraft('treatment', input, env), asShepherd)).rejects.toMatchObject({ status: 403 });

    // A card made while they held the right is checked again at confirm.
    const card = await t.ready('treatment', input, TREATED);
    const refused = await confirm(shepherd, card);
    expect(refused.status).toBe(403);
    expect((await shepherd.post('/livestock/health/records', { type: 'treatment', animalId: w.animal['0567'], date: today })).status).toBe(403);
    expect(await careOf(w, '0567')).toEqual([]);
    expect(await stockOf(w, 'Ivermektin')).toBe(2);
    expect((await shepherd.get(`/ai/farm-proposals/${card.id}`)).data).toMatchObject({ status: 'pending', canConfirm: false });
  });

  it('refuses a treatment already in the books, when drafting and again at confirm', async () => {
    const w = await farm();
    const t = await talk(w);
    const card = await t.ready('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' }, TREATED);
    // Entered in the vet journal in the meantime.
    await w.f.run(() => createHealthRecord({ type: 'treatment', animalId: w.animal['0567'], date: today, itemId: w.item.Ivermektin, qtyUsed: 0.005 }), { userId: w.owner.userId });

    const refused = await confirm(w.owner, card);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('FARM_RECORD_EXISTS');
    expect(await careOf(w, '0567')).toHaveLength(1);
    expect(await stockOf(w, 'Ivermektin')).toBe(1.995);

    const other = await talk(w);
    expect(await other.asked('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' }, TREATED)).toEqual(['ALREADY_RECORDED']);
    // Another drug the same day is another record.
    expect((await other.ready('treatment', { tag: '0567', drug: 'gijja dori', qty: 1, unit: 'doza' }, '0567 ga 1 doza gijja dori berdim')).fields.healthType).toBe('deworming');
  });

  it('two cards about one treatment in two conversations take the drug once', async () => {
    const w = await farm();
    const first = await (await talk(w)).ready('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' }, TREATED);
    const second = await (await talk(w)).ready('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' }, TREATED);
    const results = await Promise.all([confirm(w.owner, first), confirm(w.owner, second)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('FARM_RECORD_EXISTS');
    expect(await careOf(w, '0567')).toHaveLength(1);
    expect(await stockOf(w, 'Ivermektin')).toBe(1.995);
  });

  it('more than the warehouse holds is refused by the warehouse, and nothing is written', async () => {
    const w = await farm();
    const t = await talk(w);
    const card = await t.ready('treatment', { herd: '1-otar', drug: 'gijja dori', qty: 600, unit: 'doza' }, '1-otarga gijja dori berdik, 600 doza ketdi');
    const refused = await confirm(w.owner, card);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await w.f.run(() => tx().select().from(healthRecords))).toEqual([]);
    expect(await stockOf(w, 'Gijja dori')).toBe(500);
    expect((await w.owner.get(`/ai/farm-proposals/${card.id}`)).data.status).toBe('pending');
  });

  it('refuses when the animal, the drug or the warehouse changed since the card was made', async () => {
    const w = await farm();
    const stale = async (change: () => Promise<unknown>, tag: string) => {
      const card = await (await talk(w)).ready('treatment', { tag, drug: 'ivermektin', qty: 5, unit: 'ml' }, `${tag} ga 5 ml ivermektin qildim`);
      await w.f.run(change);
      const refused = await confirm(w.owner, card);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('PROPOSAL_STALE');
    };
    await stale(() => tx().update(animals).set({ status: 'sold' }).where(eq(animals.id, w.animal['0567'])), '0567');
    await stale(() => tx().update(warehouses).set({ active: false }).where(eq(warehouses.id, w.vetStoreId)), '1234');
    await w.f.run(() => tx().update(warehouses).set({ active: true }).where(eq(warehouses.id, w.vetStoreId)));
    // The card's 0.005 was litres: the same number of vials is another thing.
    await stale(() => tx().update(items).set({ unit: 'vial' }).where(eq(items.id, w.item.Ivermektin)), '1235');
    expect(await w.f.run(() => tx().select().from(healthRecords))).toEqual([]);
    expect(await stockOf(w, 'Ivermektin')).toBe(2);
  });

  it('a card belongs to the person it was made for, and to their farm', async () => {
    const w = await farm();
    await grant(w.f, 'director');
    const card = await (await talk(w)).ready('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' }, TREATED);

    expect((await confirm(await w.f.as('director'), card)).status).toBe(403);
    const elsewhere = await farm();
    expect((await confirm(elsewhere.owner, card)).status).toBe(404);
    // The same words on another farm find that farm's animal and that farm's drug, never this one's.
    const theirs = await (await talk(elsewhere)).ready('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' }, TREATED);
    expect(theirs.fields).toMatchObject({ animal: { id: elsewhere.animal['0567'] }, drug: { itemId: elsewhere.item.Ivermektin } });
    expect(await careOf(w, '0567')).toEqual([]);
    expect(await stockOf(w, 'Ivermektin')).toBe(2);
    expect(await stockOf(elsewhere, 'Ivermektin')).toBe(2);
  });
});

describe('treatment: through the assistant', () => {
  it('the model drafts, a card comes back, and the drug stays in the warehouse until it is confirmed', async () => {
    const w = await farm();
    setProvider(new Scripted([call('draft_treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml' }), say('Tasdiqlang.')]));
    const res = await w.owner.post('/ai/chat', { message: TREATED });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const card = res.data.message.attachments.find((a: any) => a.type === 'farm_proposal');
    expect(card.proposal).toMatchObject({ kind: 'treatment', status: 'pending', fields: { dose: 5, drug: { name: 'Ivermektin' }, animal: { tag: '0567' } } });
    expect(await stockOf(w, 'Ivermektin')).toBe(2);
    expect((await confirm(w.owner, card.proposal)).status).toBe(200);
    expect(await stockOf(w, 'Ivermektin')).toBe(1.995);
  });

  it('a model that turns millilitres into vials gets a question for the person', async () => {
    const w = await farm();
    setProvider(new Scripted([call('draft_treatment', { tag: '0567', drug: 'oksitetratsiklin', qty: 1, unit: 'flakon' }), say('Necha flakon ketdi?')]));
    const res = await w.owner.post('/ai/chat', { message: '0567 ga 5 ml oksitetratsiklin qildim' });
    expect(res.data.message.attachments.filter((a: any) => a.type === 'farm_proposal')).toEqual([]);
    expect(res.data.message.attachments.find((a: any) => a.type === 'question').question.code).toBe('DOSE_UNIT_MISMATCH');
    expect(await stockOf(w, 'Oksitetratsiklin')).toBe(10);
  });

  it('offers the tool to whoever may write the vet journal, and to no one else', async () => {
    const tools = async (client: Client) => {
      const provider = new Scripted([say('...')]);
      setProvider(provider);
      await client.post('/ai/chat', { message: 'Salom' });
      return offered(provider);
    };
    const w = await farm();
    await grant(w.f, 'veterinarian');
    await grant(w.f, 'shepherd');
    expect(await tools(await w.f.as('veterinarian'))).toEqual(expect.arrayContaining(['draft_treatment', 'cancel_farm_draft']));
    // `health.create` stops at reporting a sick animal.
    expect(await tools(await w.f.as('shepherd'))).not.toContain('draft_treatment');
  });

  it('is not offered when the health module is switched off', async () => {
    const w = await farm({ modules: ['livestock', 'ai', 'inventory'] });
    const provider = new Scripted([say('...')]);
    setProvider(provider);
    await w.owner.post('/ai/chat', { message: 'Salom' });
    expect(offered(provider)).toContain('draft_weight');
    expect(offered(provider)).not.toContain('draft_treatment');
  });
});

// ─── Daily herd log ─────────────────────────────────────────────────────────

const FED = 'bugun 1-otarga 300 kilo beda berdim';
const beda = { herd: '1-otar', feeds: [{ feed: 'beda', qty: 300, unit: 'kilo' }] };
const lineOf = (card: FarmProposalView) => card.fields.stockOut.map((line) => [line.name, line.qty, line.unit]);
const logsOf = (w: Farm, herdId = w.herdId) => w.f.run(() => tx().select().from(dailyLogs).where(eq(dailyLogs.herdId, herdId)));
const fedLines = (w: Farm, logId: string) => w.f.run(() => tx().select().from(dailyLogLines).where(eq(dailyLogLines.logId, logId)));
const secondHerd = (w: Farm) =>
  w.f.run(async () => {
    const [herd] = await tx().insert(herds).values({ tenantId: w.f.tenantId, farmId: w.f.farmId, name: '2-otar' }).returning();
    await tx().update(herds).set({ costCenterId: await ensureCostCenter('herd', herd.id, herd.name) }).where(eq(herds.id, herd.id));
    return herd.id;
  });
/** The herd's ration: a kilogram of Beda and 200 g of Arpa a head. */
const giveRation = (w: Farm) =>
  w.f.run(async () => {
    const base = { tenantId: w.f.tenantId, farmId: w.f.farmId };
    const [ration] = await tx().insert(rations).values({ ...base, name: 'Qishki', state: 'maintenance' }).returning();
    await tx().insert(rationLines).values([
      { ...base, rationId: ration.id, itemId: w.item.Beda, kgPerHeadDay: 1 },
      { ...base, rationId: ration.id, itemId: w.item.Arpa, kgPerHeadDay: 0.2 },
    ]);
    await tx().update(herds).set({ rationId: ration.id }).where(eq(herds.id, w.herdId));
  });

describe('herd log: what the card rests on', () => {
  let w: Farm;
  beforeAll(async () => {
    w = await farm();
  });

  it('a herd, a feed and its amount in the words make a card that shows what leaves the warehouse', async () => {
    const t = await talk(w);
    const card = await t.ready('herd_log', beda, FED);
    expect(card).toMatchObject({ kind: 'herd_log', status: 'pending', needsAnswer: false, sourceText: FED });
    expect(card.fields).toMatchObject({
      date: today,
      animal: null,
      herd: { id: w.herdId, name: '1-otar', defaulted: false },
      // Which warehouse it leaves is the daily log's own rule, decided when it is written.
      stockOut: [{ itemId: w.item.Beda, name: 'Beda', unit: 'kg', qty: 300, warehouse: null }],
    });
    // Rule 7: a feeding card holds no money for anyone.
    expect(JSON.stringify(card)).not.toMatch(/cost|price|amount/i);
    expect(await logsOf(w)).toEqual([]);
    expect(await stockOf(w, 'Beda')).toBe(5000);
  });

  it.each([
    ['Uzbek Latin', FED],
    ['Uzbek Cyrillic', latinToCyrillic(FED)],
    ['Russian', 'Сегодня дали 300 кг беда стаду 1-отар'],
    ['English', 'Today we gave 300 kg of beda to herd 1-otar'],
  ])('reads it in %s', async (_, text) => {
    const t = await talk(w);
    const card = await t.ready('herd_log', beda, text);
    expect(card.fields.herd).toMatchObject({ name: '1-otar', defaulted: false });
    expect(lineOf(card)).toEqual([['Beda', 300, 'kg']]);
  });

  it('the feed and the amount come from the words, whatever the model claims', async () => {
    const t = await talk(w);
    expect(lineOf(await t.ready('herd_log', { herd: '1-otar', feeds: [{ feed: 'arpa', qty: 500, unit: 'kilo' }] }, FED))).toEqual([['Beda', 300, 'kg']]);
    const other = await talk(w);
    expect(await other.asked('herd_log', beda, '1-otarga beda berdim')).toEqual(['FEED_QTY_REQUIRED']);
    // A bare number is not an amount: it needs its unit.
    expect(await other.asked('herd_log', beda, '1-otarga beda berdim, jami 300')).toHaveLength(1);
    expect((await other.draft('herd_log', beda, '1-otarga 300 beda berdim')).status).toBe('needs_info');
    // "Yem" is every feed of this warehouse and none of them: which one is a question. A feed the model names is not in the words.
    expect(await other.asked('herd_log', { herd: '1-otar', feeds: [{ feed: 'yem', qty: 300, unit: 'kilo' }] }, '1-otarga 300 kilo yem berdim')).toEqual(['FEED_AMBIGUOUS']);
    expect(await other.asked('herd_log', beda, '1-otarga 300 kilo yem berdim')).toEqual(['FEED_REQUIRED']);
  });

  it('an amount said alone answers the question about the one feed', async () => {
    const t = await talk(w);
    expect(await t.asked('herd_log', beda, '1-otarga beda berdim')).toEqual(['FEED_QTY_REQUIRED']);
    expect(lineOf(await t.ready('herd_log', beda, ['1-otarga beda berdim', '300 kilo']))).toEqual([['Beda', 300, 'kg']]);
  });

  it('the amount is counted in the unit the warehouse keeps, and never worked out across kinds of unit', async () => {
    const t = async (input: FarmInput, text: string) => lineOf(await (await talk(w)).ready('herd_log', input, text));
    expect(await t({ herd: '1-otar', feeds: [{ feed: 'beda', qty: 2, unit: 't' }] }, '1-otarga 2 tonna beda berdim')).toEqual([['Beda', 2000, 'kg']]);
    expect(await t({ herd: '1-otar', feeds: [{ feed: 'beda', qty: 500, unit: 'g' }] }, '1-otarga 500 gramm beda berdim')).toEqual([['Beda', 0.5, 'kg']]);
    expect(await t({ herd: '1-otar', feeds: [{ feed: 'somon', qty: 5, unit: 'bale' }] }, "1-otarga 5 toy somon berdim")).toEqual([['Somon', 5, 'bale']]);
    // Kilograms say nothing about bales.
    const asked = await (await talk(w)).asked('herd_log', { herd: '1-otar', feeds: [{ feed: 'somon', qty: 300, unit: 'kilo' }] }, '1-otarga 300 kilo somon berdim');
    expect(asked).toEqual(['FEED_UNIT_MISMATCH']);
  });

  it.each([
    ['the amount first', 'bugun 1-otarga 300 kilo beda va 50 kilo arpa berdim'],
    ['the feed first', '1-otarga beda 300 kilo, arpa 50 kilo berdim'],
    ['Uzbek Cyrillic', latinToCyrillic('bugun 1-otarga 300 kilo beda va 50 kilo arpa berdim')],
    ['Russian', 'Сегодня стаду 1-отар дали 300 кг беда и 50 кг арпа'],
    ['English', 'Today herd 1-otar got 300 kg of beda and 50 kg of arpa'],
  ])('two feeds in one sentence keep each its own amount: %s', async (_, text) => {
    const both = { herd: '1-otar', feeds: [{ feed: 'beda', qty: 300, unit: 'kg' }, { feed: 'arpa', qty: 50, unit: 'kg' }] };
    expect(lineOf(await (await talk(w)).ready('herd_log', both, text))).toEqual([['Beda', 300, 'kg'], ['Arpa', 50, 'kg']]);
    // A model that swaps the amounts changes nothing: each stands beside its own feed.
    const swapped = { herd: '1-otar', feeds: [{ feed: 'beda', qty: 50, unit: 'kg' }, { feed: 'arpa', qty: 300, unit: 'kg' }] };
    expect(lineOf(await (await talk(w)).ready('herd_log', swapped, text))).toEqual([['Beda', 300, 'kg'], ['Arpa', 50, 'kg']]);
    // And a model that names one feed with the other's amount gets that feed's own.
    const one = { herd: '1-otar', feeds: [{ feed: 'arpa', qty: 300, unit: 'kg' }] };
    expect(lineOf(await (await talk(w)).ready('herd_log', one, text))).toEqual([['Arpa', 50, 'kg']]);
  });

  it('a weight said in the same message is not a feed, and a feed is not a weight', async () => {
    const t = await talk(w);
    const text = "1234-qo'y 46 kilo chiqdi. 1-otarga 300 kilo beda berdim";
    expect(lineOf(await t.ready('herd_log', { herd: '1-otar', feeds: [{ feed: 'beda', qty: 46, unit: 'kilo' }] }, text))).toEqual([['Beda', 300, 'kg']]);
    expect((await t.ready('weight', { tag: '1234', weightKg: 300 }, text)).fields.weightKg).toBe(46);
    // Read either way round, the amount beside the feed is unclear: a question.
    const unclear = "46 kilo chiqdi 1234-qo'y, beda 300 kilo berdim 1-otarga";
    expect(await (await talk(w)).asked('herd_log', beda, unclear)).toEqual(['FEED_QTY_REQUIRED']);
  });

  it('one amount for two feeds is a question, never shared out', async () => {
    const both = { herd: '1-otar', feeds: [{ feed: 'beda', qty: 300, unit: 'kg' }, { feed: 'arpa', qty: 300, unit: 'kg' }] };
    expect(await (await talk(w)).asked('herd_log', both, '1-otarga 300 kilo beda va arpa berdim')).toEqual(['FEED_QTY_REQUIRED']);
    const t = await talk(w);
    expect(await t.asked('herd_log', both, '1-otarga 300 kilo beda berdim, arpa ham berdim')).toEqual(['FEED_QTY_REQUIRED']);
    // The answer names no feed, and only one feed is waiting for its amount.
    expect(lineOf(await t.ready('herd_log', both, ['1-otarga 300 kilo beda berdim', 'arpa ham berdim', '50 kilo']))).toEqual([['Beda', 300, 'kg'], ['Arpa', 50, 'kg']]);
  });

  it.each([
    ['Uzbek Latin', 'kecha 1-otarga 300 kilo beda berdim'],
    ['Uzbek Cyrillic', latinToCyrillic('kecha 1-otarga 300 kilo beda berdim')],
    ['Russian', 'Вчера дали 300 кг беда стаду 1-отар'],
    ['English', 'Yesterday we gave 300 kg of beda to herd 1-otar'],
  ])('"yesterday" in the words sets the day: %s', async (_, text) => {
    const t = await talk(w);
    expect((await t.ready('herd_log', { ...beda, date: daysAgo(1) }, text)).fields.date).toBe(daysAgo(1));
    // A day the model sets against their words is a question.
    expect(await (await talk(w)).asked('herd_log', { ...beda, date: daysAgo(3) }, text)).toEqual(['DATE_UNCLEAR']);
  });

  it('said again with another amount, the card is corrected and stays one card', async () => {
    const t = await talk(w);
    const card = await t.ready('herd_log', beda, FED);
    const again = await t.ready('herd_log', { herd: '1-otar', feeds: [{ feed: 'beda', qty: 350, unit: 'kilo' }] }, [FED, "yo'q, 350 kilo"]);
    expect(again.id).toBe(card.id);
    expect(lineOf(again)).toEqual([['Beda', 350, 'kg']]);
    expect(await w.f.run(() => tx().select().from(aiProposals).where(eq(aiProposals.conversationId, t.conversationId)))).toHaveLength(1);
  });
});

describe('herd log: which herd', () => {
  it('the only herd, when none was named, stands on the card as chosen by rule', async () => {
    const w = await farm();
    const card = await (await talk(w)).ready('herd_log', { feeds: [{ feed: 'beda', qty: 300, unit: 'kilo' }] }, 'bugun 300 kilo beda berdim');
    expect(card.fields.herd).toEqual({ id: w.herdId, name: '1-otar', defaulted: true });
    expect(renderFarmProposalText(card, 'uz')).toContain("Poda: 1-otar (yagona poda, siz aytmadingiz)");
    // A herd the model names without their words is not taken.
    expect(await (await talk(w)).asked('herd_log', { herd: '2-otar', feeds: beda.feeds }, 'bugun 300 kilo beda berdim')).toEqual(['HERD_REQUIRED']);
  });

  it('with two herds an unnamed herd is a question, and an amount said once backs one card', async () => {
    const w = await farm();
    const second = await secondHerd(w);
    const none = await (await talk(w)).draft('herd_log', { feeds: beda.feeds }, 'bugun 300 kilo beda berdim');
    expect(none).toMatchObject({ status: 'needs_info', questions: [{ code: 'HERD_REQUIRED' }] });
    expect(none.status === 'needs_info' && none.questions[0].options.map((o) => o.label).sort()).toEqual(['1-otar', '2-otar']);

    const t = await talk(w);
    const text = '1-otarga ham, 2-otarga ham 300 kilo beda berdim';
    const first = await t.ready('herd_log', beda, text);
    expect(first.fields.herd?.id).toBe(w.herdId);
    // The 300 kg were said once: the second herd's card needs its own.
    expect(await t.asked('herd_log', { herd: '2-otar', feeds: beda.feeds }, text)).toEqual(['FEED_QTY_REQUIRED']);
    const other = await t.ready('herd_log', { herd: '2-otar', feeds: beda.feeds }, [text, '2-otarga 200 kilo beda']);
    expect(other.id).not.toBe(first.id);
    expect(other.fields.herd?.id).toBe(second);
    expect(lineOf(other)).toEqual([['Beda', 200, 'kg']]);
  });

  it('names the ration feeds the record will hold as not given', async () => {
    const w = await farm();
    await giveRation(w);
    const card = await (await talk(w)).ready('herd_log', beda, FED);
    expect(card.warnings).toEqual([{ code: 'RATION_REST_NOT_GIVEN', params: { items: 'Arpa' } }]);
    expect(renderFarmProposalText(card, 'uz')).toContain('⚠️ Ratsiondagi boshqa ozuqalar berilmagan deb yoziladi: Arpa.');
    const both = { herd: '1-otar', feeds: [{ feed: 'beda', qty: 300, unit: 'kg' }, { feed: 'arpa', qty: 50, unit: 'kg' }] };
    expect((await (await talk(w)).ready('herd_log', both, 'bugun 1-otarga 300 kilo beda va 50 kilo arpa berdim')).warnings).toEqual([]);
  });
});

describe('herd log: confirm writes through the daily log service', () => {
  it('a shepherd confirms: the log is theirs, the feed leaves the warehouse and is charged to the herd', async () => {
    const w = await farm();
    await grant(w.f, 'shepherd');
    const shepherd = await w.f.as('shepherd');
    const card = await (await talk(w, shepherd)).ready('herd_log', beda, FED);

    const done = await confirm(shepherd, card);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // Taking a daily log back is `livestock.delete` on its own page, which a shepherd does not hold.
    expect(done.data).toMatchObject({ status: 'confirmed', canUndo: false, undoUntil: null, result: { type: 'daily_log' } });
    // Rule 7: the answer holds no money.
    expect(JSON.stringify(done.data)).not.toMatch(/cost|price/i);

    const [log] = await logsOf(w);
    expect(log).toMatchObject({ id: done.data.result.id, date: today, headCount: TAGS.length, condition: 'normal', createdBy: shepherd.userId });
    expect(await fedLines(w, log.id)).toMatchObject([{ itemId: w.item.Beda, warehouseId: w.feedStoreId, actualQty: 300, totalCost: 300 * FEED_COST }]);
    expect(await stockOf(w, 'Beda')).toBe(4700);
    const [herd] = await w.f.run(() => tx().select().from(herds).where(eq(herds.id, w.herdId)));
    expect(await movementsOf(w, 'daily_log', log.id)).toMatchObject([{ type: 'issue', itemId: w.item.Beda, qty: 300, costCenterId: herd.costCenterId, createdBy: shepherd.userId }]);
    expect(await eventsOf(w, 'herd.daily_log')).toMatchObject([{ entityId: w.herdId, createdBy: shepherd.userId, data: { logId: log.id } }]);
    expect(await eventsOf(w, 'ai_proposal.confirmed')).toMatchObject([{ entityId: card.id, data: { kind: 'herd_log', resultType: 'daily_log', resultId: log.id } }]);

    expect((await undo(shepherd, card)).status).toBe(409);
    expect((await shepherd.delete(`/livestock/daily-logs/${log.id}`)).status).toBe(403);
    expect(await logsOf(w)).toHaveLength(1);
  });

  it('whoever may delete a daily log may take it back, and the feed returns to the warehouse', async () => {
    const w = await farm();
    const both = { herd: '1-otar', feeds: [{ feed: 'beda', qty: 300, unit: 'kg' }, { feed: 'arpa', qty: 50, unit: 'kg' }] };
    const card = await (await talk(w)).ready('herd_log', both, 'bugun 1-otarga 300 kilo beda va 50 kilo arpa berdim');
    const done = await confirm(w.owner, card);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.data).toMatchObject({ status: 'confirmed', canUndo: true });
    expect((await fedLines(w, done.data.result.id)).map((line) => line.actualQty).sort((a, b) => a - b)).toEqual([50, 300]);
    expect([await stockOf(w, 'Beda'), await stockOf(w, 'Arpa')]).toEqual([4700, 950]);

    const back = await undo(w.owner, card);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.data).toMatchObject({ status: 'undone', canUndo: false });
    expect(await logsOf(w)).toEqual([]);
    expect([await stockOf(w, 'Beda'), await stockOf(w, 'Arpa')]).toEqual([5000, 1000]);
    expect(await eventsOf(w, 'herd.daily_log_deleted')).toMatchObject([{ entityId: w.herdId, createdBy: w.owner.userId }]);
  });

  it('a ration feed left off the card is written as not given, as the card said', async () => {
    const w = await farm();
    await giveRation(w);
    const card = await (await talk(w)).ready('herd_log', beda, FED);
    const done = await confirm(w.owner, card);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const lines = await fedLines(w, done.data.result.id);
    expect(lines.find((line) => line.itemId === w.item.Arpa)).toMatchObject({ actualQty: 0, plannedQty: 1.2 });
    expect(lines.find((line) => line.itemId === w.item.Beda)).toMatchObject({ actualQty: 300, plannedQty: TAGS.length });
    expect(await stockOf(w, 'Arpa')).toBe(1000);
  });

  it('a person without livestock.create is refused when drafting and at confirm, as on the daily log page', async () => {
    const w = await farm();
    await grant(w.f, 'veterinarian');
    const vet = await w.f.as('veterinarian');
    const t = await talk(w, vet);
    const asVet = { userId: vet.userId, permissions: [...DEFAULT_ROLE_PERMISSIONS.veterinarian, 'ai.view'] as Permission[] };
    const env: DraftEnv = { userTexts: [FED], documentAmounts: [], channel: 'web', conversationId: t.conversationId };
    await expect(w.f.run(() => saveFarmDraft('herd_log', beda, env), asVet)).rejects.toMatchObject({ status: 403 });

    // A card made while they held the right is checked again at confirm.
    const card = await t.ready('herd_log', beda, FED);
    expect((await confirm(vet, card)).status).toBe(403);
    expect((await vet.post('/livestock/daily-logs', { herdId: w.herdId, lines: [{ itemId: w.item.Beda, actualQty: 300 }] })).status).toBe(403);
    expect(await logsOf(w)).toEqual([]);
    expect(await stockOf(w, 'Beda')).toBe(5000);
    expect((await vet.get(`/ai/farm-proposals/${card.id}`)).data).toMatchObject({ status: 'pending', canConfirm: false });
  });

  it('refuses a day the herd already has in the books, when drafting and again at confirm', async () => {
    const w = await farm();
    const t = await talk(w);
    const card = await t.ready('herd_log', beda, FED);
    // Entered on the daily log page in the meantime.
    await w.f.run(() => createDailyLog({ herdId: w.herdId, lines: [{ itemId: w.item.Beda, actualQty: 100 }] }), { userId: w.owner.userId });

    const refused = await confirm(w.owner, card);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('FARM_RECORD_EXISTS');
    expect(await logsOf(w)).toHaveLength(1);
    expect(await stockOf(w, 'Beda')).toBe(4900);

    expect(await (await talk(w)).asked('herd_log', beda, FED)).toEqual(['ALREADY_RECORDED']);
    // Another day is another record.
    expect((await (await talk(w)).ready('herd_log', { ...beda, date: daysAgo(1) }, 'kecha 1-otarga 300 kilo beda berdim')).fields.date).toBe(daysAgo(1));
  });

  it('two cards about one day in two conversations feed the herd once', async () => {
    const w = await farm();
    const first = await (await talk(w)).ready('herd_log', beda, FED);
    const second = await (await talk(w)).ready('herd_log', beda, FED);
    const results = await Promise.all([confirm(w.owner, first), confirm(w.owner, second)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('FARM_RECORD_EXISTS');
    expect(await logsOf(w)).toHaveLength(1);
    expect(await stockOf(w, 'Beda')).toBe(4700);
  });

  it('more than the warehouse holds is refused by the warehouse, and nothing is written', async () => {
    const w = await farm();
    const card = await (await talk(w)).ready('herd_log', { herd: '1-otar', feeds: [{ feed: 'beda', qty: 9, unit: 't' }] }, '1-otarga 9 tonna beda berdim');
    const refused = await confirm(w.owner, card);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await logsOf(w)).toEqual([]);
    expect(await stockOf(w, 'Beda')).toBe(5000);
    expect((await w.owner.get(`/ai/farm-proposals/${card.id}`)).data.status).toBe('pending');
  });

  it('refuses when the herd or the feed changed since the card was made', async () => {
    const w = await farm();
    const stale = async (change: () => Promise<unknown>) => {
      const card = await (await talk(w)).ready('herd_log', beda, FED);
      await w.f.run(change);
      const refused = await confirm(w.owner, card);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('PROPOSAL_STALE');
    };
    // The card's 300 were kilograms: the same number of bales is another thing.
    await stale(() => tx().update(items).set({ unit: 'bale' }).where(eq(items.id, w.item.Beda)));
    await w.f.run(() => tx().update(items).set({ unit: 'kg' }).where(eq(items.id, w.item.Beda)));
    await stale(() => tx().update(herds).set({ status: 'archived' }).where(eq(herds.id, w.herdId)));
    expect(await logsOf(w)).toEqual([]);
    expect(await stockOf(w, 'Beda')).toBe(5000);
  });

  it('a card belongs to the person it was made for, and to their farm', async () => {
    const w = await farm();
    await grant(w.f, 'director');
    const card = await (await talk(w)).ready('herd_log', beda, FED);

    expect((await confirm(await w.f.as('director'), card)).status).toBe(403);
    const elsewhere = await farm();
    expect((await confirm(elsewhere.owner, card)).status).toBe(404);
    // The same words on another farm find that farm's herd and that farm's feed, never this one's.
    const theirs = await (await talk(elsewhere)).ready('herd_log', beda, FED);
    expect(theirs.fields).toMatchObject({ herd: { id: elsewhere.herdId }, stockOut: [{ itemId: elsewhere.item.Beda }] });
    expect(await logsOf(w)).toEqual([]);
    expect(await stockOf(w, 'Beda')).toBe(5000);
    expect(await stockOf(elsewhere, 'Beda')).toBe(5000);
  });
});

describe('herd log: through the assistant', () => {
  it('the model drafts, a card comes back, and the feed stays in the warehouse until it is confirmed', async () => {
    const w = await farm();
    setProvider(new Scripted([call('draft_herd_log', beda), say('Tasdiqlang.')]));
    const res = await w.owner.post('/ai/chat', { message: FED });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const card = res.data.message.attachments.find((a: any) => a.type === 'farm_proposal');
    expect(card.proposal).toMatchObject({ kind: 'herd_log', status: 'pending', fields: { herd: { name: '1-otar' }, stockOut: [{ name: 'Beda', qty: 300, unit: 'kg' }] } });
    expect(await stockOf(w, 'Beda')).toBe(5000);
    expect((await confirm(w.owner, card.proposal)).status).toBe(200);
    expect(await stockOf(w, 'Beda')).toBe(4700);
  });

  it('a model that shares one amount between two feeds gets a question for the person', async () => {
    const w = await farm();
    const both = { herd: '1-otar', feeds: [{ feed: 'beda', qty: 150, unit: 'kg' }, { feed: 'arpa', qty: 150, unit: 'kg' }] };
    setProvider(new Scripted([call('draft_herd_log', both), say('Har biridan qancha?')]));
    const res = await w.owner.post('/ai/chat', { message: '1-otarga 300 kilo beda va arpa berdim' });
    expect(res.data.message.attachments.filter((a: any) => a.type === 'farm_proposal')).toEqual([]);
    expect(res.data.message.attachments.find((a: any) => a.type === 'question').question.code).toBe('FEED_QTY_REQUIRED');
    expect(await stockOf(w, 'Beda')).toBe(5000);
  });

  it('offers the tool to whoever may write the daily log, and to no one else', async () => {
    const tools = async (client: Client) => {
      const provider = new Scripted([say('...')]);
      setProvider(provider);
      await client.post('/ai/chat', { message: 'Salom' });
      return offered(provider);
    };
    const w = await farm();
    await grant(w.f, 'shepherd');
    await grant(w.f, 'veterinarian');
    expect(await tools(await w.f.as('shepherd'))).toEqual(expect.arrayContaining(['draft_herd_log', 'cancel_farm_draft']));
    // A vet reads the flock and updates it, and does not write its daily log.
    expect(await tools(await w.f.as('veterinarian'))).not.toContain('draft_herd_log');
  });

  it('is not offered when the livestock module is switched off', async () => {
    const w = await farm({ modules: ['health', 'ai', 'inventory'] });
    const provider = new Scripted([say('...')]);
    setProvider(provider);
    await w.owner.post('/ai/chat', { message: 'Salom' });
    expect(offered(provider)).toContain('draft_treatment');
    expect(offered(provider)).not.toContain('draft_herd_log');
  });
});

describe('the card as text, for Telegram', () => {
  it('names the animal, the weight and the day in each language, and holds no money', async () => {
    const w = await farm();
    const t = await talk(w);
    const card = await t.ready('weight', { tag: '1234', weightKg: 46 }, WEIGHED);
    const day = today.split('-').reverse().join('.');
    expect(renderFarmProposalText(card, 'uz')).toBe(["Tortish", "Hayvon: 1234, Sovliq, 14 oylik", 'Poda: 1-otar', "Vazni: 46 kg", `Sana: ${day}`].join('\n'));
    expect(renderFarmProposalText(card, 'ru')).toContain('Животное: 1234, Овцематка, 14 мес.');
    expect(renderFarmProposalText(card, 'en', 'Yuksalish Agro')).toBe(
      ['Weighing', 'Animal: 1234, Ewe, 14 months', 'Herd: 1-otar', 'Farm: Yuksalish Agro', 'Weight: 46 kg', `Date: ${day}`].join('\n'),
    );
  });

  it('a death names the animal, the words given as the cause, and what confirming does', async () => {
    const w = await farm();
    const t = await talk(w);
    const card = await t.ready('death', { tag: '0567', cause: 'ichi ketgan' }, DIED);
    const day = today.split('-').reverse().join('.');
    expect(renderFarmProposalText(card, 'uz')).toBe(
      [
        "Hayvon o'limi",
        'Hayvon: 0567, Sovliq, 14 oylik',
        'Poda: 1-otar',
        `Sana: ${day}`,
        "Sizning so'zingiz: ichi ketgan",
        'Tasdiqlasangiz, bu hayvon daftarda podadan chiqariladi.',
      ].join('\n'),
    );
    expect(renderFarmProposalText(card, 'ru')).toContain('Падёж животного');
    expect(renderFarmProposalText(card, 'en')).toContain('Once you confirm, this animal leaves the flock in the books.');
  });

  it('a treatment names the drug, the dose, and what leaves which warehouse, and holds no money', async () => {
    const w = await farm();
    const t = await talk(w);
    const card = await t.ready('treatment', { tag: '0567', drug: 'ivermektin', qty: 5, unit: 'ml', cause: "yo'talayotgan edi" }, `${TREATED}, yo'talayotgan edi`);
    const day = today.split('-').reverse().join('.');
    expect(renderFarmProposalText(card, 'uz')).toBe(
      [
        'Veterinariya muolajasi',
        'Hayvon: 0567, Sovliq, 14 oylik',
        'Poda: 1-otar',
        'Muolaja: Davolash',
        'Dori: Ivermektin',
        'Doza: 5 ml',
        'Ombordan chiqadi: Ivermektin, 0,005 l (Vet ombor)',
        `Sana: ${day}`,
        "Sizning so'zingiz: yo'talayotgan edi",
      ].join('\n'),
    );
    expect(renderFarmProposalText(card, 'ru')).toContain('Уйдёт со склада: Ivermektin, 0,005 л (Vet ombor)');
    expect(renderFarmProposalText(card, 'en')).toContain('Leaves the warehouse: Ivermektin, 0,005 L (Vet ombor)');
    for (const language of ['uz', 'ru', 'en']) expect(renderFarmProposalText(card, language)).not.toMatch(/40[  ,.]?000|so'm|сум|UZS/);

    const named = await t.ready('treatment', { tag: '1234', drug: 'biovit', qty: 5, unit: 'ml' }, '1234 ga 5 ml biovit qildim');
    expect(renderFarmProposalText(named, 'uz')).toContain("⚠️ Bu dori ombor ro'yxatida yo'q: ombordan hech narsa chiqmaydi.");
    expect(renderFarmProposalText(named, 'uz')).not.toContain('Ombordan chiqadi');
  });

  it('a herd log names the herd, each feed that leaves the warehouse, and that it is the record of the day', async () => {
    const w = await farm();
    const both = { herd: '1-otar', feeds: [{ feed: 'beda', qty: 300, unit: 'kg' }, { feed: 'arpa', qty: 50, unit: 'kg' }] };
    const card = await (await talk(w)).ready('herd_log', both, 'bugun 1-otarga 300 kilo beda va 50 kilo arpa berdim');
    const day = today.split('-').reverse().join('.');
    expect(renderFarmProposalText(card, 'uz')).toBe(
      [
        'Podani oziqlantirish',
        'Poda: 1-otar',
        'Ombordan chiqadi: Beda, 300 kg (ombor yozilayotganda tanlanadi)',
        'Ombordan chiqadi: Arpa, 50 kg (ombor yozilayotganda tanlanadi)',
        `Sana: ${day}`,
        "Tasdiqlasangiz, bu podaning shu kungi yozuvi bo'ladi. Bir podaga kuniga bitta yozuv yoziladi.",
      ].join('\n'),
    );
    expect(renderFarmProposalText(card, 'ru')).toContain('Уйдёт со склада: Beda, 300 кг (склад выбирается при записи)');
    expect(renderFarmProposalText(card, 'ru')).toContain('У стада одна запись в день.');
    expect(renderFarmProposalText(card, 'en')).toContain('Leaves the warehouse: Arpa, 50 kg (the warehouse is chosen when it is recorded)');
    for (const language of ['uz', 'ru', 'en']) expect(renderFarmProposalText(card, language)).not.toMatch(/1[  ,.]?500|so'm|сум|UZS/);
  });
});
