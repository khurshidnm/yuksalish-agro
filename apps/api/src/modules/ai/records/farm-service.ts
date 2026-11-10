/**
 * The only way from a farm-record proposal into the books (docs/assistant.md, "Farm records"). Everything
 * here runs as the person. Confirm calls the owning module's own service, so its validation, journal
 * event and stock movement are the ones a manual entry gets. Nothing here writes a business table.
 *
 * What was true when the card was made may not be true when it is confirmed, so confirm decides again,
 * under a lock: the card the person read, the animal still on the farm, and the books as they stand.
 */
import { createHash } from 'node:crypto';
import { cancelWords } from '@yap/shared/formulas/record-words';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '../../../db/client';
import { assertPermission, ctx, hasPermission, tx } from '../../../core/context';
import { conflict, forbidden, notFound } from '../../../core/errors';
import { recordEvent } from '../../../core/journal';
import { createExit, undoExit } from '../../livestock/exits.service';
import { createDailyLog, deleteDailyLog } from '../../livestock/daily-logs.service';
import { createRecord as createHealthRecord, deleteRecord as deleteHealthRecord } from '../../livestock/health.service';
import { createWeight, deleteWeight } from '../../livestock/weights.service';
import type { FarmFields, FarmInput, FarmProposalView, UsedQuantity } from './farm-types';
import { alreadyInBooks, animalNow, validateFarm } from './farm-validate';
import { FARM_RECORD_KINDS, FARM_RULES, PROPOSAL_TTL_MS, UNDO_WINDOW_MS, type FarmRecordKind } from './routing';
import { canonical } from './service';
import type { DraftEnv, Question } from './types';

const { aiProposals: t } = schema;
type Row = typeof t.$inferSelect;

const SOURCE_TEXT_LIMIT = 1000;

/** The card's fields, and beside them what the card is about and the words and quantities it rests on. */
type StoredFields = FarmFields & {
  _key: string | null;
  _used: UsedQuantity[];
  _texts: string[];
  _days: (string | null)[];
  /** A correction that raised a question. The card keeps showing what was last complete. */
  _pending?: boolean;
};

const stored = (row: Row) => row.fields as unknown as StoredFields;
const isFarm = inArray(t.kind, [...FARM_RECORD_KINDS]);

export const isFarmKind = (kind: string): kind is FarmRecordKind => (FARM_RECORD_KINDS as readonly string[]).includes(kind);

/** The right the manual screen of the owning module asks for. */
export const mayDraftFarm = (kind: FarmRecordKind) => FARM_RULES[kind].create.every((permission) => hasPermission(permission));

function assertMayWrite(kind: FarmRecordKind) {
  for (const permission of FARM_RULES[kind].create) assertPermission(permission);
}

export function farmView(row: Row): FarmProposalView {
  const { _key, _used, _texts, _days, _pending, ...fields } = stored(row);
  const kind = row.kind as FarmRecordKind;
  const now = new Date();
  const expired = row.status === 'pending' && row.expiresAt < now;
  const undo = FARM_RULES[kind].undo;
  const undoOpen = row.status === 'confirmed' && row.undoUntil !== null && row.undoUntil > now;
  return {
    id: row.id,
    kind,
    status: expired ? 'expired' : (row.status as FarmProposalView['status']),
    channel: row.channel,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    undoUntil: row.undoUntil?.toISOString() ?? null,
    sourceText: row.sourceText,
    stamp: createHash('sha256').update(canonical({ kind, fields })).digest('hex').slice(0, 12),
    fields,
    warnings: row.warnings,
    needsAnswer: Boolean(_pending),
    canConfirm: FARM_RULES[kind].create.every((permission) => hasPermission(permission)),
    canUndo: undoOpen && undo !== null && hasPermission(undo),
    result: row.resultType && row.resultId ? { type: row.resultType, id: row.resultId } : null,
  };
}

export type FarmDraftOutcome =
  | { status: 'ready'; proposal: FarmProposalView; replaced: boolean }
  | { status: 'needs_info'; questions: Question[] };

const inConversation = (conversationId: string | null) => (conversationId ? eq(t.conversationId, conversationId) : isNull(t.conversationId));

