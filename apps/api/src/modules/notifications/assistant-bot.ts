/**
 * The conversational assistant over Telegram (docs/assistant.md).
 *
 * It is one more client of the chat() and proposals service the web app uses. Every update loads
 * the person behind the chat afresh, so blocking someone or changing a role takes effect on their
 * next message, and everything then runs under that person's own identity. A turn already running
 * finishes, but a press on its card is checked afresh and refused.
 */
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { ROLES_REQUIRING_2FA, todayIso, type RoleKey } from '@yap/shared';
import { parseMoneyMentions } from '@yap/shared/formulas/money-text';
import { NAMESPACES, type Namespace } from '@yap/shared/i18n';
import { config } from '../../config';
import { tx, withPlatform, withTenant, type Identity } from '../../core/context';
import { AppError, forbidden, safeError } from '../../core/errors';
import { enabledPermissions } from '../../core/http';
import { recordEvent } from '../../core/journal';
import { mergeSettings } from '../../core/settings';
import { db, schema } from '../../db/client';
import { chat } from '../ai/assistant';
import { assertWithinLimits } from '../ai/conversations';
import { transcribeAudio, type LlmBlock } from '../ai/provider';
import { renderProposalText } from '../ai/records/render';
import { confirmProposal, getProposal, listPending, rejectProposal, undoProposal } from '../ai/records/service';
import type { ProposalView, Question } from '../ai/records/types';
import { dayText, groupDigits } from '../ai/render';
import { asAi } from '../ai/role';
import { interpolate, localizeValue, lookup, tr } from './i18n';
import { noteAnswered, wasAnswered } from './notifications.service';
import { farmLabel } from './notify.service';
import {
  FileTooLargeError,
  answerCallback,
  clearButtons,
  downloadFile,
  editHtml,
  escapeHtml,
  sendHtml,
  sendTyping,
  type InlineKeyboard,
  type ReplyMarkup,
  type TelegramCallbackQuery,
  type TelegramFile,
  type TelegramMessage,
} from './telegram';

const { aiConversations, aiMessages, aiProposals, costCenters, farms, financeCategories, memberships, roles, tenants, users } = schema;

/** Command names stay as written in any language, so they are parameters rather than dictionary text. */
export const COMMANDS = {
  status: '/holat',
  alerts: '/ogohlantirishlar',
  pending: '/kutilmoqda',
  new: '/yangi',
  farm: '/ferma',
  help: '/yordam',
};

/** The same limit as the web chat box. */
const MAX_MESSAGE_LENGTH = 2000;
/** Three minutes of ordinary speech run past the box, and a speaker cannot count characters. */
const MAX_TRANSCRIPT_LENGTH = 4000;
const MAX_VOICE_SECONDS = 180;
const MAX_VOICE_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_CARDS_LISTED = 10;
/** Enough of a message to tell it from the next, and short enough to survive a card's limit on its source text. */
const WORDS_COMPARED = 100;
/** Telegram's limit on the text of a button press notice. */
const NOTICE_LIMIT = 200;
/** A chat action fades after about five seconds. */
const TYPING_INTERVAL_MS = 4000;
/** Past this much silence the next message starts afresh, which also falls overnight. */
const CONVERSATION_IDLE_MS = 12 * 3_600_000;

const READABLE_IMAGES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const READABLE_AUDIO = new Set([
  'audio/ogg',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
]);

export interface BotLog {
  info(message: string): void;
  error(details: unknown, message: string): void;
}

// ─── The person behind a chat ───────────────────────────────────────────────

export interface Farm {
  membershipId: string;
  name: string;
  /** Missing while this farm demands two-step sign-in and they have not set it up. */
  identity?: Identity;
}

export interface Person {
  status: 'ok';
  chatId: string;
  userId: string;
  locale: string;
  identity: Identity;
  /** What the assistant's routes require: ai.view, with the module switched on. */
  canAsk: boolean;
  /** Rule 7. A proposal view carries money, so cards are masked without this. */
  seesMoney: boolean;
  /** The web's own limit on reading a stored document. */
  canReadFiles: boolean;
  /** Every farm this person can work on. */
  farms: Farm[];
  /** Named on every card when there is more than one farm to mix up. */
  farmName?: string;
}

export interface Refused {
  status: 'unlinked' | 'blocked' | 'no_farm' | 'enroll_2fa' | 'choose_farm';
  locale?: string;
  userId?: string;
  farms?: Farm[];
}

