/**
 * Exact lookup of animals by what a camera, a hand scanner or a scale file read: the ear tag or an
 * active identifier (RFID, QR, second ear tag). Letter case and spaces do not count; nothing looser
 * does. A code that two animals carry returns both, and the person chooses: unlike `findByCode`,
 * which serves typing and may take "123" for YA-0123, nothing here settles a doubt on its own.
 *
 * The same rules decide what a printed tag carries (`animalLabelCode`), so a tag printed here is
 * always found here.
 */
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { SCAN_CODE_MAX, animalLabelCode, matchScan, normalizeScan, scanKey, scanKeyVariants } from '@yap/shared/formulas/scan-code';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { badRequest } from '../../core/errors';
import { assertInFarm, isOnFarm, onFarm } from './refs';

const { animalIdentifiers: identifiers, animals, herds, species } = schema;

/** A scan may arrive as a whole web address; the code inside it is what must fit the registry. */
const scanned = z.string().trim().min(1).max(500);

export const byCodeQuery = z.object({ code: scanned });
export const matchCodesInput = z.object({ codes: z.array(scanned).min(1).max(1000) });
export const tagLabelsInput = z
  .object({
    /** The animals picked in the registry. */
    ids: z.array(z.uuid()).min(1).max(2000).optional(),
    /** Or every animal now in one herd. */
    herdId: z.uuid().optional(),
  })
  .refine((v) => Boolean(v.ids) !== Boolean(v.herdId), { message: 'Give either ids or herdId' });

export interface CodeMatch {
  id: string;
  tag: string;
  status: string;
  onFarm: boolean;
  herdId: string | null;
  herdName: string | null;
  category: string;
  sex: string;
  speciesKey: string | null;
  birthDate: string | null;
  /** 'tag', or the type of the identifier that carried the code: 'rfid', 'qr', 'ear_tag'. */
  matchedBy: string;
  /** Letter for letter the same, not only apart from case and spaces. */
  exact: boolean;
}

/** The comparison key of scan-code.ts, in SQL: upper case, no spaces. */
const keyOf = (column: AnyPgColumn) => sql`upper(regexp_replace(${column}, '\\s+', '', 'g'))`;

interface Candidate {
  animalId: string;
  value: string;
  matchedBy: string;
}

async function candidatesFor(codes: string[]): Promise<Candidate[]> {
  const keys = [...new Set(codes.flatMap(scanKeyVariants))];
  if (keys.length === 0) return [];
  const farmId = ctx().farmId;
  const carries = (column: AnyPgColumn) => or(inArray(column, codes), inArray(keyOf(column), keys));

  const byTag = await tx()
    .select({ animalId: animals.id, value: animals.tag })
    .from(animals)
    .where(and(eq(animals.farmId, farmId), carries(animals.tag)))
    .orderBy(asc(animals.tag), asc(animals.id));
  const byIdentifier = await tx()
    .select({ animalId: identifiers.animalId, value: identifiers.value, type: identifiers.type })
    .from(identifiers)
    .innerJoin(animals, eq(animals.id, identifiers.animalId))
    // A tag taken out of use no longer names its animal.
    .where(and(eq(animals.farmId, farmId), eq(identifiers.active, true), carries(identifiers.value)))
    .orderBy(asc(animals.tag), asc(animals.id));

  return [...byTag.map((row) => ({ ...row, matchedBy: 'tag' })), ...byIdentifier.map((row) => ({ animalId: row.animalId, value: row.value, matchedBy: row.type }))];
}