/** This person's farm cards of the conversation that still stand: waiting, or confirmed a moment ago. */
async function standing(conversationId: string | null, lock: boolean): Promise<Row[]> {
  const c = ctx();
  const query = tx()
    .select()
    .from(t)
    .where(
      and(
        eq(t.farmId, c.farmId),
        eq(t.userId, c.userId!),
        inConversation(conversationId),
        isFarm,
        inArray(t.status, ['pending', 'confirmed']),
        gt(t.expiresAt, new Date(Date.now() - PROPOSAL_TTL_MS)),
      ),
    )
    .orderBy(asc(t.createdAt));
  const rows = await (lock ? query.for('update') : query);
  const now = new Date();
  return rows.filter((row) => row.status === 'confirmed' || row.expiresAt > now);
}

/** The words a card was made from, with what was said since: a correction leans on both. */
function withCardWords(env: DraftEnv, card: StoredFields): DraftEnv {
  const texts = card._texts ?? [];
  const kept = texts.map((text, i) => ({ text, day: card._days?.[i] ?? undefined })).filter(({ text }) => !env.userTexts.includes(text));
  return {
    ...env,
    userTexts: [...kept.map((k) => k.text), ...env.userTexts],
    saidDays: [...kept.map((k) => k.day), ...(env.saidDays ?? env.userTexts.map(() => undefined))],
  };
}

const usedBy = (rows: Row[]) => rows.flatMap((row) => stored(row)._used ?? []);

/**
 * Check a draft and keep it as a pending card. A draft that names a card (`proposalId`), or is about the
 * same thing as a waiting card (the same animal's weight, the same herd's day), is the person correcting
 * that card, so it changes it. A correction that cannot stand leaves the card waiting for an answer:
 * it shows a value they just took back, so it cannot be confirmed until the answer comes.
 */
export async function saveFarmDraft(kind: FarmRecordKind, input: FarmInput, env: DraftEnv, proposalId?: string): Promise<FarmDraftOutcome> {
  assertMayWrite(kind);
  const c = ctx();
  const cards = await standing(env.conversationId, true);
  let existing = proposalId ? cards.find((row) => row.id === proposalId && row.status === 'pending' && row.kind === kind) : undefined;
  if (proposalId && !existing) throw notFound('Draft');

  const check = (card: Row | undefined) =>
    validateFarm(kind, input, card ? withCardWords(env, stored(card)) : env, usedBy(cards.filter((row) => row !== card)));
  let checked = await check(existing);
  if (!existing && checked.key !== null) {
    existing = cards.find((row) => row.status === 'pending' && row.kind === kind && stored(row)._key === checked.key);
    // Its own quantity is not taken from it.
    if (existing) checked = await check(existing);
  }

  if (checked.questions.length > 0) {
    if (existing) {
      await tx()
        .update(t)
        .set({ fields: { ...stored(existing), _pending: true } as unknown as Record<string, unknown> })
        .where(and(eq(t.id, existing.id), eq(t.status, 'pending')));
    }
    return { status: 'needs_info', questions: checked.questions };
  }

  const words = existing ? withCardWords(env, stored(existing)) : env;
  const values = {
    fields: {
      ...checked.fields,
      _key: checked.key,
      _used: checked.used,
      _texts: words.userTexts,
      _days: words.userTexts.map((_, i) => words.saidDays?.[i] ?? null),
    } as unknown as Record<string, unknown>,
    warnings: checked.warnings,
    sourceText: words.userTexts.join(' / ').slice(0, SOURCE_TEXT_LIMIT),
  };
  const [row] = existing
    ? await tx().update(t).set(values).where(and(eq(t.id, existing.id), eq(t.status, 'pending'))).returning()
    : await tx()
        .insert(t)
        .values({
          ...values,
          learn: [],
          tenantId: c.tenantId,
          farmId: c.farmId,
          createdBy: c.userId,
          userId: c.userId!,
          conversationId: env.conversationId,
          kind,
          channel: env.channel,
          expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
        })
        .returning();
  if (!row) throw notFound('Draft');
  return { status: 'ready', proposal: farmView(row), replaced: Boolean(existing) };
}

/**
 * Null when the words never asked for it. Runs as the AI, which cannot write the journal, so the caller
 * records the event as the person.
 */
export async function cancelFarmDraft(id: string, conversationId: string | null, said: string): Promise<FarmRecordKind | null> {
  const c = ctx();
  const [row] = await tx()
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.farmId, c.farmId), eq(t.userId, c.userId!), eq(t.status, 'pending'), gt(t.expiresAt, new Date()), isFarm))
    .for('update');
  if (!row || row.conversationId !== conversationId) throw notFound('Draft');
  if (!cancelWords(said)) return null;
  await tx().update(t).set({ status: 'rejected' }).where(eq(t.id, row.id));
  return row.kind as FarmRecordKind;
}

