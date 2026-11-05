/**
 * The only way from a proposal into the books. Everything here runs as the person, and confirm
 * goes through the same services as manual entry, so permissions, validation and maker-checker
 * cannot be bypassed by coming through the assistant (docs/assistant.md).
 *
 * What was true when a draft was made may not be true when it is confirmed, so confirm decides again,
 * under a lock: it books the card the person read, re-checks everything it points at, and looks
 * for duplicates in the books as they stand at that moment.
 */
import { createHash } from 'node:crypto';
import { cancelWords } from '@yap/shared/formulas/record-words';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { schema } from '../../../db/client';
import { assertPermission, ctx, hasPermission, tx } from '../../../core/context';
import { conflict, forbidden, notFound } from '../../../core/errors';
import { recordEvent, type EventInput } from '../../../core/journal';
import { deleteUnapprovedTransactions, voidTransactions } from '../../../core/ledger';
import * as debts from '../../finance/debts.service';
import * as transactions from '../../finance/transactions.service';
import { createReceipt, reverseReceipt } from '../../inventory/stock.service';
import { tr } from '../../notifications/i18n';
import { notifyUser } from '../../notifications/notify.service';
import { findDuplicate, type Duplicate } from './duplicates';
import { normalize } from './resolve';
import { ACKNOWLEDGE_WARNINGS, PROPOSAL_TTL_MS, UNDO_WINDOW_MS, type RecordKind } from './routing';
import type { DraftEnv, DraftRecord, Learned, ProposalFields, ProposalView, Question, Warning } from './types';
import { mergeDraft, validateDraft, type DraftInput } from './validate';

const { aiAliases, aiProposals: t, transactions: ledger } = schema;
type Row = typeof t.$inferSelect;

const SOURCE_TEXT_LIMIT = 1000;

/** Stored fields also keep the settled input, so a change can be re-validated from the start. */
type StoredFields = ProposalFields & {
  _input: DraftInput;
  /** A correction waiting for an answer. The card keeps showing what was last complete. */
  _pending?: DraftInput;
  _receipt?: string;
  _transactionIds?: string[];
};

const stored = (row: Row) => row.fields as unknown as StoredFields;

/**
 * A correction goes on waiting until the form has set everything it would have changed, so a note typed
 * beside it cannot make the card confirmable with the value the person just took back.
 */
function stillWaiting({ _input: settled, _pending: waiting }: StoredFields, typed: DraftInput): DraftInput | undefined {
  if (!waiting) return undefined;
  const changed = (Object.keys({ ...settled, ...waiting }) as (keyof DraftInput)[]).filter((key) => key !== 'heardAs' && waiting[key] !== settled[key]);
  return changed.some((key) => !(key in typed)) ? mergeDraft(waiting, typed) : undefined;
}

function visible(row: Row): ProposalFields {
  const { _input, _pending, _receipt, _transactionIds, ...fields } = stored(row);
  return fields;
}

/** The same bytes for the same content, whatever order the keys came back from the database in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'null';
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(',')}}`;
}

/** What the person read: the fields, and which warnings a yes would answer. A new one means reading it again. */
function stampOf(fields: ProposalFields, warnings: Warning[]): string {
  const yes = [...new Set(warnings.map((w) => w.code).filter((code) => ACKNOWLEDGE_WARNINGS.has(code)))].sort();
  return createHash('sha256').update(canonical({ fields, yes })).digest('hex').slice(0, 12);
}

/** What the record does, leaving out names: a renamed account is still the same account. */
function substance(f: ProposalFields) {
  const id = (ref: { id: string } | null) => ref?.id ?? null;
  return canonical({
    amount: f.amount, currency: f.currency, fxRate: f.fxRate, amountBase: f.amountBase, date: f.date, qty: f.qty,
    category: id(f.category), target: f.target?.costCenterId ?? null, account: id(f.account), toAccount: id(f.toAccount),
    method: f.paymentMethod, counterparty: id(f.counterparty), item: id(f.item), warehouse: id(f.warehouse),
    treatment: f.costTreatment, direction: f.direction,
  });
}

