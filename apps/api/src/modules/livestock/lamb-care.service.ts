/**
 * Newborn care: colostrum, navel, and who raises the lamb. One row per lamb. The genetic dam stays
 * in animals.dam_id, so pedigree and the ewe's productivity figures are untouched by fostering;
 * the ewe raising a fostered lamb is kept here.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { LAMB_MOTHERING, addDays, diffDays, round, todayIso } from '@yap/shared';
import { LAMBING_DESK, lambAttention, minHoursSinceBirth } from '@yap/shared/formulas/lambing';
import { WEANING_DAYS } from '@yap/shared/formulas/reproduction';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import { badRequest, conflict } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { getAnimalOrThrow, isOnFarm, onFarm } from './refs';

const { animals, facilities, herds, lambCare: c, lambingRecords: l } = schema;
const dam = alias(animals, 'dam');
const foster = alias(animals, 'foster');

export const careInput = z.object({
  /** When the lamb took colostrum. Null clears a slip. */
  colostrumAt: z.iso.datetime({ offset: true }).nullish(),
  navelTreated: z.boolean().optional(),
  mothering: z.enum(LAMB_MOTHERING).optional(),
  /** The ewe raising the lamb. Needed for `fostered`, dropped for anything else. */
  fosterEweId: z.uuid().nullish(),
  notes: z.string().trim().max(500).nullish(),
});
export type CareInput = z.infer<typeof careInput>;

export type AttentionReason = 'no_colostrum' | 'bottle';

/** A care record is kept for young born on this farm: nobody saw a bought animal's first hours. */
async function lambOrThrow(lambId: string, opts: { lock?: boolean } = {}) {
  const lamb = await getAnimalOrThrow(lambId, opts);
  if (lamb.origin !== 'born') throw badRequest('NOT_BORN_HERE', `Animal ${lamb.tag} was not born on this farm`);
  return lamb;
}

async function careView(lambId: string) {
  const [row] = await tx()
    .select({
      lambId: animals.id,
      tag: animals.tag,
      birthDate: animals.birthDate,
      damId: animals.damId,
      damTag: dam.tag,
      recorded: sql<boolean>`${c.id} is not null`,
      colostrumAt: c.colostrumAt,
      navelTreated: sql<boolean>`coalesce(${c.navelTreated}, false)`,
      mothering: c.mothering,
      fosterEweId: c.fosterEweId,
      fosterEweTag: foster.tag,
      notes: c.notes,
    })
    .from(animals)
    .leftJoin(c, and(eq(c.lambId, animals.id), eq(c.farmId, animals.farmId)))
    .leftJoin(dam, eq(dam.id, animals.damId))
    .leftJoin(foster, eq(foster.id, c.fosterEweId))
    .where(and(eq(animals.id, lambId), eq(animals.farmId, ctx().farmId)));
  return row;
}

export async function getCare(lambId: string) {
  await lambOrThrow(lambId);
  return careView(lambId);
}

/** Create or correct the care record of one lamb. Fields left out keep what they had. */
export async function saveCare(lambId: string, i: CareInput) {
  const x = ctx();
  const lamb = await lambOrThrow(lambId, { lock: true });
  const [current] = await tx()
    .select()
    .from(c)
    .where(and(eq(c.lambId, lambId), eq(c.farmId, x.farmId)));

  let colostrumAt = current?.colostrumAt ?? null;
  if (i.colostrumAt !== undefined) {
    colostrumAt = i.colostrumAt ? new Date(i.colostrumAt) : null;
    // A phone clock that runs ahead must not lose the record: it counts from now.
    if (colostrumAt && colostrumAt.getTime() > Date.now()) colostrumAt = new Date();
    if (colostrumAt && lamb.birthDate && todayIso(x.timezone, colostrumAt) < lamb.birthDate) {
      throw badRequest('COLOSTRUM_BEFORE_BIRTH', 'Colostrum cannot be given before the lamb was born', { birthDate: lamb.birthDate });
    }
  }

  const mothering = i.mothering ?? current?.mothering ?? 'with_dam';
  let fosterEweId: string | null = null;
  if (mothering === 'fostered') {
    fosterEweId = i.fosterEweId ?? current?.fosterEweId ?? null;
    if (!fosterEweId) throw badRequest('FOSTER_EWE_REQUIRED', 'Choose the ewe the lamb was given to');
    if (fosterEweId !== current?.fosterEweId) {
      if (fosterEweId === lamb.damId) throw badRequest('FOSTER_IS_DAM', 'This ewe is the lamb\'s own dam: choose "with her dam" instead');
      const ewe = await getAnimalOrThrow(fosterEweId);
      if (ewe.sex !== 'female' || ewe.id === lamb.id) throw badRequest('ANIMAL_NOT_FEMALE', `Animal ${ewe.tag} is not a female`);
      if (!isOnFarm(ewe.status)) throw conflict('ANIMAL_NOT_ON_FARM', `Animal ${ewe.tag} is no longer on the farm`, { animalId: ewe.id, status: ewe.status });
    }
  }

  const values = {
    colostrumAt,
    navelTreated: i.navelTreated ?? current?.navelTreated ?? false,
    mothering,
    fosterEweId,
    notes: i.notes === undefined ? (current?.notes ?? null) : i.notes || null,
  };
  if (current) await tx().update(c).set(values).where(eq(c.id, current.id));
  else await tx().insert(c).values({ ...values, lambId, tenantId: x.tenantId, farmId: x.farmId, createdBy: x.userId });

  await recordEvent({
    type: 'animal.care_recorded',
    entityType: 'animal',
    entityId: lambId,
    data: { colostrum: colostrumAt !== null, navelTreated: values.navelTreated, mothering },
  });
  const motheringChanged = mothering !== (current?.mothering ?? 'with_dam') || fosterEweId !== (current?.fosterEweId ?? null);
  if (motheringChanged && mothering !== 'with_dam') {
    await recordEvent({
      type: mothering === 'fostered' ? 'animal.fostered' : 'animal.bottle_fed',
      entityType: 'animal',
      entityId: lambId,
      severity: 'attention',
      // The genetic dam is named so the journal shows whose lamb went where.
      data: { damId: lamb.damId, fosterEweId },
    });
  }
  return careView(lambId);
}