export async function listFarmPending(): Promise<FarmProposalView[]> {
  const c = ctx();
  const rows = await tx()
    .select()
    .from(t)
    .where(and(eq(t.farmId, c.farmId), eq(t.userId, c.userId!), eq(t.status, 'pending'), gt(t.expiresAt, new Date()), isFarm))
    .orderBy(asc(t.createdAt));
  return rows.map(farmView);
}

/** Cards of this conversation, for the model to tell apart: waiting ones, and confirmed ones that can still be undone. */
export async function farmConversationCards(conversationId: string): Promise<FarmProposalView[]> {
  const views = (await standing(conversationId, false)).map(farmView);
  return views.filter((view) => view.status === 'pending' || view.canUndo);
}

async function own(id: string, lock = false): Promise<Row> {
  const query = tx().select().from(t).where(and(eq(t.id, id), eq(t.farmId, ctx().farmId), isFarm));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw notFound('Proposal');
  if (row.userId !== ctx().userId) throw forbidden('This belongs to someone else', 'NOT_YOUR_PROPOSAL');
  return row;
}

export const getFarmProposal = async (id: string): Promise<FarmProposalView> => farmView(await own(id));

const stale = (view: FarmProposalView) => conflict('PROPOSAL_STALE', 'Something on this card has changed since it was made. Please check it', { proposal: view });

/** The books as they stand now: what the card points at is still there, and the record is not there yet. */
async function recheck(kind: FarmRecordKind, view: FarmProposalView): Promise<void> {
  const f = view.fields;
  // First, because it is the plainer answer: a death already recorded has also taken the animal off the farm.
  if (await alreadyInBooks(kind, f)) throw conflict('FARM_RECORD_EXISTS', 'This is already in the books', { proposal: view });
  if (f.animal) {
    const now = await animalNow(f.animal.id, f.date);
    if (!now || !now.onFarm || now.animal.tag !== f.animal.tag) throw stale(view);
  }
  const farm = ctx().farmId;
  const { herds, items, warehouses } = schema;
  if (f.herd) {
    const [herd] = await tx().select({ status: herds.status }).from(herds).where(and(eq(herds.id, f.herd.id), eq(herds.farmId, farm)));
    if (!herd || herd.status === 'archived') throw stale(view);
  }
  for (const line of f.stockOut) {
    const [item] = await tx().select({ unit: items.unit, active: items.active }).from(items).where(and(eq(items.id, line.itemId), eq(items.farmId, farm)));
    // The quantity on the card is in the unit the item had when the card was made.
    if (!item || !item.active || item.unit !== line.unit) throw stale(view);
    if (!line.warehouse) continue;
    const [warehouse] = await tx().select({ active: warehouses.active }).from(warehouses).where(and(eq(warehouses.id, line.warehouse.id), eq(warehouses.farmId, farm)));
    if (!warehouse || !warehouse.active) throw stale(view);
  }
}

/** Each kind goes through the service a person's manual entry would use. */
async function write(kind: FarmRecordKind, f: FarmFields): Promise<{ type: string; id: string }> {
  switch (kind) {
    case 'weight': {
      const row = await createWeight({ animalId: f.animal!.id, date: f.date, weightKg: f.weightKg! });
      return { type: 'weight_record', id: row.id };
    }
    case 'death': {
      // The exits service asks for `livestock.create` itself and takes the animal out of the flock.
      const row = await createExit({ animalId: f.animal!.id, type: 'death', date: f.date, reason: f.cause });
      return { type: 'animal_exit', id: row.id };
    }
    case 'treatment': {
      // The health service takes the drug from the warehouse and sets the withdrawal date, as its own screen does.
      const line = f.stockOut.at(0);
      const row = await createHealthRecord({
        type: f.healthType ?? 'treatment',
        animalId: f.animal?.id ?? null,
        herdId: f.animal ? null : f.herd!.id,
        date: f.date,
        diagnosis: f.cause,
        itemId: line?.itemId ?? null,
        warehouseId: line?.warehouse?.id ?? null,
        qtyUsed: line?.qty ?? null,
        dose: f.dose,
        doseUnit: f.doseUnit,
        // A drug the warehouse does not keep stands in the notes, as they named it.
        notes: line ? null : (f.drug?.name ?? null),
      });
      return { type: 'health_record', id: row.id };
    }
    case 'herd_log': {
      // The daily log takes each feed from the warehouse it chooses by its own rule and charges it to the herd.
      const row = await createDailyLog({
        herdId: f.herd!.id,
        date: f.date,
        lines: f.stockOut.map((line) => ({ itemId: line.itemId, warehouseId: line.warehouse?.id ?? null, actualQty: line.qty })),
      });
      return { type: 'daily_log', id: row.id };
    }
  }
}