const hiddenFields = (f: ProposalFields): ProposalFields => ({
  ...f, amount: null, amountBase: null, unitPrice: null, fxRate: null, account: null, toAccount: null, counterparty: null,
  paymentMethod: null, direction: null, description: null,
});

/** These are about the amount, so a change that leaves it alone leaves them standing. */
const ABOUT_THE_AMOUNT = new Set(['OTHER_AMOUNT', 'AMOUNT_FROM_DOCUMENT']);

function carryWarnings(row: Row, fields: ProposalFields, fresh: Warning[]): Warning[] {
  if (stored(row).amount !== fields.amount) return fresh;
  return [...fresh, ...row.warnings.filter((w) => ABOUT_THE_AMOUNT.has(w.code) && !fresh.some((f) => f.code === w.code))];
}

/** The status at confirm goes stale when a second person acts, so a confirmed card asks the books. */
async function liveResult(row: Row) {
  if (!row.resultId) return { status: row.resultStatus ?? '', entry: null };
  const [entry] = await tx()
    .select({ status: ledger.status, amount: ledger.amount, amountBase: ledger.amountBase })
    .from(ledger)
    .where(eq(ledger.id, row.resultId));
  // Gone means someone deleted it while it waited: it is not in the books.
  return { status: entry?.status ?? 'rejected', entry: entry ?? null };
}

const duplicateWarning = (hit: Duplicate): Warning => ({ code: 'POSSIBLE_DUPLICATE', params: { ...hit } });

export async function toView(row: Row): Promise<ProposalView> {
  const fields = visible(row);
  const c = ctx();
  const expired = row.status === 'pending' && row.expiresAt < new Date();
  const open = row.status === 'pending' && !expired;
  const duplicate = open ? await findDuplicate(row.kind as RecordKind, fields, row.id) : null;
  const warnings = [...row.warnings, ...(duplicate ? [duplicateWarning(duplicate)] : [])];
  const masked = !hasPermission('finance.view');
  const { status, entry } = await liveResult(row);
  // Finance may have edited the record since: the card says what the books say.
  const shown = entry ? { ...fields, amount: entry.amount, amountBase: entry.amountBase } : fields;
  const reversed = status === 'rejected';
  return {
    id: row.id,
    kind: row.kind as RecordKind,
    status: expired ? 'expired' : (row.status as ProposalView['status']),
    channel: row.channel as ProposalView['channel'],
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    undoUntil: reversed ? null : (row.undoUntil?.toISOString() ?? null),
    sourceText: masked ? '' : row.sourceText,
    stamp: stampOf(fields, warnings),
    masked,
    fields: masked ? hiddenFields(shown) : shown,
    warnings: masked ? [] : warnings,
    learning: masked ? [] : row.learn.map((l) => ({ phrase: l.phrase, name: (l as Learned).name })),
    needsAcknowledgement: warnings.some((w) => ACKNOWLEDGE_WARNINGS.has(w.code)),
    needsAnswer: Boolean(stored(row)._pending),
    willNeedApproval: !masked && c.settings.finance.makerChecker && fields.amountBase! >= c.settings.finance.approvalThreshold,
    result: row.resultType && row.resultId ? { type: row.resultType, id: row.resultId, status } : null,
  };
}

export type DraftOutcome =
  | { status: 'ready'; proposal: ProposalView; record: DraftRecord }
  | { status: 'needs_info'; questions: Question[]; record: DraftRecord };

/** Rule 10. `changed` names the fields, not their values, so the journal stays readable to everyone who reads it. */
export const changedEvent = (view: ProposalView, changed: string[], by: 'chat' | 'person'): EventInput => ({
  type: 'ai_proposal.changed', entityType: 'ai_proposal', entityId: view.id, data: { kind: view.kind, changed, by },
});

function assertMayWrite(kind: RecordKind) {
  assertPermission('finance.create');
  assertPermission('finance.view');
  if (kind === 'stock_purchase') assertPermission('inventory.create');
}

