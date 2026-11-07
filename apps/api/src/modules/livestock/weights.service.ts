import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { WEIGHT_METHODS, averageDailyGain, diffDays, round } from '@yap/shared';
import { maxLiveWeightKg } from '@yap/shared/formulas/livestock';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { clientId, isoDate, listQuery, paged, sortBy } from '../../core/query';
import { assertInFarm, assertNotFuture, assertOnFarm, getAnimalOrThrow, herdHeadCount, isOnFarm, type Animal } from './refs';

const { animals, herds, species, weighingCampaigns: campaigns, weightRecords: weights } = schema;

const weightKg = z.number().positive().max(2000);

export const weightInput = z.object({
  id: clientId,
  animalId: z.uuid(),
  date: isoDate.optional(),
  weightKg,
  method: z.enum(WEIGHT_METHODS).optional(),
  notes: z.string().max(500).nullish(),
});

/** Keep currentWeightKg on the newest record. An old weight entered late must not overwrite it. */
async function refreshCurrentWeight(animalId: string): Promise<void> {
  const [latest] = await tx()
    .select({ weightKg: weights.weightKg, date: weights.date })
    .from(weights)
    .where(eq(weights.animalId, animalId))
    .orderBy(desc(weights.date), desc(weights.createdAt))
    .limit(1);
  await tx()
    .update(animals)
    .set({ currentWeightKg: latest?.weightKg ?? null, lastWeighedOn: latest?.date ?? null })
    .where(eq(animals.id, animalId));
}

/**
 * For weights a person types. One slip would become the animal's headline weight, its daily gain and
 * part of the herd average. Imports check their rows at preview, so they do not come through here.
 */
async function assertPlausible(animal: Animal, weightKg: number, date: string): Promise<void> {
  if (animal.birthDate && date < animal.birthDate) {
    throw badRequest('WEIGHT_BEFORE_BIRTH', `Animal ${animal.tag} was not born yet on ${date}`);
  }
  const [kind] = await tx().select({ key: species.key }).from(species).where(eq(species.id, animal.speciesId));
  const max = maxLiveWeightKg(kind?.key ?? '');
  if (weightKg > max) throw badRequest('WEIGHT_NOT_PLAUSIBLE', `${weightKg} kg is not believable for this animal`, { max });
}

/** Insert a weight and update the animal. Used by the form, campaigns and createAnimal. */
export async function addWeight(i: {
  id?: string;
  animal: Animal;
  date: string;
  weightKg: number;
  method?: (typeof WEIGHT_METHODS)[number];
  campaignId?: string | null;
  notes?: string | null;
}) {
  const c = ctx();
  const [row] = await tx()
    .insert(weights)
    .values({
      ...(i.id ? { id: i.id } : {}),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      animalId: i.animal.id,
      date: i.date,
      weightKg: i.weightKg,
      method: i.method ?? 'manual',
      campaignId: i.campaignId,
      notes: i.notes,
    })
    .returning();
  await refreshCurrentWeight(i.animal.id);
  return row;
}

export async function createWeight(input: z.infer<typeof weightInput>) {
  const animal = await getAnimalOrThrow(input.animalId, { lock: true });
  assertOnFarm(animal);
  const date = input.date ?? today();
  assertNotFuture(date);
  await assertPlausible(animal, input.weightKg, date);
  const row = await addWeight({ ...input, animal, date });
  await recordEvent({
    type: 'animal.weighed',
    entityType: 'animal',
    entityId: animal.id,
    occurredAt: date,
    data: { weightKg: input.weightKg, method: row.method },
  });
  return row;
}

export async function deleteWeight(id: string) {
  const [row] = await tx()
    .select()
    .from(weights)
    .where(and(eq(weights.id, id), eq(weights.farmId, ctx().farmId)));
  if (!row) throw notFound('Weight');
  await tx().delete(weights).where(eq(weights.id, id));
  await refreshCurrentWeight(row.animalId);
  return { id };
}

// ─── Weighing campaigns (spec 8.4) ──────────────────────────────────────────

export const campaignInput = z.object({
  id: clientId,
  herdId: z.uuid(),
  date: isoDate.optional(),
  name: z.string().trim().min(1).max(120),
});

export const campaignListQuery = listQuery.extend({
  herdId: z.uuid().optional(),
  status: z.enum(['open', 'closed']).optional(),
});

const weighedCount = sql<number>`(select count(distinct w.animal_id) from weight_records w where w.campaign_id = ${campaigns.id})`.mapWith(Number);
const averageWeight = sql<number | null>`(select round(avg(w.weight_kg), 2) from weight_records w where w.campaign_id = ${campaigns.id})`.mapWith(
  (v) => (v === null ? null : Number(v)),
);