async function takeBack(kind: FarmRecordKind, id: string): Promise<void> {
  switch (kind) {
    case 'weight':
      await deleteWeight(id);
      return;
    case 'death':
      // Puts the animal back, and reopens the pregnancy and the sick report the death closed.
      await undoExit(id);
      return;
    case 'treatment':
      // Returns the drug to the warehouse.
      await deleteHealthRecord(id);
      return;
    case 'herd_log':
      // Returns the feed to the warehouse.
      await deleteDailyLog(id);
      return;
  }
}

export async function confirmFarmProposal(id: string, input: { stamp: string }): Promise<FarmProposalView> {
  // The row lock makes a double tap safe: the second sees it confirmed and stops.
  const row = await own(id, true);
  if (row.status !== 'pending') throw conflict('PROPOSAL_NOT_PENDING', 'This has already been handled');
  if (row.expiresAt < new Date()) throw conflict('PROPOSAL_EXPIRED', 'This draft has expired. Please say it again');
  const kind = row.kind as FarmRecordKind;
  // The owning service's route would ask for this; some of those services leave the check to the route.
  assertMayWrite(kind);
  // One at a time per farm: two cards about one animal must each see what the other just wrote.
  await tx().execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ai-confirm:${ctx().farmId}`}, 0))`);

  if (stored(row)._pending) throw conflict('PROPOSAL_NEEDS_ANSWER', 'A correction to this card is waiting for an answer');
  const view = farmView(row);
  if (input.stamp !== view.stamp) throw conflict('PROPOSAL_CHANGED', 'This card has changed since you read it', { proposal: view });
  await recheck(kind, view);

  const written = await write(kind, view.fields);
  const undo = FARM_RULES[kind].undo;
  const now = new Date();
  const [updated] = await tx()
    .update(t)
    .set({
      status: 'confirmed',
      confirmedAt: now,
      undoUntil: undo !== null && hasPermission(undo) ? new Date(now.getTime() + UNDO_WINDOW_MS) : null,
      resultType: written.type,
      resultId: written.id,
    })
    .where(eq(t.id, id))
    .returning();
  await recordEvent({
    type: 'ai_proposal.confirmed',
    entityType: 'ai_proposal',
    entityId: id,
    data: { kind, resultType: written.type, resultId: written.id, channel: row.channel },
  });
  return farmView(updated);
}

export async function rejectFarmProposal(id: string): Promise<FarmProposalView> {
  const row = await own(id, true);
  if (row.status !== 'pending') throw conflict('PROPOSAL_NOT_PENDING', 'This has already been handled');
  const [updated] = await tx().update(t).set({ status: 'rejected' }).where(eq(t.id, id)).returning();
  await recordEvent({ type: 'ai_proposal.rejected', entityType: 'ai_proposal', entityId: id, data: { kind: row.kind, by: 'person' } });
  return farmView(updated);
}

/** Takes the record back the way its own screen would: through the owning service's delete. */
export async function undoFarmProposal(id: string): Promise<FarmProposalView> {
  const row = await own(id, true);
  if (row.status !== 'confirmed') throw conflict('PROPOSAL_NOT_CONFIRMED', 'Only a confirmed record can be undone');
  if (!row.undoUntil || row.undoUntil < new Date()) throw conflict('UNDO_EXPIRED', 'It is too late to undo this here');
  const kind = row.kind as FarmRecordKind;
  const undo = FARM_RULES[kind].undo;
  if (undo === null || !row.resultId) throw conflict('UNDO_IMPOSSIBLE', 'This record cannot be undone here');
  assertPermission(undo);
  await takeBack(kind, row.resultId);
  const [updated] = await tx().update(t).set({ status: 'undone', undoUntil: null }).where(eq(t.id, id)).returning();
  await recordEvent({ type: 'ai_proposal.undone', entityType: 'ai_proposal', entityId: id, data: { kind } });
  return farmView(updated);
}