/** A draft of this person on this farm that can still be changed, locked against anything else doing so. */
async function openDraft(id: string, conversationId: string | null): Promise<Row> {
  const c = ctx();
  const [row] = await tx()
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.farmId, c.farmId), eq(t.userId, c.userId!), eq(t.status, 'pending'), gt(t.expiresAt, new Date())))
    .for('update');
  // Only cards of this conversation: a correction must not land on another conversation's card.
  if (!row || row.conversationId !== conversationId) throw notFound('Draft');
  return row;
}

/**
 * Validate a draft and keep it as a pending proposal. A new draft is always a new card: two real
 * records at the same price must both reach the person, and if it really is the same thing twice,
 * the duplicate check asks. Only an explicit `proposalId` changes an existing card.
 */
export async function saveDraft(kind: RecordKind, input: DraftInput, env: DraftEnv, proposalId?: string): Promise<DraftOutcome> {
  const c = ctx();
  const existing = proposalId ? await openDraft(proposalId, env.conversationId) : undefined;
  const effective = (existing?.kind as RecordKind) ?? kind;
  assertMayWrite(effective);
  const before = existing ? stored(existing) : undefined;
  const merged: DraftInput = before ? mergeDraft(before._pending ?? before._input, input) : input;
  const checked = await validateDraft(effective, merged, env, before?._input);

  if (!checked.fields) {
    // Until this is answered, the card must not be confirmable with the value they just took back.
    if (existing) {
      await tx()
        .update(t)
        .set({ fields: { ...before, _pending: merged } as unknown as Record<string, unknown> })
        .where(and(eq(t.id, existing.id), eq(t.status, 'pending')));
    }
    return { status: 'needs_info', questions: checked.questions, record: checked.record };
  }

  const values = {
    fields: { ...checked.fields, _input: checked.input } as unknown as Record<string, unknown>,
    warnings: existing ? carryWarnings(existing, checked.fields, checked.warnings) : checked.warnings,
    learn: checked.learn,
  };
  const [row] = existing
    ? await tx().update(t).set(values).where(and(eq(t.id, existing.id), eq(t.status, 'pending'))).returning()
    : await tx()
        .insert(t)
        .values({
          ...values,
          tenantId: c.tenantId,
          farmId: c.farmId,
          createdBy: c.userId,
          userId: c.userId!,
          conversationId: env.conversationId,
          kind,
          channel: env.channel,
          sourceText: env.userTexts.join(' / ').slice(0, SOURCE_TEXT_LIMIT),
          expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
        })
        .returning();
  if (!row) throw notFound('Draft');
  return { status: 'ready', proposal: await toView(row), record: checked.record };
}

/**
 * Null when the words never asked for it: a model's reading of "rahmat" must not take a card away. Runs as
 * the AI, which cannot write the journal, so the caller records the event as the person.
 */
export async function cancelDraft(id: string, conversationId: string | null, said: string): Promise<string | null> {
  const row = await openDraft(id, conversationId);
  if (!cancelWords(said)) return null;
  await tx().update(t).set({ status: 'rejected' }).where(eq(t.id, row.id));
  return row.kind;
}

/**
 * The money or the words on a card that the exchange left out, after the turn that made it: "5 mln berdim,
 * 200 ming qaytdi" drafted as 5 mln must not pass as if the 200 ming had never been said.
 */
export async function flagOtherAmounts(flags: { id: string; amounts: number[] }[]): Promise<void> {
  for (const { id, amounts } of flags) {
    const [row] = await tx().select().from(t).where(and(eq(t.id, id), eq(t.status, 'pending'))).for('update');
    if (!row) continue;
    const warnings = [...row.warnings.filter((w) => w.code !== 'OTHER_AMOUNT'), { code: 'OTHER_AMOUNT', params: { amounts } }];
    await tx().update(t).set({ warnings }).where(eq(t.id, id));
  }
}

export async function listPending(): Promise<ProposalView[]> {
  const c = ctx();
  const rows = await tx()
    .select()
    .from(t)
    .where(and(eq(t.farmId, c.farmId), eq(t.userId, c.userId!), eq(t.status, 'pending'), gt(t.expiresAt, new Date())))
    .orderBy(asc(t.createdAt));
  const views: ProposalView[] = [];
  for (const row of rows) views.push(await toView(row));
  return views;
}