/** Who is writing, from the database, every time. The same checks core/http makes for a request. */
export async function loadPerson(chatId: string): Promise<Person | Refused> {
  const [user] = await db
    .select({
      id: users.id,
      locale: users.locale,
      status: users.status,
      totpEnabled: users.totpEnabled,
      membershipId: users.telegramMembershipId,
    })
    .from(users)
    .where(eq(users.telegramChatId, chatId));
  if (!user) return { status: 'unlinked' };
  const refused = (status: Refused['status'], choices?: Farm[]): Refused => ({
    status,
    locale: user.locale,
    userId: user.id,
    farms: choices,
  });
  if (user.status !== 'active') return refused('blocked');

  const rows = await withPlatform((trx) =>
    trx
      .select({
        id: memberships.id,
        status: memberships.status,
        tenantId: memberships.tenantId,
        farmId: memberships.farmId,
        farmName: farms.name,
        roleKey: roles.key,
        permissions: roles.permissions,
        tenantName: tenants.name,
        tenantStatus: tenants.status,
        modules: tenants.modules,
        settings: tenants.settings,
        currency: tenants.currency,
        timezone: tenants.timezone,
      })
      .from(memberships)
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .innerJoin(farms, eq(farms.id, memberships.farmId))
      .where(eq(memberships.userId, user.id))
      .orderBy(asc(memberships.createdAt)),
  );
  if (rows.length === 0) return refused('no_farm');
  const active = rows.filter((row) => row.status === 'active' && row.tenantStatus === 'active');
  if (active.length === 0) return refused('blocked');

  const mustEnroll = (row: (typeof active)[number]) =>
    mergeSettings(row.settings).security.enforce2fa && !user.totpEnabled && ROLES_REQUIRING_2FA.includes(row.roleKey as RoleKey);
  const identityOf = (row: (typeof active)[number]): Identity => ({
    userId: user.id,
    tenantId: row.tenantId,
    farmId: row.farmId,
    membershipId: row.id,
    roleKey: row.roleKey,
    permissions: enabledPermissions(row.permissions, row.modules),
    settings: mergeSettings(row.settings),
    currency: row.currency,
    timezone: row.timezone,
    source: 'mobile',
    device: 'telegram',
  });
  const choices: Farm[] = active.map((row) => ({
    membershipId: row.id,
    name: farmLabel(row, active),
    identity: mustEnroll(row) ? undefined : identityOf(row),
  }));

  // Money must never land on a farm nobody picked, so only a lone farm with no earlier choice is assumed.
  const assumed = active.length === 1 && !user.membershipId ? active[0] : undefined;
  const member = active.find((row) => row.id === user.membershipId) ?? assumed;
  if (!member) return refused('choose_farm', choices);
  // That farm stops them, and the buttons are how they reach the others.
  if (mustEnroll(member)) return refused('enroll_2fa', choices.filter((farm) => farm.membershipId !== member.id));

  const permissions = enabledPermissions(member.permissions, member.modules);
  return {
    status: 'ok',
    chatId,
    userId: user.id,
    locale: user.locale,
    canAsk: permissions.includes('ai.view') && member.modules.includes('ai'),
    seesMoney: permissions.includes('finance.view'),
    canReadFiles: permissions.includes('ai.create'),
    farms: choices,
    farmName: choices.length > 1 ? choices.find((farm) => farm.membershipId === member.id)?.name : undefined,
    identity: identityOf(member),
  };
}

const REFUSAL_KEYS: Record<Refused['status'], string> = {
  unlinked: 'bot.notLinked',
  blocked: 'bot.blocked',
  no_farm: 'bot.noFarm',
  enroll_2fa: 'bot.enroll2fa',
  choose_farm: 'bot.chooseFarm',
};

export const refusalText = (person: Refused): string => tr(person.locale, 'alerts', REFUSAL_KEYS[person.status]);

export const noAssistantText = (person: Person): string => tr(person.locale, 'alerts', 'bot.noAssistant', COMMANDS);

const farmButtons = (choices: Farm[], current?: string | null): InlineKeyboard =>
  choices.map((farm) => [
    { text: farm.membershipId === current ? `✓ ${farm.name}` : farm.name, callback_data: `f:${farm.membershipId}` },
  ]);

/** A refusal as it goes out: someone with a farm they can still move to gets the buttons to do it with. */
export async function sendRefusal(chatId: string, person: Refused): Promise<void> {
  const farms = person.farms ?? [];
  await sendHtml(chatId, escapeHtml(refusalText(person)), farms.length > 0 ? { inline_keyboard: farmButtons(farms) } : undefined);
}

/** /ferma: which farm this chat works on, and the way to another. */
export async function sendFarms(person: Person): Promise<void> {
  const current = person.farmName ?? person.farms[0]?.name;
  if (person.farms.length === 1) return say(person, 'bot.oneFarm', { farm: current });
  const text = tr(person.locale, 'alerts', 'bot.currentFarm', { farm: current });
  await sendHtml(person.chatId, escapeHtml(text), { inline_keyboard: farmButtons(person.farms, person.identity.membershipId) });
}

/** The journal of the chosen farm keeps the move, because it decides where this chat's records land. */
async function chooseFarm(query: TelegramCallbackQuery, person: Person | Refused): Promise<string | undefined> {
  const farm = person.farms?.find((choice) => `f:${choice.membershipId}` === query.data);
  if (!farm || !person.userId) return tr(person.locale, 'alerts', 'bot.stale');
  await db.update(users).set({ telegramMembershipId: farm.membershipId }).where(eq(users.id, person.userId));
  const chatId = String(query.from.id);
  forgetTurnState(chatId);
  const text = tr(person.locale, 'alerts', 'bot.farmChosen', { farm: farm.name });
  const chosen = await loadPerson(chatId);
  if (chosen.status === 'ok') {
    await withTenant(chosen.identity, () =>
      recordEvent({ type: 'telegram.farm_chosen', entityType: 'membership', entityId: farm.membershipId }),
    );
  }
  if (query.message) await editHtml(chatId, query.message.message_id, escapeHtml(text));
  else await sendHtml(chatId, escapeHtml(text));
  return undefined;
}

// ─── Logging and failures ───────────────────────────────────────────────────

/** Figures read the way they do on a card. */
function readableDetails(details: unknown): Record<string, unknown> {
  if (typeof details !== 'object' || details === null) return {};
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [key, typeof value === 'number' ? groupDigits(value, Number.isInteger(value) ? 0 : 2) : value]),
  );
}

/** The web looks an error's text up across namespaces, so the same text reaches both channels. */
function errorText(locale: string | undefined, error: AppError): string | null {
  for (const namespace of NAMESPACES) {
    const text = lookup(locale, namespace, `errors.${error.code}`);
    if (text) return interpolate(text, readableDetails(error.details), locale);
  }
  return null;
}

/** Server-side failures that still have something useful to tell the person. */
const SPELLED_OUT = new Set(['AI_NOT_CONFIGURED', 'AI_AUDIO_NOT_SUPPORTED', 'AI_TRANSCRIPTION_FAILED']);