/** Every code with the animals that carry it. A code no animal carries has an empty list. */
export async function matchCodes(input: string[]): Promise<{ code: string; matches: CodeMatch[] }[]> {
  const codes = [...new Set(input.map((raw) => normalizeScan(raw)).filter((code): code is string => code !== null))];
  const candidates = await candidatesFor(codes);

  const byKey = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = scanKey(candidate.value);
    byKey.set(key, [...(byKey.get(key) ?? []), candidate]);
  }
  const found = codes.map((code) => {
    const near = scanKeyVariants(code).flatMap((key) => byKey.get(key) ?? []);
    // matchScan lists an item once, and items are compared by identity: one object per animal.
    const perAnimal = new Map<string, { animalId: string }>();
    const options = near.map((c) => {
      if (!perAnimal.has(c.animalId)) perAnimal.set(c.animalId, { animalId: c.animalId });
      return { value: c.value, item: perAnimal.get(c.animalId)!, matchedBy: c.matchedBy };
    });
    const hits = matchScan(code, options).map((hit) => ({
      animalId: hit.item.animalId,
      exact: hit.exact,
      matchedBy: options.find((o) => o.item === hit.item && o.value === hit.value)!.matchedBy,
    }));
    return { code, hits };
  });

  const ids = [...new Set(found.flatMap((f) => f.hits.map((h) => h.animalId)))];
  const rows = ids.length
    ? await tx()
        .select({
          id: animals.id,
          tag: animals.tag,
          status: animals.status,
          herdId: animals.herdId,
          herdName: herds.name,
          category: animals.category,
          sex: animals.sex,
          speciesKey: species.key,
          birthDate: animals.birthDate,
        })
        .from(animals)
        .leftJoin(herds, eq(herds.id, animals.herdId))
        .leftJoin(species, eq(species.id, animals.speciesId))
        .where(and(eq(animals.farmId, ctx().farmId), inArray(animals.id, ids)))
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));

  return found.map(({ code, hits }) => ({
    code,
    matches: hits.flatMap((hit) => {
      const row = byId.get(hit.animalId);
      return row ? [{ ...row, onFarm: isOnFarm(row.status), matchedBy: hit.matchedBy, exact: hit.exact }] : [];
    }),
  }));
}

/** One scan. An empty list means no animal carries the code: the caller says so, and offers a search. */
export async function byCode(raw: string): Promise<CodeMatch[]> {
  const code = normalizeScan(raw);
  if (code === null) throw badRequest('SCAN_UNREADABLE', `The scan holds no code of at most ${SCAN_CODE_MAX} characters`);
  const [result] = await matchCodes([code]);
  return result?.matches ?? [];
}

/**
 * What to print on each animal's tag: the code (one rule, `animalLabelCode`), the number to read
 * with the eye, and the herd. No price, no owner, no person: a tag hangs where anyone can read it.
 */
export async function tagLabels(input: z.infer<typeof tagLabelsInput>) {
  const farmId = ctx().farmId;
  if (input.herdId) await assertInFarm(herds, input.herdId, 'Herd');
  const rows = await tx()
    .select({ id: animals.id, tag: animals.tag, herdName: herds.name })
    .from(animals)
    .leftJoin(herds, eq(herds.id, animals.herdId))
    .where(and(eq(animals.farmId, farmId), input.herdId ? and(eq(animals.herdId, input.herdId), onFarm()) : inArray(animals.id, input.ids!)))
    .orderBy(asc(animals.tag), asc(animals.id))
    .limit(5000);
  if (rows.length === 0) return [];

  const qrs = await tx()
    .select({ animalId: identifiers.animalId, value: identifiers.value })
    .from(identifiers)
    .innerJoin(animals, eq(animals.id, identifiers.animalId))
    .where(
      and(
        eq(animals.farmId, farmId),
        eq(identifiers.type, 'qr'),
        eq(identifiers.active, true),
        input.herdId ? eq(animals.herdId, input.herdId) : inArray(identifiers.animalId, input.ids!),
      ),
    )
    // The newest one is the one on the ear now.
    .orderBy(desc(identifiers.createdAt), asc(identifiers.value));
  const qrOf = new Map<string, string>();
  for (const row of qrs) if (!qrOf.has(row.animalId)) qrOf.set(row.animalId, row.value);

  return rows.map((row) => ({ ...row, code: animalLabelCode({ tag: row.tag, qr: qrOf.get(row.id) ?? null }) }));
}