/** Cards in this conversation, for the model to tell apart. Confirmed ones can still be undone. */
export async function conversationCards(conversationId: string) {
  const c = ctx();
  const rows = await tx()
    .select()
    .from(t)
    .where(and(eq(t.farmId, c.farmId), eq(t.userId, c.userId!), eq(t.conversationId, conversationId), gt(t.expiresAt, new Date(Date.now() - PROPOSAL_TTL_MS))))
    .orderBy(asc(t.createdAt));
  const now = new Date();
  const views: ProposalView[] = [];
  for (const row of rows) {
    const open = row.status === 'pending' && row.expiresAt > now;
    const undoable = row.status === 'confirmed' && row.undoUntil !== null && row.undoUntil > now;
    if (open || undoable) views.push(await toView(row));
  }
  return views;
}

async function own(id: string, lock = false): Promise<Row> {
  const query = tx().select().from(t).where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw notFound('Proposal');
  if (row.userId !== ctx().userId) throw forbidden('This belongs to someone else', 'NOT_YOUR_PROPOSAL');
  return row;
}

export const getProposal = async (id: string): Promise<ProposalView> => toView(await own(id));

function assertOpen(row: Row): void {
  if (row.status !== 'pending') throw conflict('PROPOSAL_NOT_PENDING', 'This has already been handled');
  if (row.expiresAt < new Date()) throw conflict('PROPOSAL_EXPIRED', 'This draft has expired. Please say it again');
}

interface Written {
  type: string;
  id: string;
  status: string;
  transactionIds: string[];
  receipt?: string;
}

/** Each kind goes through the service a person's manual entry would use. */
async function write(kind: RecordKind, f: ProposalFields, proposalId: string): Promise<Written> {
  const source = { type: 'ai_proposal', id: proposalId };
  if (kind === 'stock_purchase') {
    const receipt = await createReceipt({
      warehouseId: f.warehouse!.id,
      date: f.date,
      source: 'purchase',
      counterpartyId: f.counterparty?.id ?? null,
      currency: f.currency as never,
      fxRate: f.fxRate,
      notes: f.description,
      // Exact, not the rounded unitPrice on the card: the money must come to the stated total.
      lines: [{ itemId: f.item!.id, qty: f.qty!, unitCost: f.amount! / f.qty! }],
      payment: { paymentMethod: f.paymentMethod!, accountId: f.account?.id ?? null, categoryId: f.category?.id ?? null },
    });
    const [first] = receipt.transactions;
    return { type: 'stock_receipt', id: first.id, status: first.status, transactionIds: receipt.transactions.map((p) => p.id), receipt: receipt.refId };
  }

  if (kind === 'debt_payment') {
    const row = await debts.settle({
      counterpartyId: f.counterparty!.id,
      direction: f.direction!,
      amount: f.amount!,
      currency: f.currency as never,
      fxRate: f.fxRate,
      date: f.date,
      accountId: f.account!.id,
      description: f.description,
    }, source);
    return { type: 'transaction', id: row.id, status: row.status, transactionIds: [row.id] };
  }

  const row = await transactions.create({
    date: f.date,
    type: kind === 'transfer' ? 'transfer' : kind,
    amount: f.amount!,
    categoryId: f.category?.id ?? null,
    currency: f.currency as never,
    fxRate: f.fxRate,
    paymentMethod: f.paymentMethod as never,
    accountId: f.account?.id ?? null,
    toAccountId: f.toAccount?.id ?? null,
    counterpartyId: f.counterparty?.id ?? null,
    costCenterId: f.target?.costCenterId ?? null,
    ...(f.costTreatment ? { costTreatment: f.costTreatment as never } : {}),
    description: f.description,
  }, source);
  return { type: 'transaction', id: row.id, status: row.status, transactionIds: [row.id] };
}