/** A short reply for the person. Only causes they can act on are spelled out. */
function failureText(locale: string | undefined, error: unknown): string {
  if (error instanceof FileTooLargeError) {
    return tr(locale, 'alerts', 'bot.fileTooLarge', { limit: error.maxBytes / (1024 * 1024) });
  }
  if (error instanceof AppError) {
    if (error.code === 'AI_RATE_LIMITED') {
      const { retryAfterSeconds } = (error.details ?? {}) as { retryAfterSeconds?: number };
      return tr(locale, 'alerts', 'bot.rateLimited', { minutes: Math.ceil((retryAfterSeconds ?? 60) / 60) });
    }
    if (error.status < 500 || SPELLED_OUT.has(error.code)) {
      const known = errorText(locale, error);
      if (known) return known;
    }
  }
  return tr(locale, 'alerts', 'bot.apology');
}

/** A provider out of quota looks like an ordinary refusal to the person, but someone has to act on it. */
const isExpected = (error: unknown) =>
  error instanceof FileTooLargeError ||
  (error instanceof AppError && error.status < 500 && !error.code.startsWith('AI_PROVIDER'));

// ─── Text to Telegram HTML ──────────────────────────────────────────────────

const inline = (escaped: string) =>
  escaped.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>');

const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isTableRule = (line: string | undefined) => line !== undefined && line.includes('|') && TABLE_RULE.test(line);
const cellsOf = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());

/** One row as a line a phone can show: "• Dizel: Miqdor 20 l, Narx 300 000". */
function rowLine(columns: string[], cells: string[]): string {
  const [first, ...rest] = cells;
  const details = rest.flatMap((cell, i) => (cell ? [`${columns[i + 1] ?? ''} ${cell}`.trim()] : []));
  return `• ${[first, details.join(', ')].filter(Boolean).join(': ')}`;
}

/** Telegram has no tables, and a Markdown one is unreadable on a phone. */
function tablesToLists(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('|') || !isTableRule(lines[i + 1])) {
      out.push(lines[i]);
      continue;
    }
    const columns = cellsOf(lines[i]);
    for (i += 2; i < lines.length && lines[i].includes('|'); i++) out.push(rowLine(columns, cellsOf(lines[i])));
    i--;
  }
  return out;
}

/** What the model wrote, escaped, with the little Markdown it uses turned into Telegram's HTML. */
export function modelTextToHtml(text: string): string {
  return tablesToLists(text)
    .map((line) => {
      const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (heading) return `<b>${escapeHtml(heading[1].replace(/\*\*/g, ''))}</b>`;
      const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
      return inline(escapeHtml(bullet ? `${bullet[1]}• ${bullet[2]}` : line));
    })
    .join('\n');
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return groupDigits(value, Number.isInteger(value) ? 0 : 2);
  if (typeof value === 'string' && ISO_DATE.test(value)) return dayText(value);
  return String(value);
}

/** A column name from a tool in the person's language, as the web table shows it. */
const columnLabel = (locale: string, key: string) =>
  lookup(locale, 'ai', `fields.${key}`) ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

function rowsHtml(locale: string, title: string, columns: string[], rows: Record<string, unknown>[], total = rows.length): string {
  const labels = columns.map((column) => columnLabel(locale, column));
  const lines = rows.map((row) => escapeHtml(rowLine(labels, columns.map((column) => cellText(row[column])))));
  if (total > rows.length) lines.push(escapeHtml(tr(locale, 'ai', 'chat.tableMore', { shown: rows.length, total })));
  return [`<b>${escapeHtml(title)}</b>`, ...lines].join('\n');
}

type ChatMessage = Awaited<ReturnType<typeof chat>>['message'];

function answerHtml(message: ChatMessage, locale: string): string {
  const parts = [modelTextToHtml(message.text)];
  for (const attachment of message.attachments) {
    if (attachment.type === 'table') {
      parts.push(rowsHtml(locale, attachment.title, attachment.columns, attachment.rows, attachment.total));
    }
    if (attachment.type === 'chart') {
      parts.push(rowsHtml(locale, attachment.title, [attachment.xKey, ...attachment.yKeys], attachment.rows));
    }
  }
  return parts.join('\n\n');
}

/** Where an option's wording lives, keyed by its id. The same places the web looks. */
const OPTION_WORDING: Record<string, [Namespace, string]> = {
  paymentMethod: ['enums', 'paymentMethod'],
  direction: ['ai', 'records.direction'],
};
const OTHER_OPTIONS: [Namespace, string] = ['ai', 'records.options'];

/** Options stored in a single language, which take a look at the record. Words like "wage" are no record. */
async function storedOptionNames(person: Person, question: Question): Promise<Map<string, string>> {
  const ids = question.options.map((option) => option.id).filter((id) => RECORD_ID.test(id));
  if (ids.length === 0) return new Map();
  return withTenant(person.identity, async () => {
    if (question.field === 'category') {
      const rows = await tx()
        .select({ id: financeCategories.id, name: financeCategories.name })
        .from(financeCategories)
        .where(inArray(financeCategories.id, ids));
      return new Map(rows.map((row) => [row.id, String(localizeValue(row.name, person.locale))]));
    }
    if (question.field === 'target') {
      const rows = await tx()
        .select({ id: costCenters.id })
        .from(costCenters)
        .where(and(inArray(costCenters.id, ids), eq(costCenters.type, 'general')));
      return new Map(rows.map((row) => [row.id, tr(person.locale, 'enums', 'costCenterType.general')]));
    }
    return new Map();
  });
}

