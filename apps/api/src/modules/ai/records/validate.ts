/**
 * Decides whether a draft is complete and whether the person's words back it. The model extracts;
 * this is where "ready" is decided. Nothing on a card rests on the model's word alone: amounts,
 * quantities, dates, how it was paid, who paid whom and the names of people, fields and machines
 * must each be found in what the person said, or the answer is a question (docs/assistant.md).
 *
 * A field that was checked on an earlier step, or typed into the card's form, is trusted as it stands,
 * so a correction to one field does not put the others back on trial.
 */
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { addDays, diffDays, round, toBaseAmount } from '@yap/shared';
import { currencyOf, currencySaid, findMention, parseMoneyMentions, type MoneyMention } from '@yap/shared/formulas/money-text';
import {
  advanceWords, dateEvidence, directUseWords, directionWords, joinsThings, moneyCameIn, monthlyWord, notHappened, ownedWords, parseQuantities,
  parseStatedRates, paymentWords, saleWords, saysDone, saysGeneral, serviceWords, settlesDebt, statedTotals, wageWords, warehouseWords, waterIsOpen,
  type StatedQuantity,
} from '@yap/shared/formulas/record-words';
import { convertQty, lineTotal, unitOf } from '@yap/shared/formulas/units';
import { schema } from '../../../db/client';
import { ctx, today, tx } from '../../../core/context';
import { accountTakesCurrency, fxRateIsPlausible } from '../../../core/ledger';
import { cashPosition } from '../../finance/summary';
import { listDebts } from '../../finance/debts.service';
import { defaultExpenseCategoryId } from '../../inventory/stock.service';
import {
  accountCandidates, accountSide, canLearn, categoryCandidates, costCenterCandidates, counterpartyCandidates, generalCenter,
  groundedIn, isRecordId, itemCandidates, namesAPlace, resolve, saysPartOf, singledOut, warehouseCandidates, type Candidate, type Resolution, type TargetType,
} from './resolve';
import {
  BARE_AMOUNT_FLOOR, BARE_PRICE_FLOOR, CATEGORY_RULES, MAX_RECORD_AGE_DAYS, OLD_RECORD_DAYS, POSSIBLE_RATES, STALE_RATE_DAYS, UNUSUAL_FACTOR,
  UNUSUAL_MIN_SAMPLES, type CategoryRule, type RecordKind,
} from './routing';
import type { DocumentAmount, DraftEnv, Learned, ProposalFields, Question, Ref, Validated, Warning } from './types';

/** Everything a draft tool may carry. All names are the person's words, resolved here. */
export interface DraftInput {
  amount?: number;
  currency?: string;
  fxRate?: number;
  date?: string;
  category?: string;
  target?: string;
  paymentMethod?: 'cash' | 'bank' | 'card' | 'debt';
  account?: string;
  toAccount?: string;
  counterparty?: string;
  description?: string;
  /** Goods used straight away or paid for as a service, not bought into stock. */
  direct?: boolean;
  item?: string;
  warehouse?: string;
  qty?: number;
  unit?: string;
  unitPrice?: number;
  direction?: 'payable' | 'receivable';
  /** Their own word for something they just picked from options: { item: "solyarka" }. */
  heardAs?: Record<string, string>;
}

const MAX_OPTIONS = 8;
const DESCRIPTION_LIMIT = 200;
const COUNTED_UNITS = new Set(['dose', 'vial', 'bale', 'pcs', 'head']);
const BULK_UNITS = new Set(['t', 'sentner']);
const option = (c: Candidate) => ({ id: c.id, label: c.name });
const ref = (c: Candidate): Ref => ({ id: c.id, name: c.name });
const categoryRef = (c: Candidate): Ref => ({ ...ref(c), translations: { uz: c.names[0], ru: c.names[1], en: c.names[2] } });

class Draft {
  questions: Question[] = [];
  warnings: Warning[] = [];
  learn: Learned[] = [];
  readonly newestFirst: string[];
  readonly mentions: MoneyMention[];
  readonly quantities: StatedQuantity[];

  constructor(readonly input: DraftInput, readonly env: DraftEnv, readonly previous?: DraftInput) {
    this.newestFirst = [...env.userTexts].reverse();
    this.mentions = this.newestFirst.flatMap((text) => parseMoneyMentions(text));
    // Read as a whole, oldest first, so a quantity taken back later is really gone.
    this.quantities = parseQuantities(env.userTexts.join('\n')).reverse();
  }

  get latest(): string {
    return this.env.userTexts.at(-1) ?? '';
  }

  get words(): string {
    return this.env.userTexts.join('\n');
  }

  /** The day a message was said, counted back from the newest. */
  dayOf(newest: number): string | undefined {
    const days = this.env.saidDays ?? [];
    return days[days.length - 1 - newest];
  }

  trusted(field: keyof DraftInput): boolean {
    if (this.env.fromForm) return true;
    const value = this.input[field];
    return value !== undefined && this.previous?.[field] === value;
  }

  answering(code: string): boolean {
    return this.env.answering?.includes(code) ?? false;
  }

  ask(field: string, code: string, hint: string, options: { id: string; label: string }[] = []) {
    // A long list cut to its first few would steer the answer, so it is asked in words instead.
    this.questions.push({ field, code, hint, options: options.length > MAX_OPTIONS ? [] : options });
  }

  warn(code: string, params: Record<string, unknown> = {}) {
    this.warnings.push({ code, params });
  }

  /** The words pick this record out. A word someone taught it is no record's name, so being said is enough. */
  names(phrase: string, found: Extract<Resolution, { status: 'found' }>, candidates: Candidate[]): boolean {
    if (found.how === 'alias') return groundedIn(this.env.userTexts, [phrase]);
    return singledOut(this.env.userTexts, phrase, found.candidate, candidates);
  }