export async function listCampaigns(q: z.infer<typeof campaignListQuery>) {
  const where = and(
    eq(campaigns.farmId, ctx().farmId),
    q.herdId ? eq(campaigns.herdId, q.herdId) : undefined,
    q.status ? eq(campaigns.status, q.status) : undefined,
  );
  const page = await paged(q, campaigns, where, (limit, offset) =>
    tx()
      .select({
        id: campaigns.id,
        name: campaigns.name,
        date: campaigns.date,
        status: campaigns.status,
        herdId: campaigns.herdId,
        herdName: herds.name,
        weighed: weighedCount,
        averageKg: averageWeight,
      })
      .from(campaigns)
      .leftJoin(herds, eq(herds.id, campaigns.herdId))
      .where(where)
      .orderBy(...sortBy(q.sort, { date: campaigns.date, name: campaigns.name }, desc(campaigns.date), campaigns.id))
      .limit(limit)
      .offset(offset),
  );
  const data = [];
  for (const row of page.data) {
    data.push({ ...row, total: row.herdId ? await herdHeadCount(row.herdId) : null });
  }
  return { ...page, data };
}

export async function createCampaign(input: z.infer<typeof campaignInput>) {
  const c = ctx();
  await assertInFarm(herds, input.herdId, 'Herd');
  const date = input.date ?? today();
  assertNotFuture(date);
  const [row] = await tx()
    .insert(campaigns)
    .values({
      ...(input.id ? { id: input.id } : {}),
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      herdId: input.herdId,
      date,
      name: input.name,
    })
    .returning();
  return row;
}

async function getCampaignOrThrow(id: string) {
  const [row] = await tx()
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, id), eq(campaigns.farmId, ctx().farmId)));
  if (!row) throw notFound('Weighing campaign');
  return row;
}

async function campaignProgress(campaign: typeof campaigns.$inferSelect) {
  const [row] = await tx()
    .select({
      weighed: sql<number>`count(distinct ${weights.animalId})`.mapWith(Number),
      averageKg: sql<number | null>`round(avg(${weights.weightKg}), 2)`.mapWith((v) => (v === null ? null : Number(v))),
    })
    .from(weights)
    .where(eq(weights.campaignId, campaign.id));
  const total = campaign.herdId ? await herdHeadCount(campaign.herdId) : null;
  return { weighed: row.weighed, total, averageKg: row.averageKg };
}

/** Weight before this campaign, with the daily gain since then. */
async function previousWeight(animalId: string, before: string) {
  const [row] = await tx()
    .select({ weightKg: weights.weightKg, date: weights.date })
    .from(weights)
    .where(and(eq(weights.animalId, animalId), sql`${weights.date} < ${before}`))
    .orderBy(desc(weights.date))
    .limit(1);
  return row ?? null;
}

export async function getCampaign(id: string) {
  const campaign = await getCampaignOrThrow(id);
  const entries = await tx()
    .select({
      id: weights.id,
      animalId: weights.animalId,
      tag: animals.tag,
      weightKg: weights.weightKg,
      method: weights.method,
      createdAt: weights.createdAt,
      herdId: animals.herdId,
    })
    .from(weights)
    .innerJoin(animals, eq(animals.id, weights.animalId))
    .where(eq(weights.campaignId, id))
    .orderBy(desc(weights.createdAt));

  const previous = await tx().execute<{ animal_id: string; weight_kg: string; date: string }>(sql`
    select distinct on (w.animal_id) w.animal_id, w.weight_kg, w.date::text as date
    from weight_records w
    where w.farm_id = ${ctx().farmId} and w.date < ${campaign.date}
      and w.animal_id in (select animal_id from weight_records where campaign_id = ${id})
    order by w.animal_id, w.date desc`);
  const previousByAnimal = new Map(previous.rows.map((r) => [r.animal_id, r]));

  const [herd] = campaign.herdId
    ? await tx().select({ name: herds.name }).from(herds).where(eq(herds.id, campaign.herdId))
    : [];

  return {
    ...campaign,
    herdName: herd?.name ?? null,
    ...(await campaignProgress(campaign)),
    entries: entries.map((e) => {
      const prev = previousByAnimal.get(e.animalId);
      const previousKg = prev ? Number(prev.weight_kg) : null;
      const days = prev ? diffDays(prev.date, campaign.date) : 0;
      const adg = prev ? averageDailyGain(e.weightKg, previousKg!, days) : null;
      return {
        ...e,
        previousKg,
        gainKg: previousKg === null ? null : round(e.weightKg - previousKg, 2),
        adgG: adg === null ? null : Math.round(adg * 1000),
        otherHerd: e.herdId !== campaign.herdId,
      };
    }),
  };
}