/** Everything the card points at must still stand: an account can close while a card waits. */
async function recheck(row: Row): Promise<ProposalFields> {
  const fields = visible(row);
  const { _input } = stored(row);
  const checked = await validateDraft(
    row.kind as RecordKind,
    _input,
    { userTexts: [], documentAmounts: [], channel: row.channel as DraftEnv['channel'], conversationId: row.conversationId, fromForm: true },
    _input,
  );
  if (!checked.fields || substance(checked.fields) !== substance(fields)) {
    throw conflict('PROPOSAL_STALE', 'Something on this card has changed since it was made. Please check it', { questions: checked.questions });
  }
  return checked.fields;
}

async function remember(row: Row) {
  if (row.learn.length === 0) return;
  const c = ctx();
  for (const { phrase, targetType, targetId } of row.learn) {
    await tx()
      .insert(aiAliases)
      .values({ phrase: normalize(phrase), targetType, targetId, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
      .onConflictDoUpdate({ target: [aiAliases.farmId, aiAliases.targetType, aiAliases.phrase], set: { targetId } });
  }
}

async function forget(row: Row) {
  for (const { phrase, targetType, targetId } of row.learn) {
    await tx()
      .delete(aiAliases)
      .where(and(eq(aiAliases.farmId, ctx().farmId), eq(aiAliases.targetType, targetType), eq(aiAliases.phrase, normalize(phrase)), eq(aiAliases.targetId, targetId)));
  }
}

export async function confirmProposal(id: string, input: { stamp: string; acknowledged?: boolean }): Promise<ProposalView> {
  // The row lock makes a double tap safe: the second sees it confirmed and stops.
  const row = await own(id, true);
  assertOpen(row);
  const kind = row.kind as RecordKind;
  assertMayWrite(kind);
  // One at a time per farm: two cards for one bill must each see what the other just wrote.
  await tx().execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ai-confirm:${ctx().farmId}`}, 0))`);

  if (stored(row)._pending) throw conflict('PROPOSAL_NEEDS_ANSWER', 'A correction to this card is waiting for an answer');
  const view = await toView(row);
  if (input.stamp !== view.stamp) throw conflict('PROPOSAL_CHANGED', 'This card has changed since you read it', { proposal: view });
  const fields = await recheck(row);
  if (view.needsAcknowledgement && !input.acknowledged) {
    throw conflict('NOT_ACKNOWLEDGED', 'This needs your explicit yes', { proposal: view });
  }

  const written = await write(kind, fields, id);
  const needsApproval = written.status !== 'approved';
  const now = new Date();
  const [updated] = await tx()
    .update(t)
    .set({
      status: 'confirmed',
      confirmedAt: now,
      undoUntil: needsApproval ? null : new Date(now.getTime() + UNDO_WINDOW_MS),
      resultType: written.type,
      resultId: written.id,
      resultStatus: written.status,
      fields: { ...stored(row), _receipt: written.receipt, _transactionIds: written.transactionIds } as unknown as Record<string, unknown>,
    })
    .where(eq(t.id, id))
    .returning();

  await remember(row);
  await recordEvent({
    type: 'ai_proposal.confirmed',
    entityType: 'ai_proposal',
    entityId: id,
    data: { kind, amountBase: fields.amountBase, resultType: written.type, resultId: written.id, channel: row.channel },
  });
  if (fields.costTreatment === 'animal') {
    await notifyUser(ctx().userId!, {
      severity: 'attention',
      title: (locale) => tr(locale, 'ai', 'recordText.registerAnimals.title'),
      body: (locale) => tr(locale, 'ai', 'recordText.registerAnimals.body'),
      link: '/livestock/animals',
    });
  }
  return toView(updated);
}

export async function rejectProposal(id: string): Promise<ProposalView> {
  const row = await own(id, true);
  if (row.status !== 'pending') throw conflict('PROPOSAL_NOT_PENDING', 'This has already been handled');
  const [updated] = await tx().update(t).set({ status: 'rejected' }).where(eq(t.id, id)).returning();
  await recordEvent({ type: 'ai_proposal.rejected', entityType: 'ai_proposal', entityId: id, data: { kind: row.kind, by: 'person' } });
  return toView(updated);
}

/** The card's Change form: ids or names, re-checked exactly as a draft is. */
export async function updateProposal(id: string, changes: Record<string, unknown>): Promise<ProposalView | { questions: Question[] }> {
  const row = await own(id, true);
  assertOpen(row);
  assertMayWrite(row.kind as RecordKind);
  const renames: Record<string, keyof DraftInput> = {
    categoryId: 'category', costCenterId: 'target', accountId: 'account', toAccountId: 'toAccount',
    counterpartyId: 'counterparty', itemId: 'item', warehouseId: 'warehouse',
  };
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) if (value !== undefined) input[renames[key] ?? key] = value;

  const before = stored(row);
  // From what was settled, never from a correction waiting for an answer: only what was typed counts as typed.
  const merged = mergeDraft(before._input, input as DraftInput);
  const checked = await validateDraft(
    row.kind as RecordKind,
    merged,
    { userTexts: [row.sourceText], documentAmounts: [], channel: row.channel as DraftEnv['channel'], conversationId: row.conversationId, fromForm: true },
    before._input,
  );
  if (!checked.fields) return { questions: checked.questions };
  const waiting = stillWaiting(before, input as DraftInput);
  const [updated] = await tx()
    .update(t)
    .set({
      fields: { ...checked.fields, _input: checked.input, ...(waiting ? { _pending: waiting } : {}) } as unknown as Record<string, unknown>,
      warnings: carryWarnings(row, checked.fields, checked.warnings),
      learn: checked.learn,
    })
    .where(eq(t.id, id))
    .returning();
  const view = await toView(updated);
  if (Object.keys(input).length > 0) await recordEvent(changedEvent(view, Object.keys(input), 'person'));
  return view;
}