/**
 * Live lambs that need a person now: no colostrum on record some hours after birth, and orphans
 * on the bottle. The thresholds are the starting values in LAMBING_DESK.
 */
export async function lambsNeedingAttention(now: Date = new Date()) {
  const x = ctx();
  const day = today();
  const rows = await tx()
    .select({
      lambId: animals.id,
      tag: animals.tag,
      sex: animals.sex,
      birthDate: animals.birthDate,
      createdAt: animals.createdAt,
      damId: animals.damId,
      damTag: dam.tag,
      herdName: herds.name,
      facilityName: facilities.name,
      bornAt: l.bornAt,
      lambingRecordedAt: l.createdAt,
      colostrumAt: c.colostrumAt,
      navelTreated: c.navelTreated,
      mothering: c.mothering,
      fosterEweTag: foster.tag,
    })
    .from(animals)
    .leftJoin(c, and(eq(c.lambId, animals.id), eq(c.farmId, animals.farmId)))
    .leftJoin(dam, eq(dam.id, animals.damId))
    .leftJoin(foster, eq(foster.id, c.fosterEweId))
    .leftJoin(herds, eq(herds.id, animals.herdId))
    .leftJoin(facilities, sql`${facilities.id} = coalesce(${animals.facilityId}, ${herds.facilityId})`)
    // Her lambing: a ewe lambs once on a date, so dam and birth date name one record.
    .leftJoin(l, and(eq(l.farmId, animals.farmId), eq(l.eweId, animals.damId), eq(l.date, animals.birthDate)))
    .where(and(eq(animals.farmId, x.farmId), onFarm(), eq(animals.origin, 'born'), gte(animals.birthDate, addDays(day, -WEANING_DAYS))));

  const list = rows.flatMap((row) => {
    if (!row.birthDate) return [];
    const ageDays = diffDays(row.birthDate, day);
    const hoursOld = minHoursSinceBirth({
      birthDate: row.birthDate,
      bornAt: row.bornAt,
      recordedAt: row.lambingRecordedAt ?? row.createdAt,
      now,
      timeZone: x.timezone,
    });
    const flags = lambAttention({ hoursOld, ageDays, colostrumGiven: row.colostrumAt !== null, mothering: row.mothering });
    const reasons: AttentionReason[] = [...(flags.noColostrum ? (['no_colostrum'] as const) : []), ...(flags.bottle ? (['bottle'] as const) : [])];
    if (reasons.length === 0) return [];
    return [
      {
        lambId: row.lambId,
        tag: row.tag,
        sex: row.sex,
        birthDate: row.birthDate,
        ageDays,
        /** At least this old; the hour of birth itself is not recorded. */
        hoursOld: round(hoursOld, 1),
        damId: row.damId,
        damTag: row.damTag,
        herdName: row.herdName,
        facilityName: row.facilityName,
        colostrumAt: row.colostrumAt,
        navelTreated: row.navelTreated ?? false,
        mothering: row.mothering,
        fosterEweTag: row.fosterEweTag,
        reasons,
      },
    ];
  });
  // No colostrum first, and among those the one that has waited longest.
  list.sort((a, b) => Number(b.reasons.includes('no_colostrum')) - Number(a.reasons.includes('no_colostrum')) || b.hoursOld - a.hoursOld || a.tag.localeCompare(b.tag));
  return { colostrumHours: LAMBING_DESK.colostrumHours, lambs: list };
}