export const entryInput = z.object({
  /** Ear tag, RFID or QR value: whatever the scanner or the keyboard produced. */
  code: z.string().trim().min(1).max(60),
  weightKg,
  method: z.enum(WEIGHT_METHODS).optional(),
});

export const bulkEntryInput = z.object({ entries: z.array(entryInput).min(1).max(1000) });

export type AnimalFinder = (code: string) => Promise<Animal | null>;

async function applyEntry(
  campaign: typeof campaigns.$inferSelect,
  entry: z.infer<typeof entryInput>,
  find: AnimalFinder,
) {
  const animal = await find(entry.code);
  if (!animal) throw conflict('ANIMAL_NOT_FOUND', `No animal with the code ${entry.code}`, { code: entry.code });
  assertOnFarm(animal);
  await assertPlausible(animal, entry.weightKg, campaign.date);

  // Scanning the same animal twice corrects the entry instead of creating a second record.
  const [existing] = await tx()
    .select()
    .from(weights)
    .where(and(eq(weights.campaignId, campaign.id), eq(weights.animalId, animal.id)));

  if (existing) {
    await tx()
      .update(weights)
      .set({ weightKg: entry.weightKg, method: entry.method ?? existing.method })
      .where(eq(weights.id, existing.id));
    await refreshCurrentWeight(animal.id);
  } else {
    await addWeight({
      animal,
      date: campaign.date,
      weightKg: entry.weightKg,
      method: entry.method ?? 'scale',
      campaignId: campaign.id,
    });
  }

  const previous = await previousWeight(animal.id, campaign.date);
  return {
    animalId: animal.id,
    tag: animal.tag,
    weightKg: entry.weightKg,
    previousKg: previous?.weightKg ?? null,
    gainKg: previous ? round(entry.weightKg - previous.weightKg, 2) : null,
    updated: !!existing,
    otherHerd: animal.herdId !== campaign.herdId,
  };
}

function assertOpen(campaign: typeof campaigns.$inferSelect): void {
  if (campaign.status !== 'open') throw conflict('CAMPAIGN_CLOSED', 'This weighing campaign is closed');
}

export async function addEntry(id: string, entry: z.infer<typeof entryInput>, find: AnimalFinder) {
  const campaign = await getCampaignOrThrow(id);
  assertOpen(campaign);
  const result = await applyEntry(campaign, entry, find);
  return { ...result, progress: await campaignProgress(campaign) };
}

/** Import from a scale file. A bad row is reported and does not stop the rest. */
export async function addEntries(id: string, entries: z.infer<typeof entryInput>[], find: AnimalFinder) {
  const campaign = await getCampaignOrThrow(id);
  assertOpen(campaign);
  const applied = [];
  const failed: { code: string; error: string }[] = [];
  for (const entry of entries) {
    const animal = await find(entry.code);
    if (!animal) {
      failed.push({ code: entry.code, error: 'ANIMAL_NOT_FOUND' });
      continue;
    }
    if (!isOnFarm(animal.status)) {
      failed.push({ code: entry.code, error: 'ANIMAL_NOT_ON_FARM' });
      continue;
    }
    applied.push(await applyEntry(campaign, entry, async () => animal));
  }
  return { applied: applied.length, failed, progress: await campaignProgress(campaign) };
}

export async function closeCampaign(id: string) {
  const campaign = await getCampaignOrThrow(id);
  assertOpen(campaign);
  const progress = await campaignProgress(campaign);
  const [row] = await tx().update(campaigns).set({ status: 'closed' }).where(eq(campaigns.id, id)).returning();
  await recordEvent({
    type: 'herd.weighing_closed',
    entityType: 'herd',
    entityId: campaign.herdId,
    occurredAt: campaign.date,
    data: { campaignId: id, ...progress },
  });
  return row;
}

/** Oldest first, each with the daily gain from the record before it. */
export async function weightHistory(animalId: string) {
  const rows = await tx()
    .select({
      id: weights.id,
      date: weights.date,
      weightKg: weights.weightKg,
      method: weights.method,
      notes: weights.notes,
    })
    .from(weights)
    .where(eq(weights.animalId, animalId))
    .orderBy(asc(weights.date), asc(weights.createdAt));
  return rows.map((row, index) => {
    const prev = rows[index - 1];
    const adg = prev ? averageDailyGain(row.weightKg, prev.weightKg, diffDays(prev.date, row.date)) : null;
    return { ...row, adgG: adg === null ? null : Math.round(adg * 1000) };
  });
}