  /** The note is the model's wording, so money in it must be money that was said. */
  get note(): string | null {
    const text = this.input.description?.replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_LIMIT);
    if (!text) return null;
    const said = (m: MoneyMention) => this.mentions.some((known) => known.amount === m.amount) || this.env.documentAmounts.some((read) => read.amount === m.amount);
    return this.trusted('description') || parseMoneyMentions(text).every((m) => m.bare || said(m)) ? text : null;
  }

  /** Only a word that matched nothing, that they really said, and that they just answered about. */
  private remember(type: TargetType, field: string, chosen: Candidate, candidates: Candidate[]) {
    const heard = this.input.heardAs?.[field];
    if (!heard || !this.answering(`${field.toUpperCase()}_UNKNOWN`)) return;
    if (!groundedIn(this.env.userTexts, [heard]) || !canLearn(heard, candidates)) return;
    this.learn.push({ phrase: heard, targetType: type, targetId: chosen.id, name: chosen.name });
  }

  /**
   * Resolve a name, asking when it is missing or matches several records. With `spoken`, a name must
   * also be in the person's words: a field, a machine or a person is never the model's guess.
   */
  async pick(
    type: TargetType,
    field: keyof DraftInput,
    phrase: string | undefined,
    candidates: Candidate[],
    hint: string,
    { spoken = false } = {},
  ): Promise<Candidate | null> {
    const code = field.toUpperCase();
    if (!phrase) {
      this.ask(field, `${code}_REQUIRED`, hint, candidates.map(option));
      return null;
    }
    const found: Resolution = await resolve(type, phrase, candidates);
    if (found.status === 'found') {
      const answered = ['AMBIGUOUS', 'REQUIRED', 'UNKNOWN'].some((kind) => this.answering(`${code}_${kind}`)) && saysPartOf(this.latest, found.candidate, candidates);
      if (spoken && !answered && !this.trusted(field) && !this.names(phrase, found, candidates)) {
        // "Bug'doy" with a feed and a seed: offer what their words fit. Failing that a long list says nothing, so offer the guess.
        const texts = this.env.userTexts;
        const heard = candidates.filter((c) => texts.some((text) => saysPartOf(text, c, [])) || groundedIn(texts, c.names, { thing: c.thing }));
        const fallback = candidates.length > MAX_OPTIONS ? [found.candidate] : candidates;
        if (heard.length > 1) this.ask(field, `${code}_AMBIGUOUS`, 'Their words fit several. Ask which one.', heard.map(option));
        else this.ask(field, `${code}_REQUIRED`, `The person did not name this. ${hint}`, (heard.length === 1 ? heard : fallback).map(option));
        return null;
      }
      // A word someone taught it decided this, so the card must say so.
      if (found.how === 'alias') this.warn('PHRASE_USED', { phrase, name: found.candidate.name });
      this.remember(type, field, found.candidate, candidates);
      return found.candidate;
    }
    if (found.status === 'ambiguous') {
      this.ask(field, `${code}_AMBIGUOUS`, `"${phrase}" matches several. Ask which one.`, found.candidates.map(option));
    } else {
      this.ask(field, `${code}_UNKNOWN`, `No record matches "${phrase}". Ask which one, or use find_records.`, candidates.map(option));
    }
    return null;
  }
}

const SCALE_ANSWER = /^(ming|минг|тысяч|тыс|thousand)[.!]*$/i;

interface AmountSource {
  mention: MoneyMention | null;
  document: DocumentAmount | null;
}

/** Money said once backs one card, however many records the model hangs on it. */
function spokenFor(d: Draft, amount: number): boolean {
  const said = d.env.userTexts.flatMap((text) => parseMoneyMentions(text)).filter((m) => m.amount === amount && !m.negated && !m.uncertain && !m.rate && !m.perUnit);
  return (d.env.onCards ?? []).filter((used) => used === amount).length >= Math.max(said.length, 1);
}

function askUsed(d: Draft, field: string, amount: number) {
  d.ask(field, 'AMOUNT_ALREADY_USED', `${amount} was said once and is on a card already. Ask how much this one was, or whether it was that much each.`);
}

/** "Elektr va gazga 3 mlndan", "по 500 тысяч: за интернет и нотариусу": that much for each, so each card gets it. */
function eachOfSeveral(d: Draft, amount: number): MoneyMention | null {
  for (const text of d.newestFirst) {
    const each = findMention(parseMoneyMentions(text), amount, { currency: d.input.currency, perUnit: true });
    if (each?.perUnit === 'unit' && (joinsThings(text) || d.answering('AMOUNT_ALREADY_USED'))) return each;
  }
  return null;
}

/**
 * A sum to tap. What is tapped comes back as the person's own words, and the web shows a bare number as so'm,
 * so foreign money says so in its id as well: "600 USD".
 */
function amountOption(amount: number, currency: string | null | undefined, label = String(amount)) {
  if (!currency || currency === ctx().currency) return { id: String(amount), label };
  const said = `${amount} ${currency}`;
  return { id: said, label: said };
}

/** Their own words outrank a document: a difference between the two is asked about, never settled. */
function amountFromDocument(d: Draft, amount: number, field: string): AmountSource | null {
  const read = d.env.documentAmounts.find((a) => a.amount === amount);
  if (!read) {
    d.ask(field, 'AMOUNT_NOT_STATED', `The person's words do not contain ${amount}. Ask them to state the amount. Do not repeat a guess.`);
    return null;
  }
  if (spokenFor(d, amount)) {
    askUsed(d, field, amount);
    return null;
  }
  // Answering which is right may need no number at all: "chekdagisi to'g'ri".
  const said = d.answering('AMOUNT_CONFLICT') ? [] : d.mentions.filter((m) => !m.negated && !m.rate && !m.perUnit && !spokenFor(d, m.amount));
  if (said.length > 0) {
    d.ask(field, 'AMOUNT_CONFLICT', 'Their words and the document give different amounts. Ask which is right.', [
      ...said.map((m) => amountOption(m.amount, m.currency, m.raw)),
      amountOption(amount, read.currency),
    ]);
    return null;
  }
  d.warn('AMOUNT_FROM_DOCUMENT', { amount });
  return { mention: null, document: read };
}

/** Asked "15 ming or 15 so'm?" about a price, the answer says how much and the question already said per what. */
function answeredPrice(d: Draft, amount: number): MoneyMention | null {
  if (!d.answering('AMOUNT_UNCLEAR')) return null;
  const said = findMention(parseMoneyMentions(d.latest), amount, { currency: d.input.currency });
  const asked = d.mentions.find((m) => m.perUnit && m.bare && (m.amount === amount || m.amount * 1_000 === amount));
  return said && asked ? { ...said, perUnit: asked.perUnit } : null;
}

const hasNoScale = (d: Draft, mention: MoneyMention) =>
  mention.bare && !mention.currency && !(d.answering('AMOUNT_UNCLEAR') && currencyOf(d.latest.trim()) !== null);

function askScale(d: Draft, field: string, mention: MoneyMention, amount: number) {
  d.ask(field, 'AMOUNT_UNCLEAR', `"${mention.raw}" has no ming or mln. Ask what they meant.`, [
    { id: String(amount * 1_000), label: `${amount} ming` },
    { id: String(amount), label: `${amount} so'm` },
  ]);
}

/** "Не 5, а 7" on a card of 5 mln keeps the scale said before, and 7 so'm is not what they meant. */
function sameScaleAsBefore(d: Draft, amount: number): MoneyMention | null {
  const before = d.previous?.amount;
  if (!before) return null;
  const scale = [1_000_000, 1_000].find((s) => before % s === 0 && amount % s === 0);
  if (!scale) return null;
  const said = parseMoneyMentions(d.latest).find((m) => m.bare && !m.negated && !m.uncertain && m.amount === amount / scale);
  return said ? { ...said, amount, bare: false } : null;
}

/** Amounts must come from the person's words or their document, never from the model. */
function checkAmount(d: Draft, amount: number | undefined, field: 'amount' | 'unitPrice' = 'amount'): AmountSource | null {
  if (amount === undefined || !(amount > 0)) {
    d.ask(field, 'AMOUNT_REQUIRED', 'Ask how much it was.');
    return null;
  }
  if (d.trusted(field)) return { mention: null, document: null };
  const perUnit = field === 'unitPrice';
  const each = perUnit ? null : eachOfSeveral(d, amount);
  if (each) return { mention: each, document: null };
  const mention = (perUnit ? answeredPrice(d, amount) : null) ?? findMention(d.mentions, amount, { currency: d.input.currency, perUnit });
  if (!mention) {
    const kept = perUnit ? null : sameScaleAsBefore(d, amount);
    if (kept) return { mention: kept, document: null };
    // Asked "500 ming or 500 so'm?", the one word "ming" is a full answer.
    const scaled = d.answering('AMOUNT_UNCLEAR') && SCALE_ANSWER.test(d.latest.trim());
    if (scaled) {
      const bare = d.mentions.find((m) => m.bare && m.amount * 1_000 === amount);
      if (bare) return { mention: { ...bare, amount, bare: false }, document: null };
    }
    return amountFromDocument(d, amount, field);
  }
  if (!perUnit && spokenFor(d, amount)) {
    askUsed(d, field, amount);
    return null;
  }
  if (!perUnit && hasNoScale(d, mention) && amount < BARE_AMOUNT_FLOOR) askScale(d, field, mention, amount);
  return { mention, document: null };
}