/** A stored name is data, so what its button sends must not read as a command. */
const sendable = (label: string) => (/^[\s\p{C}\p{Z}]*\//u.test(label) ? `«${label.trim()}»` : label);

/**
 * A reply keyboard, because pressing one of its buttons sends the label as the person's own next
 * message. So the labels must be in their language, which the API's are not always: it sends
 * stored names and plain English, as the web app's options know too.
 */
async function optionKeyboard(person: Person, question: Question, log: BotLog): Promise<ReplyMarkup> {
  // The question matters more than the wording of its buttons.
  const stored = await storedOptionNames(person, question).catch((error) => {
    log.error({ err: safeError(error), userId: person.userId }, 'telegram option names not read');
    return new Map<string, string>();
  });
  const [namespace, path] = OPTION_WORDING[question.field] ?? OTHER_OPTIONS;
  const label = (option: Question['options'][number]) =>
    stored.get(option.id) ?? lookup(person.locale, namespace, `${path}.${option.id}`) ?? option.label;
  return {
    keyboard: question.options.map((option) => [{ text: sendable(label(option)) }]),
    one_time_keyboard: true,
    resize_keyboard: true,
  };
}

/** The question's options, or a clear, so that the options of an earlier question do not linger. */
async function answerMarkup(person: Person, message: ChatMessage, log: BotLog): Promise<ReplyMarkup> {
  for (const attachment of message.attachments) {
    if (attachment.type === 'question' && attachment.question.options.length > 0) {
      return optionKeyboard(person, attachment.question, log);
    }
  }
  return { remove_keyboard: true };
}

// ─── Cards and buttons ──────────────────────────────────────────────────────

type CardAction = 'c' | 'd' | 'e' | 'x' | 'u';

const CARD_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RECORD_ID = new RegExp(`^${CARD_ID}$`);
const CALLBACK = new RegExp(`^p:([cdexu]):(${CARD_ID}):([0-9a-f]{12})$`);

const undoOpen = (view: ProposalView) => view.undoUntil !== null && Date.parse(view.undoUntil) > Date.now();

/** What a pending card may offer: all of it, an explicit yes, or no Confirm until something is settled. */
type Offer = 'all' | 'yes' | 'no_confirm';

function buttons(person: Person, view: ProposalView, offer: Offer = 'all'): InlineKeyboard | undefined {
  // Nobody confirms what they cannot read.
  if (!person.seesMoney || view.masked) return undefined;
  const button = (key: string, action: CardAction) => ({
    text: tr(person.locale, 'alerts', `bot.buttons.${key}`),
    callback_data: `p:${action}:${view.id}:${view.stamp}`,
  });
  if (view.status === 'confirmed') return undoOpen(view) ? [[button('undo', 'u')]] : undefined;
  if (view.status !== 'pending') return undefined;
  // chat() only tells the model about drafts from its own channel, so others cannot be talked into shape here.
  const change = view.channel === 'telegram' ? [button('change', 'e')] : [];
  // A double tap on Confirm lands where Confirm was: never on the yes, and on Cancel only if nothing milder is on offer.
  if (offer === 'yes') {
    return change.length > 0 ? [change, [button('yesRecord', 'd')], [button('cancel', 'x')]] : [[button('cancel', 'x')], [button('yesRecord', 'd')]];
  }
  if (offer === 'no_confirm' || view.needsAnswer) return [[...change, button('cancel', 'x')]];
  return [[button('confirm', 'c')], [...change, button('cancel', 'x')]];
}

const CONFIRMED_NOTES: Record<string, string> = {
  approved: 'bot.recorded',
  pending: 'bot.waitingApproval',
  rejected: 'bot.notInBooks',
};

function statusNote(view: ProposalView, locale: string): string | null {
  const keys: Partial<Record<ProposalView['status'], string>> = {
    confirmed: CONFIRMED_NOTES[view.result?.status ?? ''],
    rejected: 'bot.cancelled',
    expired: 'bot.expired',
    failed: 'bot.failed',
    undone: 'bot.undone',
  };
  const key = keys[view.status];
  return key ? tr(locale, 'alerts', key) : null;
}

/** The card's own line already says this, as the row of the web card does. */
const SAID_ON_THE_CARD = new Set(['TARGET_DEFAULTED']);

function cardHtml(person: Person, view: ProposalView, note = statusNote(view, person.locale)): string {
  const shown = { ...view, warnings: view.warnings.filter((warning) => !SAID_ON_THE_CARD.has(warning.code)) };
  const body = view.masked ? tr(person.locale, 'alerts', 'bot.moneyHidden') : renderProposalText(shown, person.locale, person.farmName);
  return note ? `${escapeHtml(body)}\n\n<b>${escapeHtml(note)}</b>` : escapeHtml(body);
}

async function sendCard(person: Person, view: ProposalView): Promise<void> {
  const keyboard = buttons(person, view);
  await sendHtml(person.chatId, cardHtml(person, view), keyboard && { inline_keyboard: keyboard });
}

async function say(person: Person, key: string, params?: Record<string, unknown>): Promise<void> {
  await sendHtml(person.chatId, escapeHtml(tr(person.locale, 'alerts', key, params)));
}

/** /kutilmoqda: the person's own drafts on this farm from any channel, each with its buttons. */
export async function sendPending(person: Person): Promise<void> {
  const views = await withTenant(person.identity, () => listPending());
  if (views.length === 0) return say(person, 'bot.noPending');
  await say(person, 'bot.pendingCount', { count: views.length });
  for (const view of views.slice(0, MAX_CARDS_LISTED)) await sendCard(person, view);
  const more = views.length - MAX_CARDS_LISTED;
  if (more > 0) await say(person, 'bot.pendingMore', { count: more });
}

// ─── Button presses ─────────────────────────────────────────────────────────

interface Applied {
  view: ProposalView;
  /** Shown on the card in place of its status line. */
  note?: string;
  offer?: Offer;
  /** Shown briefly on the person's screen. */
  notice?: string;
  /** Change was pressed on the card as it stands, so the next message is about it. */
  changing?: boolean;
}

/** Every call checks that the proposal is the presser's own; a stranger's press stops at the first. */
async function press(person: Person, action: CardAction, id: string, stamp: string): Promise<Applied> {
  if (action === 'u') return { view: await undoProposal(id) };
  if (action === 'c' || action === 'd') return { view: await confirmProposal(id, { stamp, acknowledged: action === 'd' }) };
  const view = await getProposal(id);
  // Change and Cancel are about what the person read, so a newer version has to be read first.
  if (view.status === 'pending' && view.stamp !== stamp) {
    return { view, notice: tr(person.locale, 'alerts', 'bot.cardChanged') };
  }
  if (action === 'x') return { view: await rejectProposal(id) };
  return { view, changing: view.status === 'pending' };
}

/** The card is behind the record: it was handled elsewhere, or the time ran out. */
const CARD_IS_BEHIND = new Set(['PROPOSAL_NOT_PENDING', 'PROPOSAL_EXPIRED', 'PROPOSAL_NOT_CONFIRMED', 'UNDO_EXPIRED']);

/** What a refused press has to say. Nothing was recorded by any of these. */
async function refusedPress(person: Person, id: string, error: AppError): Promise<Applied | null> {
  const fresh = (error.details as { proposal?: ProposalView } | undefined)?.proposal;
  const current = () => fresh ?? withTenant(person.identity, () => getProposal(id));
  const line = (key: string) => tr(person.locale, 'alerts', key);
  switch (error.code) {
    case 'PROPOSAL_CHANGED':
      return { view: await current(), notice: line('bot.cardChanged') };
    case 'NOT_ACKNOWLEDGED':
      return { view: await current(), offer: 'yes', note: line('bot.acknowledgeAsk') };
    case 'PROPOSAL_NEEDS_ANSWER':
      return { view: await current(), offer: 'no_confirm', note: line('bot.needsAnswer') };
    case 'PROPOSAL_STALE':
      return { view: await current(), offer: 'no_confirm', note: line('bot.cardStale') };
  }
  return CARD_IS_BEHIND.has(error.code) ? { view: await current(), notice: failureText(person.locale, error) } : null;
}

async function applyPress(person: Person, action: CardAction, id: string, stamp: string): Promise<Applied> {
  try {
    return await withTenant(person.identity, () => press(person, action, id, stamp));
  } catch (error) {
    const known = error instanceof AppError ? await refusedPress(person, id, error) : null;
    if (!known) throw error;
    return known;
  }
}

/** The button goes when the window closes. The service refuses a late press regardless. */
function dropUndoButton(person: Person, messageId: number, view: ProposalView, log: BotLog) {
  if (!view.undoUntil) return;
  const timer = setTimeout(() => {
    clearButtons(person.chatId, messageId).catch((error) =>
      log.error({ err: safeError(error), userId: person.userId }, 'telegram undo button not removed'),
    );
  }, Date.parse(view.undoUntil) - Date.now());
  timer.unref();
}

/**
 * The press has taken effect by now, so nothing here may turn it into a failure. A card that cannot
 * be edited is sent as a new message, and the notice tells the outcome if even that fails.
 */
async function showOutcome(person: Person, messageId: number, applied: Applied, log: BotLog): Promise<string | undefined> {
  const { view, note, notice, offer } = applied;
  const keyboard = buttons(person, view, offer);
  const html = cardHtml(person, view, note);
  let shownOn: number | undefined = messageId;
  try {
    await editHtml(person.chatId, messageId, html, keyboard);
  } catch (error) {
    log.error({ err: safeError(error), userId: person.userId }, 'telegram card not edited');
    shownOn = await sendHtml(person.chatId, html, keyboard && { inline_keyboard: keyboard }).catch((failure) => {
      log.error({ err: safeError(failure), userId: person.userId }, 'telegram outcome not sent');
      return undefined;
    });
  }
  if (keyboard && shownOn && view.status === 'confirmed') dropUndoButton(person, shownOn, view, log);
  return notice ?? (shownOn === messageId ? undefined : (note ?? statusNote(view, person.locale) ?? undefined));
}

async function act(query: TelegramCallbackQuery, person: Person | Refused, log: BotLog): Promise<string | undefined> {
  if (person.status !== 'ok') return refusalText(person);
  if (!person.canAsk) return noAssistantText(person);
  const pressed = CALLBACK.exec(query.data ?? '');
  const card = query.message;
  if (!pressed || !card) return tr(person.locale, 'alerts', 'bot.stale');
  if (card.chat.type !== 'private' || String(card.chat.id) !== person.chatId) {
    return tr(person.locale, 'alerts', 'bot.groupOnly');
  }
  if (!person.seesMoney) {
    // Nobody acts on what they may not read, and an old card's figures come off their screen.
    const hidden = tr(person.locale, 'alerts', 'bot.moneyHidden');
    await editHtml(person.chatId, card.message_id, escapeHtml(hidden)).catch((error) =>
      log.error({ err: safeError(error), userId: person.userId }, 'telegram card not edited'),
    );
    return hidden;
  }

  const applied = await applyPress(person, pressed[1] as CardAction, pressed[2], pressed[3]);
  if (!applied.changing) return showOutcome(person, card.message_id, applied, log);
  // The reply is an ordinary message, so options left from an earlier question must not answer it.
  pointAtCard(person.chatId, applied.view.id);
  await sendHtml(person.chatId, escapeHtml(tr(person.locale, 'alerts', 'bot.changePrompt')), { remove_keyboard: true });
  return undefined;
}

/** A press on a card of another farm is not a lost card, just the wrong farm for now. */
function pressFailure(person: Person | Refused | undefined, error: unknown): string {
  const otherFarm = error instanceof AppError && error.code === 'NOT_FOUND' && (person?.farms?.length ?? 0) > 1;
  return otherFarm ? tr(person?.locale, 'alerts', 'bot.otherFarm', COMMANDS) : failureText(person?.locale, error);
}

/** Always answers the query, so the spinner on the button stops whatever happened. */
export async function answering(
  query: TelegramCallbackQuery,
  log: BotLog,
  work: (person: Person | Refused) => Promise<string | undefined>,
): Promise<void> {
  let notice: string | undefined;
  let person: Person | Refused | undefined;
  try {
    person = await loadPerson(String(query.from.id));
    notice = await work(person);
  } catch (error) {
    if (!isExpected(error)) log.error({ err: safeError(error) }, 'telegram button failed');
    notice = pressFailure(person, error);
  }
  if (query.answered) return;
  query.answered = true;
  try {
    await answerCallback(query.id, notice?.slice(0, NOTICE_LIMIT));
  } catch (error) {
    log.error({ err: safeError(error) }, 'telegram button answer failed');
  }
}

export const handleCallback = (query: TelegramCallbackQuery, log: BotLog): Promise<void> =>
  answering(query, log, (person) => (query.data?.startsWith('f:') ? chooseFarm(query, person) : act(query, person, log)));

/** A Confirm must see what the turn before it does to the card, however long that turn takes. */
export const refuseOvertakingPress = (query: TelegramCallbackQuery, log: BotLog): Promise<void> =>
  answering(query, log, async (person) => tr(person.locale, 'alerts', 'bot.waitForAnswer'));

/** For a farm press waiting behind a turn: the outcome comes as an edit, but the spinner should stop now. */
export const noticeFarmWaits = (query: TelegramCallbackQuery, log: BotLog): Promise<void> =>
  answering(query, log, async (person) => tr(person.locale, 'alerts', 'bot.farmAfterTurn'));

// ─── Conversations ──────────────────────────────────────────────────────────

/** Chats that asked for /yangi. Losing this on a restart only continues the old conversation. */
const startingFresh = new Set<string>();

/** The card a Change press was about, for the next message only. */
const pointedAt = new Map<string, { id: string; until: number }>();
const POINTER_MS = 15 * 60_000;

const pointAtCard = (chatId: string, id: string) => pointedAt.set(chatId, { id, until: Date.now() + POINTER_MS });

/**
 * When forwarded words were written, while a question about them is open: the answer is written
 * today, but the record keeps their day. Losing this on a restart dates the card today, where it shows.
 */
const forwardedOn = new Map<string, { conversationId: string; at: Date }>();

function forgetTurnState(chatId: string): void {
  startingFresh.delete(chatId);
  pointedAt.delete(chatId);
  forwardedOn.delete(chatId);
}

export function startNewConversation(person: Person): void {
  pointedAt.delete(person.chatId);
  startingFresh.add(person.chatId);
}

/** The card this message is about: the one Change was pressed on, or the one it swipe-replies to. */
function cardMeant(chatId: string, message: TelegramMessage): string | undefined {
  const pointer = pointedAt.get(chatId);
  pointedAt.delete(chatId);
  const replied = message.reply_to_message?.reply_markup?.inline_keyboard?.flat();
  const repliedTo = replied?.map((button) => CALLBACK.exec(button.callback_data)?.[2]).find(Boolean);
  return repliedTo ?? (pointer && pointer.until > Date.now() ? pointer.id : undefined);
}

/**
 * chat() corrects only the cards of its own conversation, so a meant card brings its conversation
 * along. A card of another farm cannot be corrected from here, and the words must not be taken for
 * new ones about this farm. Another workspace's card is out of sight altogether.
 */
async function meantCard(person: Person, id: string): Promise<{ otherFarm: boolean; conversationId?: string }> {
  const [row] = await withTenant(person.identity, () =>
    tx()
      .select({ conversationId: aiProposals.conversationId, farmId: aiProposals.farmId, status: aiProposals.status, channel: aiProposals.channel })
      .from(aiProposals)
      .where(and(eq(aiProposals.id, id), eq(aiProposals.userId, person.userId))),
  );
  if (!row) return { otherFarm: person.farms.length > 1 };
  if (row.farmId !== person.identity.farmId) return { otherFarm: true };
  const open = row.status === 'pending' && row.channel === 'telegram';
  return { otherFarm: false, conversationId: open ? (row.conversationId ?? undefined) : undefined };
}

const lastActive = sql<Date>`coalesce(
  (select max(m.created_at) from ${aiMessages} m where m.conversation_id = ${aiConversations.id}),
  ${aiConversations.createdAt}
)`;

/** The person's latest Telegram conversation, unless it has gone quiet for too long. */
function currentConversation(person: Person): Promise<string | undefined> {
  return withTenant(person.identity, async () => {
    const [latest] = await tx()
      .select({ id: aiConversations.id })
      .from(aiConversations)
      .where(
        and(
          eq(aiConversations.userId, person.userId),
          eq(aiConversations.farmId, person.identity.farmId),
          eq(aiConversations.channel, 'telegram'),
          gt(lastActive, new Date(Date.now() - CONVERSATION_IDLE_MS)),
        ),
      )
      .orderBy(desc(lastActive))
      .limit(1);
    return latest?.id;
  });
}

// ─── Messages ───────────────────────────────────────────────────────────────

/**
 * chat() limits text by counting stored questions, but a voice note costs a model call before it
 * is a question, and a silent one never becomes one. Same numbers as the AI limits.
 */
const VOICE_PER_MINUTE = Number(process.env.AI_CHAT_PER_MINUTE) || 10;
const VOICE_PER_DAY = Number(process.env.AI_CHAT_PER_DAY) || 200;
const voiceNotes = new Map<string, number[]>();

/** Seconds until the next voice note, or null if this one may go ahead. */
function takeVoiceSlot(userId: string): number | null {
  const now = Date.now();
  const today = (voiceNotes.get(userId) ?? []).filter((at) => at > now - 86_400_000);
  voiceNotes.set(userId, today);
  if (today.length >= VOICE_PER_DAY) return 3600;
  if (today.filter((at) => at > now - 60_000).length >= VOICE_PER_MINUTE) return 60;
  today.push(now);
  return null;
}

const isReadableAudio = (file?: TelegramFile) => READABLE_AUDIO.has(file?.mime_type?.split(';')[0] ?? '');

/** A voice note, an audio message, or audio sent as a file. */
const audioOf = (message: TelegramMessage) =>
  message.voice ?? message.audio ?? (isReadableAudio(message.document) ? message.document : undefined);

/** Text is checked by chat() itself. Files are checked here, before they are downloaded. */
async function assertMayAsk(person: Person, message: TelegramMessage): Promise<void> {
  const voice = audioOf(message);
  const wait = voice ? takeVoiceSlot(person.userId) : null;
  if (wait !== null) {
    throw new AppError(429, 'AI_RATE_LIMITED', 'Too many voice notes, please wait a little', { retryAfterSeconds: wait });
  }
  const file = !voice && (message.photo || message.document);
  if (file && !person.canReadFiles) throw forbidden(undefined, 'FORBIDDEN', { required: 'ai.create' });
  if (voice || file) await withTenant(person.identity, () => asAi(assertWithinLimits));
}

async function withTyping<T>(chatId: string, work: () => Promise<T>): Promise<T> {
  const tick = () => void sendTyping(chatId).catch(() => {});
  tick();
  const timer = setInterval(tick, TYPING_INTERVAL_MS);
  timer.unref();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

interface Asked {
  text: string;
  blocks?: LlmBlock[];
  /** Words heard rather than typed, which have a limit of their own. */
  spoken?: boolean;
}

/** A voice note as text, shown back first so the person sees what was heard. Null if nothing was. */
async function heardFrom(person: Person, file: TelegramFile, caption: string | undefined): Promise<Asked | null> {
  const mediaType = file.mime_type?.split(';')[0] ?? 'audio/ogg';
  if (!READABLE_AUDIO.has(mediaType)) {
    await say(person, 'bot.unsupported');
    return null;
  }
  if ((file.duration ?? 0) > MAX_VOICE_SECONDS) {
    await say(person, 'bot.voiceTooLong', { limit: MAX_VOICE_SECONDS / 60 });
    return null;
  }
  if ((file.file_size ?? 0) > MAX_VOICE_BYTES) throw new FileTooLargeError(MAX_VOICE_BYTES);
  const audio = await downloadFile(file.file_id, MAX_VOICE_BYTES);
  const transcript = await transcribeAudio({ type: 'audio', mediaType, dataBase64: audio.toString('base64') });
  const typed = caption?.trim();
  if (!transcript && !typed) {
    await say(person, 'bot.nothingHeard');
    return null;
  }
  if (transcript) {
    await sendHtml(person.chatId, `<i>${escapeHtml(tr(person.locale, 'alerts', 'bot.heard'))}</i>\n${escapeHtml(transcript)}`);
  }
  return { text: [transcript, typed].filter(Boolean).join('.\n'), spoken: true };
}

/** One page of a receipt or invoice, for the model to read. Null when it is a kind we cannot read. */
async function pageFrom(person: Person, message: TelegramMessage): Promise<LlmBlock | null> {
  // Telegram lists a photo from smallest to largest, and the largest that fits reads best.
  const photo = message.photo?.filter((size) => (size.file_size ?? 0) <= MAX_DOCUMENT_BYTES).at(-1);
  if (message.photo && !photo) throw new FileTooLargeError(MAX_DOCUMENT_BYTES);
  const file = photo ?? message.document;
  const mediaType = photo ? 'image/jpeg' : (file?.mime_type ?? '');
  const isPdf = mediaType === 'application/pdf';
  if (!file || (!isPdf && !READABLE_IMAGES.has(mediaType))) {
    // Sent as a photo, Telegram turns any picture into a JPEG for us, but a file stays as it is.
    await say(person, mediaType.startsWith('image/') ? 'bot.sendAsPhoto' : 'bot.unsupported');
    return null;
  }
  if ((file.file_size ?? 0) > MAX_DOCUMENT_BYTES) throw new FileTooLargeError(MAX_DOCUMENT_BYTES);
  const dataBase64 = (await downloadFile(file.file_id, MAX_DOCUMENT_BYTES)).toString('base64');
  return isPdf ? { type: 'document', mediaType: 'application/pdf', dataBase64 } : { type: 'image', mediaType, dataBase64 };
}

/** A receipt photo, a PDF, or an album of them as one question under its one caption. */
async function documentFrom(person: Person, message: TelegramMessage): Promise<Asked | null> {
  const pages = message.album ?? [message];
  const blocks: LlmBlock[] = [];
  for (const page of pages) {
    const block = await pageFrom(person, page);
    if (!block) return null;
    blocks.push(block);
  }
  const caption = pages.map((page) => page.caption?.trim()).find(Boolean);
  return { text: caption || tr(person.locale, 'alerts', 'bot.documentPrompt'), blocks };
}

async function readMessage(person: Person, message: TelegramMessage): Promise<Asked | null> {
  const voice = audioOf(message);
  if (voice) return heardFrom(person, voice, message.caption);
  if (message.photo || message.document) return documentFrom(person, message);
  if (message.text) return { text: message.text.trim() };
  await say(person, 'bot.unsupported');
  return null;
}

/** Set only when the words were written on an earlier day: held up on the way, or passed on later. */
function writtenEarlier(person: Person, message: TelegramMessage): Date | undefined {
  const written = message.forward_origin?.date ?? message.date;
  if (!written) return undefined;
  const writtenAt = new Date(written * 1000);
  const { timezone } = person.identity;
  return todayIso(timezone, writtenAt) === todayIso(timezone) ? undefined : writtenAt;
}

/**
 * Drafts that exist because of this turn, whatever became of the turn. A turn past the hold runs
 * beside the next message, so the time alone cannot tell whose a card is: its words can.
 */
async function draftsOfTurn(person: Person, asked: Asked, since: Date): Promise<ProposalView[]> {
  const views = await withTenant(person.identity, () => listPending());
  const words = asked.text.slice(0, WORDS_COMPARED);
  return views.filter((view) => view.channel === 'telegram' && Date.parse(view.createdAt) >= since.getTime() && view.sourceText.includes(words));
}

/** A pending draft nobody can see is the worst outcome of a failed turn: they would say it again. */
async function salvageCards(person: Person, asked: Asked, since: Date, log: BotLog): Promise<boolean> {
  try {
    const views = await draftsOfTurn(person, asked, since);
    for (const view of views) await sendCard(person, view);
    return views.length > 0;
  } catch (error) {
    log.error({ err: safeError(error), userId: person.userId }, 'telegram cards not recovered');
    return false;
  }
}

async function ask(person: Person, asked: Asked, source: TelegramMessage, log: BotLog): Promise<void> {
  const startedAt = new Date();
  const meant = cardMeant(person.chatId, source);
  const card = meant ? await meantCard(person, meant) : undefined;
  if (card?.otherFarm) return say(person, 'bot.otherFarm', COMMANDS);
  const meantConversation = card?.conversationId;
  // Taken here, so that a turn from before /yangi cannot use it up when it finishes afterwards.
  const fresh = meantConversation === undefined && startingFresh.delete(person.chatId);
  const conversationId = meantConversation ?? (fresh ? undefined : await currentConversation(person));
  const pointer: LlmBlock[] = meantConversation
    ? [{ type: 'text', text: `The person means card ${meant} and no other. Correct that card with update_draft.` }]
    : [];
  const written = writtenEarlier(person, source);
  const forward = forwardedOn.get(person.chatId);
  // Money of its own is a new record, which has its own day.
  const answersForward = forward?.conversationId === conversationId && parseMoneyMentions(asked.text).length === 0;

  let reply: ChatMessage;
  try {
    const turn = await chat(person.identity, {
      conversationId,
      message: asked.text,
      channel: 'telegram',
      blocks: [...(asked.blocks ?? []), ...pointer],
      sentAt: written ?? (answersForward ? forward?.at : undefined),
      forwarded: source.forward_origin !== undefined,
    });
    reply = turn.message;
    if (reply.asked.length === 0) forwardedOn.delete(person.chatId);
    else if (source.forward_origin && written) forwardedOn.set(person.chatId, { conversationId: turn.conversationId, at: written });
  } catch (error) {
    if (fresh) startingFresh.add(person.chatId);
    if (!(await salvageCards(person, asked, startedAt, log))) throw error;
    log.error({ err: safeError(error), userId: person.userId }, 'telegram turn failed after a card was made');
    return;
  }

  // One turn can draft and then correct the same record, and only the last version is a card.
  const cards = new Map<string, ProposalView>();
  for (const attachment of reply.attachments) {
    if (attachment.type === 'proposal') cards.set(attachment.proposal.id, attachment.proposal);
  }
  try {
    await sendHtml(person.chatId, answerHtml(reply, person.locale), await answerMarkup(person, reply, log));
  } catch (error) {
    if (cards.size === 0) throw error;
    log.error({ err: safeError(error), userId: person.userId }, 'telegram answer not sent, the cards still go out');
  }
  for (const view of cards.values()) await sendCard(person, view);
}

/** One plain message, voice note, photo or document from a linked person in a private chat. */
export async function handleAssistantMessage(person: Person, message: TelegramMessage, log: BotLog): Promise<void> {
  if (!person.canAsk) {
    await sendHtml(person.chatId, escapeHtml(noAssistantText(person)));
    return;
  }
  const answered = await withTenant(person.identity, () => wasAnswered(person.chatId, message.message_id));
  if (answered) return;
  await withTyping(person.chatId, async () => {
    try {
      await assertMayAsk(person, message);
      const asked = await readMessage(person, message);
      if (!asked) return;
      if (asked.text.length > (asked.spoken ? MAX_TRANSCRIPT_LENGTH : MAX_MESSAGE_LENGTH)) {
        if (asked.spoken) await say(person, 'bot.voiceTooLong', { limit: MAX_VOICE_SECONDS / 60 });
        else await say(person, 'bot.tooLong', { limit: MAX_MESSAGE_LENGTH });
        return;
      }
      await ask(person, asked, message, log);
    } catch (error) {
      if (!isExpected(error)) log.error({ err: safeError(error), userId: person.userId }, 'telegram assistant failed');
      await sendHtml(person.chatId, escapeHtml(failureText(person.locale, error)));
    }
  });
  await withTenant(person.identity, () => noteAnswered(person.chatId, message.message_id)).catch((error) =>
    log.error({ err: safeError(error), userId: person.userId }, 'telegram answer not noted'),
  );
}