export async function undoProposal(id: string): Promise<ProposalView> {
  const row = await own(id, true);
  if (row.status !== 'confirmed') throw conflict('PROPOSAL_NOT_CONFIRMED', 'Only a confirmed record can be undone');
  if (!row.undoUntil || row.undoUntil < new Date()) throw conflict('UNDO_EXPIRED', 'It is too late to undo this here');
  assertMayWrite(row.kind as RecordKind);

  const fields = stored(row);
  const ids = fields._transactionIds ?? [];
  if (ids.length === 0) throw conflict('UNDO_IMPOSSIBLE', 'This record cannot be undone here');
  // Money first: a stock receipt cannot be reversed while its payment stands. An entry someone
  // else already refused or voided stays as they left it, with their reason.
  let stillLive = false;
  for (const transactionId of ids) {
    const [entry] = await tx().select({ status: ledger.status }).from(ledger).where(eq(ledger.id, transactionId));
    if (entry?.status === 'approved') await voidTransactions({ id: transactionId }, 'Undone by the person who recorded it');
    else if (entry?.status === 'pending') await deleteUnapprovedTransactions([transactionId]);
    stillLive ||= entry?.status === 'approved' || entry?.status === 'pending';
  }
  // Finance voiding a purchase takes its receipt with it, so there may be nothing left to reverse.
  if (fields._receipt && stillLive) await reverseReceipt(fields._receipt);
  await forget(row);

  const [updated] = await tx().update(t).set({ status: 'undone', undoUntil: null }).where(eq(t.id, id)).returning();
  await recordEvent({ type: 'ai_proposal.undone', entityType: 'ai_proposal', entityId: id, data: { kind: row.kind } });
  return toView(updated);
}

export async function listAliases() {
  return tx()
    .select({ id: aiAliases.id, phrase: aiAliases.phrase, targetType: aiAliases.targetType, targetId: aiAliases.targetId })
    .from(aiAliases)
    .where(eq(aiAliases.farmId, ctx().farmId))
    .orderBy(desc(aiAliases.createdAt));
}

export async function deleteAlias(id: string) {
  const [row] = await tx()
    .delete(aiAliases)
    .where(and(eq(aiAliases.id, id), eq(aiAliases.farmId, ctx().farmId)))
    .returning({ id: aiAliases.id, phrase: aiAliases.phrase, targetType: aiAliases.targetType });
  if (!row) throw notFound('Learned phrase');
  await recordEvent({ type: 'ai_alias.deleted', entityType: 'ai_alias', entityId: id, data: { phrase: row.phrase, targetType: row.targetType } });
  return { id };
}