const currencyCode = (value: string | undefined | null) => (value ? (currencyOf(value) ?? value.toUpperCase()) : undefined);

async function resolveRate(d: Draft, currency: string, date: string): Promise<number> {
  if (d.input.fxRate !== undefined && d.trusted('fxRate')) return d.input.fxRate;
  const c = ctx();
  const stated = d.newestFirst.flatMap((text) => parseStatedRates(text, currency));
  // Asked for the rate, a plain number is the answer: "12700". "300 dollar edi" corrects the amount.
  const plainNumber = (m: MoneyMention) => !m.negated && !m.uncertain && (!m.currency || m.currency === c.currency);
  if (d.answering('FX_RATE_REQUIRED')) stated.unshift(...parseMoneyMentions(d.latest).filter(plainNumber).map((m) => m.amount));
  const { fxRates } = schema;
  const [saved] = await tx()
    .select({ rate: fxRates.rate, date: fxRates.date })
    .from(fxRates)
    .where(and(eq(fxRates.tenantId, c.tenantId), eq(fxRates.currency, currency), lte(fxRates.date, date)))
    .orderBy(desc(fxRates.date))
    .limit(1);

  const distinct = [...new Set(stated)];
  if (distinct.length > 1) {
    d.ask('fxRate', 'FX_RATE_REQUIRED', 'They gave several rates. Ask which one.', distinct.map((r) => ({ id: String(r), label: String(r) })));
    return 1;
  }
  if (distinct.length === 1) {
    const [rate] = distinct;
    // The ledger would refuse this at confirm, so it is a question now.
    if (saved && !fxRateIsPlausible(rate, saved.rate)) {
      d.ask('fxRate', 'FX_RATE_REQUIRED', `${rate} is far from the stored rate of ${saved.rate}. Ask them to check it.`);
      return 1;
    }
    const [lowest, highest] = POSSIBLE_RATES[currency] ?? [0, Infinity];
    if (!saved && (rate < lowest || rate > highest)) {
      d.ask('fxRate', 'FX_RATE_REQUIRED', `${rate} cannot be the ${currency} rate. Ask them to check it.`);
      return 1;
    }
    return rate;
  }
  if (saved) {
    if (diffDays(saved.date, date) > STALE_RATE_DAYS) d.warn('STALE_RATE', { date: saved.date, rate: saved.rate });
    return saved.rate;
  }
  d.ask('fxRate', 'FX_RATE_REQUIRED', `There is no ${currency} rate. Ask for it.`);
  return 1;
}

async function resolveCurrency(d: Draft, source: AmountSource | null, date: string) {
  const base = ctx().currency;
  if (source?.mention?.unknownCurrency) {
    d.ask('currency', 'CURRENCY_UNSUPPORTED', `"${source.mention.unknownCurrency}" is not a currency kept here. Ask what it comes to in so'm.`);
    return { currency: base, fxRate: 1 };
  }
  const claimed = currencyCode(d.input.currency);
  const said = currencySaid(d.latest);
  let currency = source?.mention?.currency ?? source?.document?.currency ?? null;
  if (!currency) {
    if (claimed && d.trusted('currency')) currency = claimed;
    // A currency word stands alone as an answer, or as a correction: "so'm", "dollar edi".
    else if (said && (said === claimed || d.answering('CURRENCY_UNCLEAR'))) currency = said;
    // A currency the model added on its own has no basis in what the person said.
    else if (claimed && claimed !== base) {
      d.ask('currency', 'CURRENCY_UNCLEAR', 'The person did not name this currency. Ask which it was.');
      return { currency: base, fxRate: 1 };
    }
  }
  const resolved = currency ?? base;
  if (resolved === base) return { currency: resolved, fxRate: 1 };
  return { currency: resolved, fxRate: await resolveRate(d, resolved, date) };
}

function isRealDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/** The day the words pin down, or today when they name none. The model's date only has to agree. */
function checkDate(d: Draft): string {
  const now = d.env.saidOn ?? today();
  // With no day in the words, the money moved by the time the record was first said.
  const firstSaid = d.env.saidDays?.[0] ?? now;
  const given = d.input.date;
  const unclear = (hint = 'Ask which day this was.', days: string[] = []) => {
    d.ask('date', 'DATE_UNCLEAR', hint, days.map((day) => ({ id: day, label: day })));
    return now;
  };

  let date: string;
  if (given !== undefined && !isRealDate(given)) return unclear();
  if (given !== undefined && d.trusted('date')) {
    date = given;
  } else {
    // "Bugun" means the day it was said, which may be yesterday by the time the answer comes.
    const evidence = d.newestFirst.map((text, i) => dateEvidence(text, d.dayOf(i) ?? now)).find((e) => e.dates.length > 0 || e.vague || e.future);
    const days = evidence?.dates ?? [];
    if (evidence?.future && days.length === 0) {
      d.ask('date', 'DATE_IN_FUTURE', 'This has not happened yet. Ask whether it has been paid, and on which day.');
      return now;
    }
    if (given !== undefined) {
      const agrees = !evidence?.vague && (days.length > 0 ? days.includes(given) : given === now || given === firstSaid);
      if (!agrees) return unclear('The date does not match their words. Ask which day this was.', days);
      date = days.length > 0 ? given : firstSaid;
    } else if (evidence?.vague) {
      return unclear('They did not say which day. Ask for the exact day.');
    } else if (days.length > 1) {
      return unclear('They named several days. Ask which day this one was.', days);
    } else {
      date = days[0] ?? firstSaid;
    }
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

/** A card payment goes through a bank account when the farm keeps no separate card account. */
function accountFits(account: Candidate, method: string): boolean {
  const type = account.extra?.type;
  return type === method || (method === 'card' && type === 'bank');
}

/** How it was paid is never assumed: it must be in their words, and those words can fill it in. */
async function checkPayment(d: Draft, stated: DraftInput['paymentMethod'], { settlement = false } = {}) {
  const accounts = await accountCandidates();
  if (accounts.length === 0 && stated !== 'debt') {
    d.ask('account', 'NO_ACCOUNT', 'This farm has no accounts yet. Tell them to add one in Finance first.');
    return { method: null, account: null };
  }
  // In the form only what was typed speaks: the first words must not overrule the account chosen there.
  const named = d.env.fromForm ? [] : paymentWords(d.words).filter((word) => !(settlement && word === 'debt'));
  // "Agrobank plastikdan" is one payment: a card is paid through a bank.
  const said = named.includes('card') ? named.filter((word) => word !== 'bank') : named;
  let phrase = d.input.account;
  let method = stated;
  const fromPhrase = phrase ? await resolve('account', phrase, accounts) : null;
  if (fromPhrase?.status === 'found' && !d.trusted('account') && !d.names(phrase!, fromPhrase, accounts)) phrase = undefined;
  // An account they named can stand for how it was paid, but never for a debt: that takes their own word.
  if (method && !d.trusted('paymentMethod') && !said.includes(method) && (!phrase || method === 'debt')) method = undefined;
  if (!method && said.length === 1) [method] = said;

  if (!method && !phrase) {
    d.ask('paymentMethod', 'PAYMENT_METHOD_REQUIRED', 'Ask how it was paid.', [
      { id: 'cash', label: 'cash' }, { id: 'bank', label: 'bank' }, ...(settlement ? [] : [{ id: 'debt', label: 'debt' }]),
    ]);
    return { method: null, account: null };
  }
  if (method === 'debt') return { method, account: null };

  let account: Candidate | null = null;
  if (phrase) {
    account = await d.pick('account', 'account', phrase, accounts, 'Ask which account.');
  } else {
    const ofType = accounts.filter((a) => a.extra?.type === method);
    if (ofType.length === 1) [account] = ofType;
    else d.ask('account', 'ACCOUNT_REQUIRED', 'Ask which account.', (ofType.length ? ofType : accounts.filter((a) => accountFits(a, method!))).map(option));
  }
  // A card that says "bank" over a cash account can never be right, whoever produced it.
  if (method && account && !accountFits(account, method)) {
    d.ask('account', 'ACCOUNT_REQUIRED', `${account.name} is not a ${method} account. Ask which account it was.`, accounts.filter((a) => accountFits(a, method!)).map(option));
    return { method, account: null };
  }
  return { method: method ?? (account?.extra?.type as 'cash' | 'bank' | 'card' | undefined) ?? null, account };
}

function checkAccountCurrency(d: Draft, account: Candidate | null, currency: string) {
  const own = account?.extra?.currency as string | undefined;
  if (!account || !own || own === currency) return;
  if (!accountTakesCurrency(own, currency)) {
    d.ask('account', 'ACCOUNT_CURRENCY', `${account.name} is kept in ${own}, and this is ${currency}. Ask which account it was, or for the amount in ${own}.`);
    return;
  }
  // Dollars said, a so'm account named: what leaves it is the so'm value, so the person must agree to that.
  d.warn('CURRENCY_CONVERTED', { account: account.name, currency: own });
}

/**
 * Later words replace earlier ones. Fields that describe one thing replace each other: "no, by bank"
 * must not leave the old cash account behind, and a new unit price replaces the old total.
 */
export function mergeDraft(stored: DraftInput, changes: DraftInput): DraftInput {
  const merged = { ...stored, ...changes };
  if (changes.paymentMethod && !changes.account) delete merged.account;
  if (changes.account && !changes.paymentMethod) delete merged.paymentMethod;
  if (changes.amount !== undefined && changes.unitPrice === undefined) delete merged.unitPrice;
  if (changes.unitPrice !== undefined && changes.amount === undefined) delete merged.amount;
  if (changes.qty !== undefined && changes.unit === undefined) delete merged.unit;
  return merged;
}

async function checkCounterparty(d: Draft, required: boolean): Promise<Candidate | null> {
  const candidates = await counterpartyCandidates();
  const phrase = d.input.counterparty;
  if (required) return d.pick('counterparty', 'counterparty', phrase, candidates, 'Ask who this was with.', { spoken: true });
  if (!phrase) return null;

  // Paid on the spot, a name is only a note: "notariusga" need not be a registered counterparty.
  const found = await resolve('counterparty', phrase, candidates);
  if (found.status === 'ambiguous') return d.pick('counterparty', 'counterparty', phrase, candidates, 'Ask who this was with.');
  // The record the card pointed at is closed: that is news for the person, and no note.
  if (found.status === 'none' && isRecordId(phrase)) return d.pick('counterparty', 'counterparty', phrase, candidates, 'Ask who this was with.');
  const spoken = d.trusted('counterparty') || (found.status === 'found' ? d.names(phrase, found, candidates) : groundedIn(d.env.userTexts, [phrase]));
  if (!spoken) return null;
  if (found.status === 'found') return found.candidate;
  d.input.description ??= phrase;
  return null;
}

function clearNoise(d: Draft) {
  d.learn = d.learn.filter((entry, i) => d.learn.findIndex((e) => e.targetType === entry.targetType && e.phrase === entry.phrase) === i);
}

/** Warnings about the money itself. The duplicate check runs live, on every view and at confirm. */
async function checkSanity(d: Draft, fields: ProposalFields, kind: RecordKind) {
  const c = ctx();
  const t = schema.transactions;
  if (fields.amountBase! >= c.settings.finance.approvalThreshold && c.settings.finance.makerChecker) {
    d.warn('NEEDS_APPROVAL', { threshold: c.settings.finance.approvalThreshold });
  }
  if (fields.target?.defaulted) d.warn('TARGET_DEFAULTED', { target: fields.target.name });

  const moneyOut = kind !== 'income' && !(kind === 'debt_payment' && fields.direction === 'receivable');
  if (fields.account && fields.paymentMethod !== 'debt' && moneyOut) {
    const { accounts } = await cashPosition();
    const account = accounts.find((a) => a.id === fields.account!.id);
    // In the account's own currency: a so'm account paying a dollar bill pays the so'm value.
    const needed = account?.currency === fields.currency ? fields.amount! : fields.amountBase!;
    if (account && account.balance < needed) d.warn('OVER_BALANCE', { account: fields.account.name, balance: account.balance });
  }

  if (kind === 'stock_purchase' && fields.item) {
    const b = schema.stockBatches;
    const [usual] = await tx()
      .select({
        samples: sql<number>`count(*)`.mapWith(Number),
        median: sql<number | null>`percentile_cont(0.5) within group (order by ${b.unitCost})`.mapWith(Number),
      })
      .from(b)
      .where(and(eq(b.farmId, c.farmId), eq(b.itemId, fields.item.id)));
    const price = fields.unitPrice! * (fields.fxRate ?? 1);
    if (usual.samples >= UNUSUAL_MIN_SAMPLES && usual.median && (price > usual.median * UNUSUAL_FACTOR || price < usual.median / UNUSUAL_FACTOR)) {
      d.warn('UNUSUAL_PRICE', { median: usual.median });
    }
    return;
  }
  if (!fields.category) return;
  const [usual] = await tx()
    .select({
      samples: sql<number>`count(*)`.mapWith(Number),
      median: sql<number | null>`percentile_cont(0.5) within group (order by ${t.amountBase})`.mapWith(Number),
    })
    .from(t)
    .where(and(eq(t.farmId, c.farmId), eq(t.categoryId, fields.category.id), inArray(t.status, ['approved', 'pending'])));
  if (usual.samples >= UNUSUAL_MIN_SAMPLES && usual.median && fields.amountBase! > usual.median * UNUSUAL_FACTOR) {
    d.warn('UNUSUALLY_LARGE', { median: usual.median });
  }
}

const emptyFields = (): ProposalFields => ({
  amount: 0, currency: 'UZS', fxRate: null, amountBase: 0, date: '', category: null, target: null, account: null,
  toAccount: null, paymentMethod: null, counterparty: null, item: null, warehouse: null, qty: null, unitPrice: null,
  costTreatment: null, direction: null, description: null,
});

async function pickCategory(d: Draft, kind: 'expense' | 'income') {
  const candidates = await categoryCandidates(kind);
  const found = await d.pick('category', 'category', d.input.category, candidates, 'Ask what this was for.');
  if (!found) return null;
  const key = candidates.find((c) => c.id === found.id)!.key;
  const open = (key === 'water' || key === 'utility_water') && !d.trusted('category') && !d.answering('CATEGORY_AMBIGUOUS');
  if (open && waterIsOpen(d.words) && !namesAPlace(d.env.userTexts)) {
    const both = candidates.filter((c) => c.key === 'water' || c.key === 'utility_water');
    d.ask('category', 'CATEGORY_AMBIGUOUS', 'Water may be for a field or the office. Ask which.', both.map(option));
    return null;
  }
  const rule: CategoryRule | undefined = CATEGORY_RULES[key];
  if (rule?.ownedBy) {
    d.ask('category', 'USE_OTHER_MODULE', `This belongs to ${rule.ownedBy}. Explain that it must be entered there, so it is not counted twice. Do not draft it.`);
    return null;
  }
  return { candidate: found, key, rule: rule ?? { targets: [], generalAllowed: true } };
}

/** "General" counts as an answer only if they said so: a whole word, not a name that starts with it. */
const GENERAL_WORD = /^(general|shared|umumiy|умумий|общ(ий|ее|ая|ие|ие расходы)?)$/i;

async function pickTarget(d: Draft, rule: CategoryRule): Promise<ProposalFields['target']> {
  const general = await generalCenter();
  const toTarget = (c: Candidate, defaulted: boolean) => ({ costCenterId: c.id, type: String(c.extra?.type), name: c.name, defaulted });
  // A new seeder is not the old one: capital spending reaches a machine or field through depreciation.
  if (rule.treatment === 'capex') return general ? toTarget(general, false) : null;
  let phrase = d.input.target;
  const saidGeneral = phrase !== undefined && GENERAL_WORD.test(phrase.trim());
  if (saidGeneral) {
    if (rule.generalAllowed && general && (d.trusted('target') || saysGeneral(d.words))) return toTarget(general, false);
    phrase = undefined;
  }

  if (rule.targets.length === 0) {
    // General unless they chose otherwise. A place the person named but we cannot find is asked about.
    const options = [...(await costCenterCandidates(['field', 'herd', 'asset'])), ...(general ? [general] : [])];
    const places = options.filter((c) => c.extra?.type !== 'general');
    if (phrase) {
      const chosen = await resolve('cost_center', phrase, options);
      const named = chosen.status === 'found' ? d.names(phrase, chosen, options) : groundedIn(d.env.userTexts, [phrase]);
      if (d.trusted('target') || named) {
        const found = await d.pick('cost_center', 'target', phrase, options, 'Ask which one this was for.');
        return found ? toTarget(found, false) : null;
      }
      // They named a place that code cannot confirm, so it must not quietly stay on General.
      if (namesAPlace(d.env.userTexts) || places.some((c) => groundedIn(d.env.userTexts, [c.name, ...c.names]))) {
        const offered = chosen.status === 'found' ? [chosen.candidate, ...(general ? [general] : [])] : options;
        d.ask('target', 'TARGET_REQUIRED', 'They named a place. Ask which one this was for.', offered.map(option));
        return null;
      }
    } else if (!d.env.fromForm) {
      // The model may leave out a place they did name: "3-dala nasosi uchun elektrga".
      const named = places.filter((c) => singledOut(d.env.userTexts, c.name, c, options));
      if (named.length === 1) return toTarget(named[0], false);
      if (named.length > 1 || namesAPlace(d.env.userTexts)) {
        d.ask('target', 'TARGET_REQUIRED', 'They named a place. Ask which one this was for.', (named.length > 1 ? named : options).map(option));
        return null;
      }
    }
    return general ? toTarget(general, true) : null;
  }

  const candidates = await costCenterCandidates(rule.targets);
  if (rule.generalAllowed && general) candidates.push(general);
  if (!phrase) {
    // Their words may name it even if the model left it out: "kombayn ijarasi".
    const named = candidates.filter((c) => c.id !== general?.id && singledOut(d.env.userTexts, c.name, c, candidates));
    if (named.length === 1) return toTarget(named[0], false);
    if (rule.generalAllowed || rule.alwaysAsk) {
      d.ask('target', 'TARGET_REQUIRED', 'Ask what this was for, or whether it is a shared cost.', candidates.map(option));
      return null;
    }
    if (candidates.length === 1) return toTarget(candidates[0], true);
  }
  // The only herd is the only answer, unless their words name something else.
  if (phrase && candidates.length === 1 && !rule.generalAllowed && !rule.alwaysAsk && !d.trusted('target')) {
    const [only] = candidates;
    if (singledOut(d.env.userTexts, phrase, only, candidates)) return toTarget(only, false);
    if (!groundedIn(d.env.userTexts, [phrase])) return toTarget(only, true);
  }
  const found = await d.pick('cost_center', 'target', phrase, candidates, 'Ask which one this was for.', { spoken: true });
  return found ? toTarget(found, false) : null;
}

/**
 * Whether goods bought with this money skip the warehouse. Never the model's say-so alone: the
 * person answered, said so, or named the machine or field it went into.
 */
function goesDirect(d: Draft): boolean {
  const { direct, target } = d.input;
  const toWarehouse = d.answering('GOODS_STOCK_OR_DIRECT') && warehouseWords(d.latest) && !directUseWords(d.latest);
  if (direct && !toWarehouse && (d.trusted('direct') || d.answering('GOODS_STOCK_OR_DIRECT'))) return true;
  if (direct && target && groundedIn(d.env.userTexts, [target])) return true;
  return serviceWords(d.words) || directUseWords(d.words);
}

/** The job may have been said a message ago, and an answer that it was a service stands for the rest of the exchange. */
function wageQuestion(d: Draft) {
  if (d.env.fromForm) return;
  if (d.answering('WAGE_OR_SERVICE')) {
    if (monthlyWord(d.latest)) d.ask('category', 'USE_OTHER_MODULE', 'This is their wage. Explain that it is entered in payroll, so it is not counted twice. Do not draft it.');
    return;
  }
  if (wageWords(d.words) && !d.env.userTexts.slice(1).some(serviceWords)) {
    d.ask('category', 'WAGE_OR_SERVICE', "This sounds like someone's pay. Ask whether it is their wage, which belongs in payroll, or a service paid for.", [
      { id: 'wage', label: 'wage' }, { id: 'service', label: 'service' },
    ]);
  }
}

/** "Neft Bazaga qarzimizni to'ladim" pays what the books already owe: as an expense it would count twice. */
async function checkNotASettlement(d: Draft, counterparty: Candidate | null) {
  if (!counterparty || d.env.fromForm || d.previous || d.answering('KIND_UNCLEAR') || !settlesDebt(d.words)) return;
  const owed = (await listDebts('payable')).some((debt) => debt.counterpartyId === counterparty.id && debt.outstanding > 0);
  if (owed) d.ask('kind', 'KIND_UNCLEAR', `This pays off what is owed to ${counterparty.name}. Use draft_debt_payment, or ask if it was something else.`);
}

async function validateExpense(d: Draft): Promise<ProposalFields | null> {
  const i = d.input;
  const source = checkAmount(d, i.amount);
  const date = checkDate(d);
  const category = await pickCategory(d, 'expense');
  wageQuestion(d);
  const direct = category?.rule.goods ? goesDirect(d) : false;
  if (category?.rule.goods && !direct) {
    d.ask('direct', 'GOODS_STOCK_OR_DIRECT', 'These may be goods. Ask whether they went into the warehouse, then use draft_stock_purchase with the quantity, or were used straight away or paid for as a service, then set direct and the target.', [
      { id: 'stock', label: 'warehouse' }, { id: 'direct', label: 'used directly' },
    ]);
    return null;
  }
  i.direct = direct || undefined;
  const target = category ? await pickTarget(d, category.rule) : null;
  const payment = await checkPayment(d, i.paymentMethod);
  const counterparty = await checkCounterparty(d, payment.method === 'debt');
  await checkNotASettlement(d, counterparty);
  const { currency, fxRate } = await resolveCurrency(d, source, date);
  checkAccountCurrency(d, payment.account, currency);
  if (d.questions.length > 0 || !category || !i.amount) return null;

  return {
    ...emptyFields(),
    amount: i.amount, currency, fxRate, amountBase: toBaseAmount(i.amount, fxRate), date,
    category: categoryRef(category.candidate), target, account: payment.account ? ref(payment.account) : null,
    paymentMethod: payment.method, counterparty: counterparty ? ref(counterparty) : null,
    costTreatment: category.rule.treatment ?? 'expense', description: d.note,
  };
}

interface StatedLine {
  /** In the item's own unit. */
  qty: number;
  stated: number;
  unit: string;
}

/** A quantity must be in their words too. A unit they said cannot be lost on the way. */
function checkQuantity(d: Draft, itemUnit: string): StatedLine | null {
  const i = d.input;
  if (!i.qty || !(i.qty > 0)) {
    d.ask('qty', 'QUANTITY_REQUIRED', 'Ask how much was bought. If it went straight into a machine, field or herd and not the warehouse, it is draft_expense with direct and the target instead.');
    return null;
  }
  if (d.trusted('qty')) return { qty: i.qty, stated: i.qty, unit: itemUnit };

  const inItemUnit = (q: StatedQuantity) => {
    if (COUNTED_UNITS.has(itemUnit) && /^(ta|та)$/i.test(q.unit)) return q.qty;
    return convertQty(q.qty, q.unit, itemUnit);
  };
  const same = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-6;
  const said =
    d.quantities.find((q) => q.qty === i.qty && (!i.unit || unitOf(i.unit) === null || unitOf(i.unit) === unitOf(q.unit))) ??
    d.quantities.find((q) => same(inItemUnit(q), i.qty!));
  if (!said) {
    d.ask('qty', 'QUANTITY_NOT_STATED', `Their words do not contain this quantity. Ask how much it was, in ${itemUnit}.`);
    return null;
  }
  // "300 litr edi" takes nothing back in so many words, yet the older 200 no longer stands.
  const newest = d.env.userTexts.length > 1 ? parseQuantities(d.latest).map((q) => convertQty(q.qty, q.unit, said.unit)).filter((qty) => qty !== null) : [];
  if (newest.length > 0 && !newest.includes(said.qty)) {
    d.ask('qty', 'QUANTITY_NOT_STATED', 'Their latest message gives another quantity. Ask how much it was.');
    return null;
  }
  const qty = inItemUnit(said);
  if (qty === null) {
    d.ask('qty', 'UNIT_MISMATCH', `This item is kept in ${itemUnit}. Ask for the quantity in ${itemUnit}.`);
    return null;
  }
  return { qty: round(qty, 3), stated: said.qty, unit: said.unit };
}

/**
 * A total or a unit price, whichever the person said. Code does the multiplication, in the unit the
 * price was said in. If they gave both and the two do not agree, that is a question.
 */
function checkPrice(d: Draft, line: StatedLine | null) {
  const i = d.input;
  const nothing = { amount: undefined, source: null as AmountSource | null, fromPrice: false };
  if (!line) return nothing;
  if (i.unitPrice !== undefined && i.amount === undefined && d.trusted('unitPrice')) {
    return { amount: round(i.unitPrice * line.qty, 2), source: { mention: null, document: null }, fromPrice: true };
  }

  const total = i.amount !== undefined && (d.trusted('amount') || findMention(d.mentions, i.amount, { currency: i.currency })) ? i.amount : undefined;
  // The model may hand over a worked-out total, or a unit price as if it were the total.
  const price =
    i.unitPrice ??
    (i.amount !== undefined && findMention(d.mentions, i.amount, { perUnit: true }) ? i.amount : undefined) ??
    (i.amount !== undefined && total === undefined ? d.mentions.find((m) => m.perUnit && lineTotal(line.stated, line.unit, m.amount, m.perUnit === 'unit' ? line.unit : m.perUnit) === i.amount)?.amount : undefined);

  if (price !== undefined) {
    const source = checkAmount(d, price, 'unitPrice');
    const mention = source?.mention;
    // "2 tonna, 3 mingdan" could be per tonne or per kilo, and that is a thousand times the money.
    if (mention?.perUnit === 'unit' && BULK_UNITS.has(unitOf(line.unit) ?? '')) {
      d.ask('unitPrice', 'PRICE_UNIT_UNCLEAR', 'Ask whether that price is per tonne or per kilo.', [
        { id: 'per_ton', label: 'per tonne' }, { id: 'per_kg', label: 'per kg' },
      ]);
      return nothing;
    }
    const priceUnit = mention?.perUnit && mention.perUnit !== 'unit' ? mention.perUnit : line.unit;
    const computed = lineTotal(line.stated, line.unit, price, priceUnit);
    const currency = mention?.currency ?? currencyCode(i.currency);
    if (source && computed === null) {
      d.ask('unitPrice', 'UNIT_MISMATCH', 'The price is for a different unit than the quantity. Ask for the total.');
      return nothing;
    }
    if (total !== undefined && computed !== null && Math.abs(computed - total) > 1) {
      d.ask('amount', 'AMOUNT_AMBIGUOUS', `The quantity at that price comes to ${computed}, not ${total}. Ask which is right.`, [
        amountOption(total, currency), amountOption(computed, currency),
      ]);
      return nothing;
    }
    // The model may leave out a total that the person did say, and that does not fit the price.
    const claimed = statedTotals(d.words).find((sum) => computed !== null && Math.abs(sum - computed) > 1);
    if (total === undefined && claimed !== undefined && !d.trusted('unitPrice')) {
      d.ask('amount', 'AMOUNT_AMBIGUOUS', `The quantity at that price comes to ${computed}, not ${claimed}. Ask which is right.`, [
        amountOption(claimed, currency), amountOption(computed!, currency),
      ]);
      return nothing;
    }
    if (total === undefined) {
      // What a bare price comes to is a bare amount too: "3 ta qo'chqor 500 dan" is not 1500 so'm.
      if (mention && hasNoScale(d, mention) && (price < BARE_PRICE_FLOOR || (computed ?? 0) < BARE_AMOUNT_FLOOR)) askScale(d, 'unitPrice', mention, price);
      return { amount: computed ?? undefined, source, fromPrice: true };
    }
  }
  return { amount: total ?? i.amount, source: checkAmount(d, i.amount), fromPrice: false };
}

/** The item decides the expense category, except for goods with none, which the ledger would refuse. */
async function stockCategory(d: Draft, item: Candidate): Promise<Ref | null> {
  if (await defaultExpenseCategoryId(String(item.extra?.category))) return null;
  const candidates = await categoryCandidates('expense');
  const found = await d.pick('category', 'category', d.input.category, candidates, `${item.name} has no expense category. Ask which one this purchase belongs to.`);
  return found ? categoryRef(found) : null;
}

async function validateStockPurchase(d: Draft): Promise<ProposalFields | null> {
  const i = d.input;
  const date = checkDate(d);
  const items = await itemCandidates();
  const item = await d.pick('item', 'item', i.item, items, 'Ask what was bought.', { spoken: true });
  const unit = String(item?.extra?.unit ?? '');
  const line = item ? checkQuantity(d, unit) : null;
  const category = item ? await stockCategory(d, item) : null;
  const { amount, source, fromPrice } = checkPrice(d, line);
  const qty = line?.qty;

  const warehouses = await warehouseCandidates();
  const defaultId = item?.extra?.defaultWarehouseId;
  const warehouse = i.warehouse
    ? await d.pick('warehouse', 'warehouse', i.warehouse, warehouses, 'Ask which warehouse.')
    : (warehouses.find((w) => w.id === defaultId) ?? null);
  if (!i.warehouse && !warehouse) d.ask('warehouse', 'WAREHOUSE_REQUIRED', 'Ask which warehouse.', warehouses.map(option));

  const payment = await checkPayment(d, i.paymentMethod);
  const counterparty = await checkCounterparty(d, payment.method === 'debt');
  const { currency, fxRate } = await resolveCurrency(d, source, date);
  checkAccountCurrency(d, payment.account, currency);
  if (d.questions.length > 0 || !item || !qty || !amount) return null;

  // Keeps what they actually said, so a new quantity moves the total only if the price was what they gave.
  if (fromPrice) {
    // Unrounded, or the re-check at confirm can land a tiyin away and call a correct card stale.
    i.unitPrice = amount / qty;
    delete i.amount;
  } else {
    i.amount = amount;
    delete i.unitPrice;
  }
  i.qty = qty;
  delete i.unit;

  return {
    ...emptyFields(),
    amount, currency, fxRate, amountBase: toBaseAmount(amount, fxRate), date, category,
    item: { ...ref(item), unit }, warehouse: warehouse ? ref(warehouse) : null, qty, unitPrice: round(amount / qty, 4),
    account: payment.account ? ref(payment.account) : null, paymentMethod: payment.method,
    counterparty: counterparty ? ref(counterparty) : null, costTreatment: 'inventory', description: d.note,
  };
}

async function validateIncome(d: Draft): Promise<ProposalFields | null> {
  const i = d.input;
  const source = checkAmount(d, i.amount);
  const date = checkDate(d);
  const category = await pickCategory(d, 'income');
  const target = category ? await pickTarget(d, category.rule) : null;
  const payment = await checkPayment(d, i.paymentMethod);
  const counterparty = await checkCounterparty(d, payment.method === 'debt');
  const { currency, fxRate } = await resolveCurrency(d, source, date);
  checkAccountCurrency(d, payment.account, currency);
  if (d.questions.length > 0 || !category || !i.amount) return null;
  return {
    ...emptyFields(),
    amount: i.amount, currency, fxRate, amountBase: toBaseAmount(i.amount, fxRate), date,
    category: categoryRef(category.candidate), target, account: payment.account ? ref(payment.account) : null,
    paymentMethod: payment.method, counterparty: counterparty ? ref(counterparty) : null, description: d.note,
  };
}

/** Who paid whom must be in their words: guessed, a debt moves the wrong way. */
function checkDirection(d: Draft): DraftInput['direction'] {
  const stated = d.input.direction;
  if (stated && d.trusted('direction')) return stated;
  const said = directionWords(d.words);
  if (said.length === 1 && (!stated || stated === said[0])) return said[0];
  d.ask('direction', 'DIRECTION_REQUIRED', 'Ask whether we paid them, or they paid us.', [
    { id: 'payable', label: 'we paid' }, { id: 'receivable', label: 'they paid' },
  ]);
  return undefined;
}

async function validateDebtPayment(d: Draft): Promise<ProposalFields | null> {
  const i = d.input;
  const source = checkAmount(d, i.amount);
  const date = checkDate(d);
  if (!d.env.fromForm && advanceWords(d.words)) {
    d.ask('category', 'USE_OTHER_MODULE', 'Paying ahead for goods not yet received does not settle a debt. Explain that it is entered in Finance.');
    return null;
  }
  const direction = checkDirection(d);
  const counterparty = await checkCounterparty(d, true);
  const payment = await checkPayment(d, i.paymentMethod === 'debt' ? undefined : i.paymentMethod, { settlement: true });
  const { currency } = await resolveCurrency(d, source, date);
  if (currency !== ctx().currency) {
    d.ask('currency', 'CURRENCY_NOT_SUPPORTED', 'A debt is settled here in the base currency only. Ask for the amount in so\'m, or explain that it is entered in Finance.');
  }
  checkAccountCurrency(d, payment.account, ctx().currency);
  if (d.questions.length > 0 || !counterparty || !i.amount || !direction) return null;

  const owed = (await listDebts(direction)).find((debt) => debt.counterpartyId === counterparty.id);
  const open = round((owed?.outstanding ?? 0) - (owed?.pendingSettlement ?? 0), 2);
  if (open <= 0) {
    d.ask('counterparty', 'NO_OPEN_DEBT', `There is no open debt with ${counterparty.name} in that direction. Tell them, and ask what this payment was.`);
    return null;
  }
  if (i.amount > open) {
    d.ask('amount', 'MORE_THAN_OWED', `Only ${open} is open with ${counterparty.name}. Ask what the rest was for.`);
    return null;
  }

  i.direction = direction;
  return {
    ...emptyFields(),
    amount: i.amount, currency: ctx().currency, fxRate: 1, amountBase: i.amount, date, direction,
    account: payment.account ? ref(payment.account) : null, paymentMethod: payment.method,
    counterparty: ref(counterparty), description: d.note,
  };
}

async function validateTransfer(d: Draft): Promise<ProposalFields | null> {
  const i = d.input;
  const source = checkAmount(d, i.amount);
  const date = checkDate(d);
  const accounts = await accountCandidates();
  const from = await d.pick('account', 'account', i.account, accounts, 'Ask which account the money left.', { spoken: true });
  const to = await d.pick('account', 'toAccount', i.toAccount, accounts, 'Ask which account it went to.', { spoken: true });
  if (from && to && from.id === to.id) d.ask('toAccount', 'SAME_ACCOUNT', 'Both accounts are the same. Ask which one it went to.');
  // Both names were said, so only the endings can tell which way the money went.
  const sides = (a: Candidate, b: Candidate) => accountSide(d.env.userTexts, a) === 'to' || accountSide(d.env.userTexts, b) === 'from';
  if (from && to && !d.trusted('account') && !d.trusted('toAccount') && sides(from, to)) {
    d.ask('account', 'TRANSFER_SIDES', 'Their words send the money the other way. Ask which account it left and which it went to.');
  }
  if (from && to && from.extra?.currency !== to.extra?.currency) {
    d.ask('toAccount', 'CURRENCY_NOT_SUPPORTED', 'These accounts hold different currencies. Explain that an exchange is entered in Finance.');
  }
  const { currency, fxRate } = await resolveCurrency(d, source, date);
  checkAccountCurrency(d, from, currency);
  if (d.questions.length > 0 || !from || !to || !i.amount) return null;
  return {
    ...emptyFields(),
    amount: i.amount, currency, fxRate, amountBase: toBaseAmount(i.amount, fxRate), date,
    account: ref(from), toAccount: ref(to), paymentMethod: from.extra?.type as 'cash' | 'bank' | 'card',
    description: d.note,
  };
}

const VALIDATORS: Record<RecordKind, (d: Draft) => Promise<ProposalFields | null>> = {
  expense: validateExpense,
  stock_purchase: validateStockPurchase,
  income: validateIncome,
  debt_payment: validateDebtPayment,
  transfer: validateTransfer,
};

/** The kind is the model's choice, so it must not contradict the words. A person who is asked can still settle it. */
function kindContradicted(d: Draft, kind: RecordKind): boolean {
  if (d.answering('KIND_UNCLEAR')) return false;
  const direction = directionWords(d.words);
  return (kind === 'income' && direction.length === 1 && direction[0] === 'payable') || (kind === 'expense' && moneyCameIn(d.words));
}

/** Words that stop a new record before anything else: it did not happen, or it is not ours to file. */
function refused(d: Draft, kind: RecordKind): boolean {
  if (d.env.fromForm || d.previous) return false;
  // Forwarded words back nothing on a card, but they can still say it is a plan, a wage or a sale.
  const forwarded = d.env.forwarded ?? [];
  const recent = [...d.newestFirst.slice(0, 2), ...forwarded].join('\n');
  const owner = ownedWords(recent);
  if (owner) {
    d.ask('category', 'USE_OTHER_MODULE', `This belongs to ${owner}. Explain that it must be entered there, so it is not counted twice. Do not draft it.`);
    return true;
  }
  if (kind === 'income' && saleWords(recent)) {
    d.ask('category', 'USE_OTHER_MODULE', 'This is a sale of animals or goods. Explain that it is entered in Sales, so stock and the herd stay right. Do not draft it.');
    return true;
  }
  const answer = (d.env.answering?.length ?? 0) > 0;
  const unpaid = d.answering('NOT_HAPPENED') ? !saysDone(d.latest) : notHappened(d.latest, answer) || forwarded.some((text) => notHappened(text));
  if (unpaid) {
    d.ask('kind', 'NOT_HAPPENED', 'This does not say the money has moved: it is a question, a plan or something still to pay. Answer what they asked. If they want it recorded, ask whether it has been paid.');
    return true;
  }
  if (kindContradicted(d, kind)) {
    d.ask('kind', 'KIND_UNCLEAR', 'Their words say the money went the other way. Ask whether it came in or went out, then use the tool that fits.');
    return true;
  }
  return false;
}

/** What was decided, in exact form. A default stays out, so it is decided again rather than frozen. */
function settledInput(d: Draft, f: ProposalFields): DraftInput {
  const i = d.input;
  const exact: DraftInput = {
    ...(i.amount !== undefined ? { amount: i.amount } : {}),
    ...(i.unitPrice !== undefined ? { unitPrice: i.unitPrice } : {}),
    ...(i.qty !== undefined ? { qty: i.qty } : {}),
    currency: f.currency,
    date: f.date,
    ...(f.fxRate !== null && f.currency !== ctx().currency ? { fxRate: f.fxRate } : {}),
    ...(f.category ? { category: f.category.id } : {}),
    ...(f.target && !f.target.defaulted ? { target: f.target.costCenterId } : {}),
    ...(f.paymentMethod ? { paymentMethod: f.paymentMethod } : {}),
    ...(f.account ? { account: f.account.id } : {}),
    ...(f.toAccount ? { toAccount: f.toAccount.id } : {}),
    ...(f.counterparty ? { counterparty: f.counterparty.id } : {}),
    ...(f.item ? { item: f.item.id } : {}),
    ...(f.warehouse ? { warehouse: f.warehouse.id } : {}),
    ...(f.direction ? { direction: f.direction } : {}),
    ...(f.description ? { description: f.description } : {}),
    ...(i.direct ? { direct: true } : {}),
  };
  return exact;
}

/** What a draft is about, once a name settles it. */
async function subjectOf(kind: RecordKind, input: DraftInput): Promise<string | null> {
  const settled = async (type: TargetType, phrase: string | undefined, candidates: () => Promise<Candidate[]>) => {
    const found = phrase ? await resolve(type, phrase, await candidates()) : null;
    return found?.status === 'found' ? found.candidate.id : null;
  };
  if (kind === 'stock_purchase') return settled('item', input.item, itemCandidates);
  if (kind === 'debt_payment') return settled('counterparty', input.counterparty, counterpartyCandidates);
  return kind === 'transfer' ? null : settled('category', input.category, () => categoryCandidates(kind));
}

/**
 * Gas drafted while the question was about a repair answers nothing, so it has only its own message: the
 * repair's day and payment are not its evidence. Goods can move between kinds as a question is answered, so
 * only two drafts of one kind can be told apart.
 */
function isNewRecord(kind: RecordKind, subject: string | null, env: DraftEnv): boolean {
  const open = (env.open ?? []).filter((record) => record.kind === kind);
  return Boolean(env.own) && subject !== null && open.length > 0 && open.every((record) => record.subject !== null && record.subject !== subject);
}

/** A question about the subject itself: the answer will name another, and is still this record. */
const SUBJECT_OPEN = /^(?:CATEGORY|ITEM|COUNTERPARTY)_/;

export async function validateDraft(kind: RecordKind, input: DraftInput, env: DraftEnv, previous?: DraftInput): Promise<Validated> {
  const subject = env.fromForm || previous ? null : await subjectOf(kind, input);
  const fresh = isNewRecord(kind, subject, env);
  const d = new Draft({ ...input }, fresh ? { ...env, ...env.own, answering: [], open: [] } : env, previous);
  const fields = refused(d, kind) ? null : await VALIDATORS[kind](d);
  clearNoise(d);
  if (!fields || d.questions.length > 0) {
    const record = { kind, subject: d.questions.some((q) => SUBJECT_OPEN.test(q.code)) ? null : subject, fresh };
    return { fields: null, input: {}, questions: d.questions, warnings: d.warnings, learn: [], record };
  }
  await checkSanity(d, fields, kind);
  return { fields, input: settledInput(d, fields) as Record<string, unknown>, questions: [], warnings: d.warnings, learn: d.learn, record: { kind, subject, fresh } };
}
