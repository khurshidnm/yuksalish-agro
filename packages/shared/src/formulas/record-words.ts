/**
 * What a person's own words say about a record, beyond its amount: quantities, rates, how it was paid,
 * the day, who paid whom, and whether another module owns it. A model extracts these too, but code only
 * believes what is here, so a guess cannot reach a card (docs/assistant.md, principles 2 and 4).
 *
 * Every list goes through `fold` (units.ts), so one entry covers Uzbek Latin and Cyrillic, Russian-keyboard
 * and voice spellings. Words match whole, with * for the Uzbek case endings. When words could be read two
 * ways, the reading that leads to a question wins: that costs one question, and the other can cost a wrong card.
 */
import { addDays, diffDays } from '../dates';
import {
  type MoneyMention,
  APPROX_BEFORE, blankNonAmounts, closesRange, HEDGES, isAmountWord, isApproximate, isCountWord, isPercent, isPriceBasis, isStockUnit, linkBetween, monthOf,
  numberAfter, parseMoneyMentions, readFigure, Scan, takenBack, type Figure, type Piece,
} from './money-text';
import { fold, unitOf, wordList, wordSet, type Phrase } from './units';

const wordsOf = (text: string) => new Scan(text).pieces.filter((piece) => piece.kind === 'word');

interface Match {
  at: number;
  length: number;
}

const fitsAt = (words: Piece[], at: number, phrase: Phrase) => phrase.every((keys, i) => words[at + i] !== undefined && keys.has(words[at + i].key));

/** Every place a list entry occurs, taking the longest entry that fits at each word. */
function matches(words: Piece[], list: Phrase[]): Match[] {
  const found: Match[] = [];
  words.forEach((_, at) => {
    const fits = list.filter((phrase) => fitsAt(words, at, phrase));
    if (fits.length > 0) found.push({ at, length: Math.max(...fits.map((phrase) => phrase.length)) });
  });
  return found;
}

const NEGATIONS = wordSet('не, not');
const WITHOUT = wordSet('без, without');
const VIA = wordSet('через, в, во, на, с, со, из, по, in, by, from, via, on, with, through');
const MONEY_NOUN = wordSet('pul*');
const NOT_AFTER = wordSet("emas, yo'q, не, нет");
const THE = fold('the');

/** "naqd emas", "naqd pul emas", "не наличными", "не через кассу", "not through the bank": the words name it only to rule it out. */
function ruledOut(words: Piece[], { at, length }: Match): boolean {
  const after = words[at + length]?.key ?? '';
  if (NOT_AFTER.has((MONEY_NOUN.has(after) ? words[at + length + 1]?.key : after) ?? '')) return true;
  const start = words[at - 1]?.key === THE ? at - 1 : at;
  const before = words[start - 1]?.key ?? '';
  return NEGATIONS.has(before) || WITHOUT.has(before) || (VIA.has(before) && NEGATIONS.has(words[start - 2]?.key ?? ''));
}

const says = (words: Piece[], list: Phrase[]) => matches(words, list).some((match) => !ruledOut(words, match));

/** "bankdan shekilli", "наверное наличными": named, but the person is not sure of it. */
const hedged = (words: Piece[], { at, length }: Match) => HEDGES.has(words[at + length]?.key ?? '') || HEDGES.has(words[at - 1]?.key ?? '');

// ─── Quantities and rates ───────────────────────────────────────────────────

export interface StatedQuantity {
  qty: number;
  unit: string;
  raw: string;
}

interface ReadQuantity extends StatedQuantity {
  first: number;
  next: number;
  /** The person took it back. */
  negated: boolean;
  /** A range, a choice, or approximate. */
  uncertain: boolean;
}

function quantityAt(s: Scan, figure: Figure): Pick<ReadQuantity, 'qty' | 'unit' | 'raw' | 'next'> | null {
  const { first, next, value } = figure;
  const until = (end: number, unit: string, qty = value) => ({ qty, unit, raw: s.text.slice(s.pieces[first].start, end) });
  if (figure.tonnes !== undefined) return { ...until(s.pieces[next - 1].end, s.pieces[next - 1].raw, figure.tonnes), next };
  const counted = figure.counted || fold(s.pieces[next]?.raw ?? '') === 'ta';
  const wordAt = figure.counted ? next : next + 1;
  // "10 ta qop": the word after "ta" says what was counted, and "10 ta qo'y" stays in "ta".
  if (counted && s.joined(wordAt) && isStockUnit(s, wordAt)) {
    return { ...until(s.pieces[wordAt].end, s.pieces[wordAt].raw), next: wordAt + 1 };
  }
  if (figure.counted) return { ...until(s.pieces[next - 1].end, 'ta'), next };
  if (!isStockUnit(s, next) || !s.joined(next)) return null;
  return { ...until(s.pieces[next].end, s.pieces[next].raw), next: next + 1 };
}

function allQuantities(s: Scan): ReadQuantity[] {
  const found: ReadQuantity[] = [];
  for (let i = 0; i < s.pieces.length; ) {
    const piece = s.pieces[i];
    // "полтонны" is one word.
    if (piece.key.startsWith('pol') && unitOf(piece.key.slice(3))) {
      found.push({ qty: 0.5, unit: piece.raw.slice(3), raw: piece.raw, first: i, next: i + 1, negated: false, uncertain: false });
      i += 1;
      continue;
    }
    const figure = readFigure(s, i);
    const quantity = figure && quantityAt(s, figure);
    if (quantity) {
      const unit = quantity.next - 1;
      const unsure = closesRange(s, i) || isApproximate(s, i, quantity.next) || s.key(unit).endsWith('cha') || isPriceBasis(s, unit);
      found.push({ ...quantity, first: i, negated: takenBack(s, i, quantity.next), uncertain: unsure });
    }
    i = Math.max(i + 1, quantity?.next ?? figure?.next ?? 0);
  }
  return found;
}

/**
 * Number-and-unit pairs the person stands by, including spoken numbers and scale words. Unit is the word as
 * written. A quantity taken back, a range, an approximate one and the unit of a price are not stated, because
 * code multiplies what is listed here into money. Given a whole conversation, oldest first, a figure taken back
 * also stops counting where it was said earlier.
 */
/** "тонну отрубей" has no number to find, so it is read as one. "За тонну" is the unit of a price. */
const ONE_TONNE = /(?<![\p{L}\p{N}]|(?:за|по|per|each|every)\s)(?:(?:одну|одна|one|a)\s+)?(тонну|тонна|tonne|ton)(?![\p{L}])/giu;

export function parseQuantities(text: string): StatedQuantity[] {
  const stated = quantitiesIn(text);
  if (stated.some((quantity) => unitOf(quantity.unit) === 't')) return stated;
  const implied = text.replace(ONE_TONNE, '1 $1');
  return implied === text ? stated : quantitiesIn(implied);
}

function quantitiesIn(text: string): StatedQuantity[] {
  const s = new Scan(blankNonAmounts(text));
  const found = allQuantities(s);
  found.forEach((quantity, k) => {
    const number = numberAfter(s, quantity.next);
    const link = number < 0 ? null : linkBetween(s, quantity.next, number);
    if (link === 'correction') quantity.negated = true;
    if (link === 'range') quantity.uncertain = true;
    if (link === 'range' && found[k + 1]?.first === number) found[k + 1].uncertain = true;
  });
  const kept: StatedQuantity[] = [];
  const dropped = new Set<string>();
  for (const { qty, unit, raw, negated, uncertain } of found.reverse()) {
    const same = `${qty} ${unitOf(unit) ?? fold(unit)}`;
    if (negated) dropped.add(same);
    else if (!uncertain && !dropped.has(same)) kept.push({ qty, unit, raw });
  }
  return kept.reverse();
}

/**
 * Exchange rates the person stated, as exact numbers. "kurs 12,7 ming" is 12700. With `currency`, a rate stated
 * for another one is left out: "Evro kursi 14 000" is no rate for a dollar record.
 */
export function parseStatedRates(text: string, currency?: string | null): number[] {
  return parseMoneyMentions(text)
    .filter((m) => m.rate && !m.negated && !m.uncertain && (!currency || !m.rateOf || m.rateOf === currency))
    .map((m) => m.amount);
}

// ─── How it was paid ────────────────────────────────────────────────────────

export type PaymentWord = 'cash' | 'bank' | 'card' | 'debt';

const CASH = wordList(`
  naqd*, naqt*, nakt*, naxt*, naxd*, nahd*, naqdan, naqdiy*, kassa*, касса, кассы, кассе, кассу, кассой, налик, налика, налом, нал, nalichka*, наличка, налички, наличкой, наличку,
  наличные, наличными, наличных, кэш, кеш, кэшем, кешем, cash`);
const BANK = wordList(`
  с расчётного, с расчетного, расчётного счёта, расчетного счета, schotdan, schyotdan, schetdan, shchotdan, shotdan, schotimizdan, schyotimizdan, schetimizdan, счётдан, счетдан, р с, р сч, р счет, р счёт, х р,
  hisobdan, hisobimdan, hisobimizdan, hisob raqam*, hisobraqam*, со счёта, со счета, с счета, с расчётного счёта, с расчетного счета,
  расчётный счёт, расчетный счет, o'tkazma*, perevod*, перевод, перевода, переводом, безнал, безнала, безналом, безналичными, безналичный,
  безналичная, безналичные, безналичного, beznal*, naqdsiz, naqd pulsiz, bank transfer, wire transfer, wire, by transfer, from the account,
  from account, from our account`);
/** Money arriving: "на счёт", "hisobga tushdi". But "hisobga oldim" only means it was taken into account. */
const INTO_ACCOUNT = wordList(`
  на расчётный, на расчетный, hisobga, hisobimga, hisobimizga, на счёт, на счет, на расчётный счёт, на расчетный счет, into the account, into our account,
  to the account, to our account`);
const TAKEN_NOTE_OF = /^ol(ish|ib|dim|dik|di|ing|inadi|indi|gan)/;
const CARD = wordList(`
  karta*, kartochka*, plastik*, humo*, uzcard*, uzkard*, карта, карты, карте, карту, картой, карточка, карточки, карточке, карточку, карточкой,
  пластик, пластика, пластику, пластиком, card, visa, mastercard, terminal*, терминал, терминала, терминалу, терминалом, click, payme`);
const DEBT = wordList('qarzga, nasiya*, в долг, в рассрочку, on credit, on debt, on tick');
const BANK_NAME = /bank(ga|ka|da|dan|ni|ning|i|iga|idan|ida|ini|imiz|imizga|imizdan|lar|a|e|u|om)?$/;
const TRANSFERRED = /^perechisl/;
/** "bank komissiyasi" is what was paid for, and "bank kartasi" is a card: neither says it left the bank account. */
const BANK_AS_A_WORD = wordSet('komissiya*, xizmat*, karta*, kartochka*, комиссия, комиссию, комиссии, карта, карты, карту, картой, fee, fees, charge, charges, commission, card');
/** These also name something bought: "Plastik quvur", "Kassa apparati", "Карта поля", "Перевод документов". */
const THINGS_TOO = wordSet('plastik, пластик, karta, карта, kassa, касса, perevod, перевод, terminal, терминал, visa');
/** After one of those, these keep it a way of paying: "karta bilan", "kassa orqali", "перевод денег". */
const STILL_PAYING = wordSet('bilan, orqali, через, via, raqam*, hisob*, pul*, денег, средств, номер, счёт, счета, счёта, account, number');
/** A jar, spelt like the bank: "3 банка краски", "3 banka bo'yoq". */
const JAR = /^(?:банк[аиу]|banka)$/i;
const FROM_A_BANK = wordSet('из, от, через, в, с, со, у');

/** Named, but as the thing bought: a word from the list above that leads straight into another. "Otga nal" is a horseshoe. */
function namesAThing(text: string, words: Piece[], { at }: Match): boolean {
  const word = words[at];
  if (word.key === 'nal' && /^[a-z]/i.test(word.raw)) return !isAmountWord(words[at - 1]?.key ?? '') && !/\d\s*$/.test(text.slice(Math.max(0, word.start - 3), word.start));
  const next = words[at + 1];
  if (!THINGS_TOO.has(word.key) || next === undefined || !/^[\s-]*$/.test(text.slice(word.end, next.start))) return false;
  return !STILL_PAYING.has(next.key) && !PAID.some((phrase) => fitsAt(words, at + 1, phrase));
}

function paidBy(text: string, words: Piece[], list: Phrase[]): boolean {
  return matches(words, list).some((match) => !ruledOut(words, match) && !hedged(words, match) && !namesAThing(text, words, match));
}

function paidByBank(text: string, words: Piece[]): boolean {
  if (paidBy(text, words, BANK)) return true;
  const intoAccount = (match: Match) => !ruledOut(words, match) && !hedged(words, match) && !TAKEN_NOTE_OF.test(words[match.at + match.length]?.key ?? '');
  if (matches(words, INTO_ACCOUNT).some(intoAccount)) return true;
  return words.some(
    (word, at) =>
      (TRANSFERRED.test(word.key) || BANK_NAME.test(word.key)) &&
      !(JAR.test(word.raw) && !FROM_A_BANK.has(words[at - 1]?.key ?? '')) &&
      !BANK_AS_A_WORD.has(words[at + 1]?.key ?? '') &&
      !BANK_AS_A_WORD.has(words[at - 1]?.key ?? '') &&
      !ruledOut(words, { at, length: 1 }) &&
      !hedged(words, { at, length: 1 }),
  );
}

/** Every way of paying the words name. */
export function paymentWords(text: string): PaymentWord[] {
  const words = wordsOf(text);
  const named: [PaymentWord, boolean][] = [
    ['cash', paidBy(text, words, CASH)], ['bank', paidByBank(text, words)], ['card', paidBy(text, words, CARD)], ['debt', paidBy(text, words, DEBT)],
  ];
  return named.filter(([, stated]) => stated).map(([word]) => word);
}

// ─── Dates ──────────────────────────────────────────────────────────────────

export interface DateEvidence {
  /** Days the words pin down, as YYYY-MM-DD. */
  dates: string[];
  /** A day was mentioned but cannot be pinned: o'tgan hafta, на прошлой неделе, last week, o'tgan oy, недавно. */
  vague: boolean;
  /** It has not happened yet: ertaga, завтра, tomorrow, indinga, keyingi hafta, на следующей неделе. */
  future: boolean;
}

const TODAY = wordList('bugun*, bugungi, сегодня, today');
const YESTERDAY = wordList('kecha, kechagi, вчера, yesterday, a day ago, last night');
const DAY_BEFORE = wordList("o'tgan kuni, o'tgan kun, o'tkan kuni, o'tkan kun, avvalgi kuni, avvalgi kun, oldingi kuni, oldingi kun, позавчера, day before yesterday");
const FUTURE = wordList(`
  ertaga, ertangi, indinga, завтра, послезавтра, tomorrow, keyingi hafta*, kelasi hafta*, kelgusi hafta*, keyingi oy*, kelasi oy*, kelgusi oy*,
  keyingi yil*, kelasi yil*, kelgusi yil*, следующей неделе, следующая неделя, следующую неделю, следующем месяце, следующий месяц,
  следующем году, следующий год, через неделю, через месяц, next week, next month, next year, in a week, in a month`);
const LAST_WEEK = wordList("o'tgan hafta*, o'tkan hafta*, прошлой неделе, прошлая неделя, прошлую неделю, той неделе, last week");
const VAGUE = wordList(`
  o'tgan oy*, o'tgan yil*, o'tkan oy*, o'tkan yil*, o'tgan safar, o'tkan safar, o'tgan gal, o'tkan gal, bu hafta*, shu hafta*, bu oy*, shu oy*, oldingi hafta*, oldingi oy*,
  avvalgi hafta*, avvalgi oy*, hafta boshi*, hafta oxiri*, oy boshi*, oy oxiri*, yil boshi*, yil oxiri*, oyning boshi*, oyning oxiri*, haftaning boshi*, haftaning oxiri*,
  yilning boshi*, yilning oxiri*, hafta ichida, oy ichida, hafta oldin, oy oldin, yil oldin, hafta avval, oy avval, yil avval, bir necha kun, necha kun, o'tgan kunlar*,
  o'tkan kunlar*, shu kunlar*, so'nggi kunlar*, oxirgi kunlar*, yaqinda, ancha oldin, oldinroq, avvalroq, o'sha kuni, ertasiga, ertasi,
  прошлом месяце, прошлый месяц, прошлом году, прошлый год, позапрошлой неделе, позапрошлом месяце, позапрошлом году, том месяце,
  этой неделе, этом месяце, начале месяца, начале недели, конце месяца, конце недели, неделю назад, месяц назад, год назад, недели назад,
  недель назад, месяца назад, месяцев назад, несколько дней, пару дней, пару недель, пару месяцев, последние дни, эти дни, на днях, недавно, давно, тот день,
  течение недели, течение месяца, last month, last year, this week, this month,
  a few days, few days, several days, couple of days, couple days, couple of weeks, couple weeks, a week ago, weeks ago, a month ago, months ago, a year ago, recently, lately, the other day, that day`);
const NEEDS_A_DAY = wordSet('may*, мая, май, мае, jan, feb, mar, apr, jul, aug, sep, sept, oct, nov, dec');
/** "10 mayda qo'zi" is ten small lambs unless the hyphen of "10-mayda" says otherwise. */
const ALSO_SMALL = wordSet('mayda');
const FOR_PERIOD_BEFORE = wordSet('за, for');
const COMING = wordSet('keyingi, kelasi, kelgusi, следующий, следующую, следующая, следующее, следующей, next');

const DAY_WORDS = wordSet('kun*, день, дня, дней, day, days');
const AGO = wordSet('oldin, avval, ilgari, burun, muqaddam, назад, ago, back');
const THAT_LONG = fold('тому');
const LATER = wordSet("keyin, so'ng");
const FROM_NOW = wordSet('через, in');

/** Numbered as Date.getUTCDay does: Sunday is 0. */
const WEEKDAYS = new Map<string, number>(
  ([
    [0, 'yakshanba*, воскресенье, воскресенья, воскресенью, sunday'], [1, 'dushanba*, понедельник, понедельника, понедельнику, monday'],
    [2, 'seshanba*, вторник, вторника, вторнику, tuesday'], [3, 'chorshanba*, среда, среду, среды, wednesday'],
    [4, 'payshanba*, четверг, четверга, четвергу, thursday'], [5, 'juma*, пятница, пятницу, пятницы, friday'],
    [6, 'shanba*, суббота, субботу, субботы, saturday'],
  ] as [number, string][]).flatMap(([day, source]) => [...wordSet(source)].map((key) => [key, day] as const)),
);

/** Juma and Shanba are also people. */
const NAMES_TOO = wordSet('juma, jumaga, shanba, shanbaga');
const DAY_NOUNS = wordSet('kuni, kunlari');

/** Whether a weekday word pins a day, is a person's name, or may be either. */
function weekdayUse(s: Scan, at: number): 'day' | 'name' | 'unclear' {
  const key = s.key(at);
  const name = NAMES_TOO.has(key);
  if (/(?:ga|cha)$/.test(key)) return name ? 'name' : 'unclear';
  if (!name || DAY_NOUNS.has(s.key(at + 1)) || s.pieces[at + 1] === undefined) return 'day';
  return PERSON_NOUNS.has(s.key(at + 1)) ? 'name' : 'unclear';
}

/** That weekday in the week before this one. A week here starts on Monday. */
function inLastWeek(today: string, weekday: number): string {
  const sinceMonday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(today, (weekday + 6) % 7 - sinceMonday - 7);
}

const iso = (year: number, month: number, day: number) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

function isRealDay(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** With no year said, around New Year a late date in the calendar can only be last year's. */
const YEAR_TURN_DAYS = 60;

function yearOf(month: number, day: number, today: string): number {
  const year = Number(today.slice(0, 4));
  if (iso(year, month, day) <= today) return year;
  return diffDays(iso(year - 1, month, day), today) <= YEAR_TURN_DAYS ? year - 1 : year;
}

const ORDINAL_MARKS = wordSet('st, nd, rd, th, го, chi, nchi, inchi');
const OF_THE_MONTH_NOUN = wordSet('oyi, oyining, oyida');

/** "2-noyabr", "2 ноября", "2-го ноября", "2nd of November", "Nov 2", "noyabrning 2-si", "noyabr oyining 3-sanasi". Null if no day stands by this month. */
function dayNearMonth(s: Scan, at: number): { day: number; ranged: boolean } | null {
  const dayAt = (i: number) => {
    const piece = s.pieces[i];
    const day = piece?.kind === 'number' && /^\d{1,2}$/.test(piece.raw) ? Number(piece.raw) : 0;
    return day >= 1 && day <= 31 ? day : null;
  };
  let i = at - 1;
  if (s.key(i) === 'of') i -= 1;
  if (ORDINAL_MARKS.has(s.key(i))) i -= 1;
  if (s.mark(i) === '-') i -= 1;
  const before = dayAt(i);
  if (before !== null) return { day: before, ranged: closesRange(s, i) };
  const dayFollows = OF_THE_MONTH_NOUN.has(s.key(at + 1)) ? at + 2 : at + 1;
  const after = dayAt(dayFollows);
  if (after === null) return null;
  const figure = readFigure(s, dayFollows);
  return figure?.scale === 1 && !isCountWord(s, dayFollows + 1) ? { day: after, ranged: false } : null;
}

const YEAR_WORDS = wordSet('yil*, yilgi, год, года, году, г');

/** "2 ноября 2026", "2026 yil 2-noyabr", but not the amount in "5 noyabr 2000 so'm". */
function yearNearMonth(s: Scan, at: number): number | null {
  const isYear = (i: number) => s.pieces[i]?.kind === 'number' && /^(19|20)\d{2}$/.test(s.pieces[i].raw);
  for (const i of [at + 1, at + 2]) {
    if (isYear(i) && !isAmountWord(s.key(i + 1))) return Number(s.pieces[i].raw);
  }
  for (const i of [at - 2, at - 3, at - 4, at - 5]) {
    if (isYear(i) && YEAR_WORDS.has(s.key(i + 1))) return Number(s.pieces[i].raw);
  }
  return null;
}

const SAYS_A_DAY = wordSet('kuni, kunda, kundagi, sanada, числа');

/** "02.11", "3/11" with nothing to make it money, a share or a quantity. */
function dayMonths(text: string): [number, number][] {
  const s = new Scan(text);
  const money = new Set(parseMoneyMentions(text).map((m) => m.start));
  const dotted = s.pieces.flatMap((piece, i) => {
    const match = /^(\d{1,2})\.(\d{2})$/.exec(piece.raw);
    if (piece.kind !== 'number' || !match || isPercent(s, i + 1) || money.has(piece.start)) return [];
    if (isCountWord(s, i + 1) && !SAYS_A_DAY.has(s.key(i + 1))) return [];
    return [[Number(match[1]), Number(match[2])] as [number, number]];
  });
  const slashed = [...text.matchAll(/(?<![\d.,/])(\d{1,2})\/(\d{2})(?![\d/])/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
  return [...dotted, ...slashed].filter(([day, month]) => day >= 1 && day <= 31 && month >= 1 && month <= 12);
}

/** Dates in digits. A full one is taken out of the text, so its first half is not read again as "02.11". */
function digitDates(text: string, today: string, pin: (year: number, month: number, day: number) => void) {
  let rest = text;
  const take = (pattern: RegExp, read: (m: string[]) => void) => {
    rest = rest.replace(pattern, (...m: string[]) => {
      read(m);
      return ' '.repeat(m[0].length);
    });
  };
  take(/(?<![\d.,])((?:19|20)\d{2})[-./](\d{1,2})[-./](\d{1,2})(?!\d)/g, (m) => pin(Number(m[1]), Number(m[2]), Number(m[3])));
  take(/(?<![\d.,])(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)/g, (m) => pin(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]), Number(m[1])));
  take(/(?<![\d.,])(\d{1,2}) (\d{1,2}) ((?:19|20)\d{2})(?!\d)/g, (m) => pin(Number(m[3]), Number(m[2]), Number(m[1])));
  take(/(?<!\d)((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/g, (m) => pin(Number(m[1]), Number(m[2]), Number(m[3])));
  for (const [day, month] of dayMonths(rest)) pin(yearOf(month, day, today), month, day);
}

const OF_THE_MONTH = wordSet('kuni, si, sida, sidagi, sana, sanasi, sanada, sanasida, числа, го, st, nd, rd, th');
/** Without the hyphen of "5-kuni", these can count: "5 kuni ishladi" is five days of work, "3 si qo'chqor" is three of them. */
const MAY_COUNT = wordSet('kuni, si, sida, sidagi');

/** "5-kuni", "5 числа", "the 5th": this month, or last month if that day has not come yet. "5 kuni" alone is a question. */
function daysOfMonth(s: Scan, today: string, pin: (year: number, month: number, day: number) => void, unclear: () => void) {
  s.pieces.forEach((piece, at) => {
    const hyphen = s.mark(at + 1) === '-';
    const word = hyphen ? at + 2 : at + 1;
    const day = piece.kind === 'number' && /^\d{1,2}$/.test(piece.raw) ? Number(piece.raw) : 0;
    if (day < 1 || day > 31 || !OF_THE_MONTH.has(s.key(word)) || s.mark(at - 1) === '/' || [word + 1, word + 2].some((i) => monthOf(s.pieces[i]) !== undefined)) return;
    if (monthOf(s.pieces[at - 1]) !== undefined || monthOf(s.pieces[at - 2]) !== undefined) return;
    if (closesRange(s, at)) return unclear();
    if (!hyphen && MAY_COUNT.has(s.key(word))) {
      if (s.key(word) === 'kuni' && s.key(word + 1) !== 'uchun') unclear();
      return;
    }
    const thisMonth = today.slice(0, 7);
    const month = `${thisMonth}-${String(day).padStart(2, '0')}` <= today ? thisMonth : addDays(`${thisMonth}-01`, -1).slice(0, 7);
    pin(Number(month.slice(0, 4)), Number(month.slice(5, 7)), day);
  });
}

/** "3 дня назад", "uch kun oldin", "3 kundan keyin", "через 3 дня". "дня три назад" and "3 kuncha oldin" are not exact. */
function countedDays(s: Scan, today: string): { days: string[]; future: boolean; vague: boolean } {
  const days: string[] = [];
  let future = false;
  let vague = false;
  for (let i = 0; i < s.pieces.length; i += 1) {
    const figure = readFigure(s, i);
    if (!figure) continue;
    const { next, value } = figure;
    if (DAY_WORDS.has(s.key(next))) {
      const ago = AGO.has(s.key(s.key(next + 1) === THAT_LONG ? next + 2 : next + 1));
      const loose = closesRange(s, i) || APPROX_BEFORE.has(s.key(i - 1)) || s.key(next).endsWith('cha') || !Number.isInteger(value);
      if (ago && loose) vague = true;
      else if (ago) days.push(addDays(today, -value));
      if (LATER.has(s.key(next + 1)) || FROM_NOW.has(s.key(i - 1))) future = true;
    } else if (DAY_WORDS.has(s.key(i - 1)) && AGO.has(s.key(next))) {
      vague = true;
    }
    i = Math.max(i, next - 1);
  }
  return { days, future, vague };
}

/** "третьего числа", "yigirma beshinchi kuni": a day of the month, in a word this code does not count. */
const dayInWords = (words: Piece[]) => words.some((word, at) => word.key === fold('числа') || (/n?chi$/.test(word.key) && words[at + 1]?.key === 'kuni'));

/** "o'tgan oy uchun", "за прошлый месяц" name the period paid for, which says nothing about the day of payment. */
function forPeriod(words: Piece[], { at, length }: Match): boolean {
  const after = words[at + length]?.key;
  return after === 'uchun' || FOR_PERIOD_BEFORE.has(words[at - 1]?.key ?? '');
}

/** What the words say about the day. Works from the `today` it is given and never reads the clock. */
export function dateEvidence(text: string, today: string): DateEvidence {
  const s = new Scan(text);
  const words = s.pieces.filter((piece) => piece.kind === 'word');
  const dates = new Set<string>();
  let vague = false;
  let future = says(words, FUTURE);
  const unclear = () => {
    vague = true;
  };

  const pin = (year: number, month: number, day: number) => {
    if (isRealDay(year, month, day)) dates.add(iso(year, month, day));
    else unclear();
  };

  digitDates(text, today, pin);
  daysOfMonth(s, today, pin, unclear);
  const lastWeek = matches(words, LAST_WEEK).some((match) => !forPeriod(words, match));
  let weekdayInLastWeek = false;
  s.pieces.forEach((piece, at) => {
    const month = monthOf(piece);
    if (month !== undefined) {
      const near = dayNearMonth(s, at);
      const notOneDay = near && (near.ranged || piece.key.endsWith('gacha') || (ALSO_SMALL.has(piece.key) && s.mark(at - 1) !== '-'));
      if (notOneDay) unclear();
      else if (near) pin(yearNearMonth(s, at) ?? yearOf(month, near.day, today), month, near.day);
      else if (!NEEDS_A_DAY.has(piece.key) && s.key(at + 1) !== 'uchun' && s.key(at + 2) !== 'uchun' && !FOR_PERIOD_BEFORE.has(s.key(at - 1))) unclear();
    }
    const weekday = WEEKDAYS.get(piece.key);
    if (weekday === undefined) return;
    const use = COMING.has(s.key(at - 1)) ? 'coming' : weekdayUse(s, at);
    if (use === 'coming') {
      future = true;
    } else if (use === 'unclear') {
      unclear();
    } else if (use === 'day' && lastWeek) {
      weekdayInLastWeek = true;
      dates.add(inLastWeek(today, weekday));
    } else if (use === 'day') {
      const back = (new Date(`${today}T00:00:00Z`).getUTCDay() - weekday + 7) % 7 || 7;
      dates.add(addDays(today, -back));
    }
  });

  if (says(words, TODAY)) dates.add(today);
  if (says(words, DAY_BEFORE)) dates.add(addDays(today, -2));
  if (matches(words, YESTERDAY).some((match) => !ruledOut(words, match) && words[match.at - 1]?.key !== 'before')) dates.add(addDays(today, -1));
  const counted = countedDays(s, today);
  counted.days.forEach((day) => dates.add(day));
  if (counted.vague || (lastWeek && !weekdayInLastWeek) || matches(words, VAGUE).some((match) => !forPeriod(words, match))) unclear();
  if (dates.size > 0 ? words.some((word) => HEDGES.has(word.key)) : dayInWords(words)) unclear();

  future ||= counted.future || [...dates].some((day) => day > today);
  return { dates: [...dates], vague, future };
}

// ─── Who owns it ────────────────────────────────────────────────────────────

/** 'sales' stays in the type for callers, but selling is for `saleWords`, which depends on the kind of record. */
export type OwnedBy = 'payroll' | 'loans' | 'depreciation' | 'sales';

const JOBS = wordList(`
  qorovul*, qo'riqchi*, posbon*, cho'pon*, ishchi*, xodim*, haydovchi*, shofyor*, shofer*, traktorchi*, kombaynchi*, mexanizator*, agronom*, zootexnik*, oshpaz*, hisobchi*,
  buxgalter*, farrosh*, brigadir*, mirob*, sog'uvchi*, yordamchi*, kassir*, omborchi*, mardikor*, сторож, сторожу, сторожа, сторожам, охранник, охраннику, охранникам, чабан, чабану, чабанам,
  пастух, пастуху, пастухам, рабочий, рабочему, рабочим, рабочие, работник, работнику, работникам, работники, разнорабочий, разнорабочему, разнорабочим,
  водитель, водителю, водителям, шофёр, шофёру, шофер, шоферу, тракторист, трактористу, трактористам, комбайнер, комбайнеру, комбайнёр, комбайнёру, механизатор, механизатору, механизаторам,
  агроном, агроному, зоотехник, зоотехнику, повар, повару, поварам, повариха, поварихе, бухгалтер, бухгалтеру, уборщица, уборщице, бригадир, бригадиру, кассир, кассиру, кладовщик, кладовщику,
  мардикор, мардикору, мардикорам, сотрудник, сотруднику, сотрудникам, сотрудники,
  guard, guards, watchman, shepherd, shepherds, worker, workers, driver, drivers, tractor driver, cook, accountant, cleaner, foreman, employee, employees, staff`);
const PAY = wordList(`
  zarplata*, зарплата, зарплату, зарплаты, зарплате, зарплатой, зп, з п, ish haqi*, ishhaqi*, ishaqi*, ish puli*, maosh*, moash*, oylik maosh*, oyligi*, oyligimiz*, oyliklar*,
  salary, salaries, wage, wages, payroll, оклад, оклада, окладу, premiya*, премия, премию, премии, mukofot*, bonus*, бонус, бонуса, бонусы, бонусом, отпускные, ta'til puli*`);
const PAID = wordList(`
  to'ladim, to'ladik, to'lab berdim, to'landi, berdim, berdik, bervordim, bervordik, berib yubordim, berildi, tarqatdim, tarqatdik, tarqatildi, o'tkazdim, o'tkazdik, tashladim, tashladik,
  заплатил, заплатила, заплатили, оплатил, оплатила, оплатили, отдал, отдала, отдали, выдал, выдала, выдали, выплатил, выплатила, выплатили, перевёл, перевел, перевели, скинул, скинули, paid, gave, sent`);
const LOANS = wordList(`
  ssuda*, ссуда, ссуду, ссуды, ссуде, заём, заем, займ, займа, займу, займом, leasing, loan, loans, ipoteka*, ипотека, ипотеку, ипотеки, mortgage, overdraft, овердрафт, овердрафта,
  qarz oldim, qarz oldik, qarz oldi, qarz olindi, qarz olgan, qarz olganman, qarz olganmiz, qarz berdi, qarz berishdi,
  занял, заняла, заняли, занимал, занимали, одолжил, одолжила, одолжили, взял взаймы, взяла взаймы, взяли взаймы, borrowed, borrow`);
/** Whole-word matching would miss the firm's own name: "Uzagrolizing", and "Mikrokredit". A creditor is another thing. */
const LOAN_INSIDE_A_WORD = /lizing|kredit(?!or)/;
/** Only for money: "взял в долг дизель" is a purchase on credit. */
const BORROWED_CASH = wordList('взял в долг, взяла в долг, взяли в долг');
/** After a bank or a card the word is a name: "Ipoteka bank", "Kredit karta". */
const BANK_OR_CARD = wordSet('bank*, karta*, kartochka*, банк, банка, банке, банком, карта, карты, карте, карту, картой, карточка, карточки, карточку, карточкой, card');
const INTEREST = wordSet('foiz, foizi, foizini, foizlar*, процент, проценты, процентов, interest');
const DEPRECIATION = wordList('amortizatsiya*, амортизация, амортизации, амортизацию, depreciation, amortization, amortisation');
const ADVANCES = wordList(`
  oldindan, avvaldan, avans*, bo'nak*, bo'nakka, аванс, аванса, авансом, авансу, авансе, предоплата, предоплату, предоплаты, предоплате, предоплатой, задаток, задатка,
  заранее, наперёд, наперед, вперёд, вперед, депозит, prepayment, prepaid, prepay, in advance, advance, down payment, upfront, deposit`);
/** The words for an advance on pay, which goods are not paid with: "oldindan", "предоплата". */
const PAY_ADVANCES = wordList("avans*, bo'nak*, аванс, аванса, авансом, авансу, advance");
const ADVANCE_TAKEN = wordSet('oldi, olgan');
const PERSON_NOUNS = wordSet('aka*, opa*, usta*, брат, брату, сестра, сестре');
/** Firms, and what an advance can be for, which also stand in the dative: "Neft Bazaga", "Elektrga". */
const NOT_PEOPLE = wordSet(`
  baza*, savdo*, servis*, market*, bozor*, firma*, kompaniya*, zavod*, tsex*, mchj, ooo, do'kon*, dorixona*, apteka*, bank*, tarmoq*, поставщик, поставщику, подрядчик, подрядчику, supplier, contractor,
  elektr*, svet*, gaz*, suv*, internet*, ijara*, dizel*, yem*, yoqilg'i*, ta'mir*, qurilish*, remont*, traktor*, mashina*, texnika*, urug'*`);
const DATIVE = /.{2,}(?:ga|ka|qa)$/;

/** "ishchilarga oylik", "Akmalga oylik", "oylik 20 mln berdim": said about people or handed out, "oylik" is pay. Alone it means monthly. */
function monthlyPay(words: Piece[]): boolean {
  const jobs = new Set(matches(words, JOBS).map((match) => match.at + match.length - 1));
  const paidAt = new Set(matches(words, PAID).map((match) => match.at));
  return words.some((word, at) => {
    if (word.key !== 'oylik') return false;
    if (jobs.has(at - 1) || (at > 0 && DATIVE.test(words[at - 1].key) && !NOT_PEOPLE.has(words[at - 1].key))) return true;
    let next = at + 1;
    while (words[next] && isAmountWord(words[next].key)) next += 1;
    return paidAt.has(next);
  });
}

/** "Akmalga", "akmalga", "Акмалу", "рустаму аванс": one person in the dative, not a firm or a purpose. */
function namesAPerson(words: Piece[], advances: Match[]): boolean {
  return words.some(({ key, raw }, at) => {
    if (NOT_PEOPLE.has(key)) return false;
    if (DATIVE.test(key)) return true;
    return /[ую]$/i.test(raw) && (/^\p{Lu}/u.test(raw) || advances.some((advance) => Math.abs(advance.at - at) === 1));
  });
}

function advanceToPerson(words: Piece[]): boolean {
  const advances = matches(words, PAY_ADVANCES).filter((match) => !ruledOut(words, match));
  if (advances.length === 0) return false;
  if (says(words, JOBS) || words.some((word) => PERSON_NOUNS.has(word.key))) return true;
  if (words.some((word) => word.key === 'uchun')) return false;
  const firmNamed = words.some((word) => NOT_PEOPLE.has(word.key));
  if (!firmNamed && advances.some(({ at, length }) => ADVANCE_TAKEN.has(words[at + length]?.key ?? ''))) return true;
  const toSomeone = words.some((word, at) => word.key === 'to' && words[at + 1] !== undefined && words[at + 1].key !== THE && !NOT_PEOPLE.has(words[at + 1].key));
  return toSomeone || namesAPerson(words, advances);
}

/** A loan, whoever it is from. Interest counts when it goes to a bank and no number makes it a share of something. */
function aboutALoan(s: Scan, words: Piece[]): boolean {
  const isCard = (at: number) => BANK_OR_CARD.has(words[at]?.key ?? '');
  if (matches(words, LOANS).some((match) => !ruledOut(words, match) && !isCard(match.at + match.length))) return true;
  if (words.some((word, at) => LOAN_INSIDE_A_WORD.test(word.key) && !word.key.includes('bank') && !isCard(at + 1))) return true;
  if (matches(words, BORROWED_CASH).some(({ at, length }) => readFigure(s, words[at + length - 1].index + 1) !== null)) return true;
  if (!words.some((word) => BANK_NAME.test(word.key))) return false;
  return words.some((word) => INTEREST.has(word.key) && !/\d\s*$/.test(s.text.slice(Math.max(0, word.start - 4), word.start)));
}

/** Strong words only. A word like "oylik" alone means monthly, so "oylik internet" is not payroll. */
export function ownedWords(text: string): OwnedBy | null {
  const s = new Scan(text);
  const words = s.pieces.filter((piece) => piece.kind === 'word');
  if (says(words, PAY) || monthlyPay(words) || advanceToPerson(words)) return 'payroll';
  if (aboutALoan(s, words)) return 'loans';
  if (says(words, DEPRECIATION)) return 'depreciation';
  return null;
}

const SOLD = wordList(`
  sotdim, sotdik, sotdi, sotdilar, sotishdi, sotildi, sotilgan, sotilgani, sotgan, sotganman, sotganmiz, sotib yubordim, sotib yubordik, sotib berdim, sotib berdik,
  sotuv*, sotish*, xaridor*, продал, продала, продали, продано, продана, проданы, продажа, продажи, продажу, продаже, продажей, продаж, реализовал, реализовали, реализация, реализации,
  отгрузил, отгрузили, отгрузка, отгрузку, покупатель, покупателя, покупателю, покупатели, sold, sale, sales, selling, buyer, buyers`);
const PRODUCE = wordList(`
  qo'y, qo'zi*, qo'ydan, qo'ylar, qo'ylardan, qo'ylarni, qo'yni, qo'y uchun, qo'y puli*, qo'chqor*, sovliq*, echki*, jun*, go'sht*, don*, bug'doy*, arpa*, beda*, somon*, pichan*, paxta*, sut*,
  шерсть, шерсти, шерстью, мясо, мяса, мясом, ягнят, ягнята, ягнятами, ягненка, ягнёнка, овец, овца, овцы, овцу, баран, баранов, барана, бараны, зерно, зерна, зерном,
  пшеницу, пшеницы, пшеница, ячмень, ячменя, сено, сена, солому, соломы, солома, люцерну, люцерны, молоко, молока, молоком,
  wool, meat, lamb, lambs, sheep, ram, rams, grain, wheat, barley, hay, straw, alfalfa, milk`);
const MONEY_CAME = wordList(`
  tushdi, tushgan, tushgani, tushib, keldi, kirdi, daromad*, получил, получила, получили, получено, выручка, выручку, выручил, выручили, поступило, поступили,
  пришло, пришли, came in, received, got, earned, revenue, income`);
const PAID_FOR = wordList('uchun, за, for');
const TOOK_MONEY = wordList('oldim, oldik, berdi, berishdi, дали, дал, взяли, взял, отдал, отдали, paid, gave');
const MONEY_OF = wordSet('puli*, money, деньги');
/** Went for a price: "Мясо ушло за 5 млн". */
const WENT_FOR = wordList('ушло за, ушла за, ушли за, ушёл за, ушел за');
const GIVEN_AWAY = wordSet('ketdi, berdim, berdik, berdi, berishdi, berildi, berib');

const QOY = wordSet("qo'y");
/** "yozib qo'y": after a verb "qo'y" is a verb too, and no sheep. */
const isVerbNotSheep = (words: Piece[], { at, length }: Match) => length === 1 && QOY.has(words[at].key) && /b$/.test(words[at - 1]?.key ?? '');

/** "5 mln ga berib yubordim", "50 millionga ketdi": this is what it went for, whatever it was. */
function wentForAPrice(text: string): boolean {
  const s = new Scan(blankNonAmounts(text));
  return s.pieces.some((piece, at) => {
    if (!GIVEN_AWAY.has(piece.key)) return false;
    const before = s.pieces[at - 1];
    if (before?.kind !== 'word') return false;
    if (isAmountWord(before.key)) return /(?:ga|dan)$/.test(before.key);
    return ['ga', 'dan'].includes(before.key) && (s.pieces[at - 2]?.kind === 'number' || isAmountWord(s.key(at - 2)));
  });
}

/** Selling what the farm holds, in so many words or as money that came from animals or produce. */
export function saleWords(text: string): boolean {
  const words = wordsOf(text);
  if (says(words, SOLD) || matches(words, WENT_FOR).length > 0 || wentForAPrice(text)) return true;
  const produce = matches(words, PRODUCE).filter((match) => !isVerbNotSheep(words, match));
  if (produce.length === 0) return false;
  if (says(words, MONEY_CAME) || produce.some(({ at, length }) => MONEY_OF.has(words[at + length]?.key ?? ''))) return true;
  const paidFor = produce.some(({ at, length }) => {
    const before = words[at - 1]?.key === THE ? words[at - 2] : words[at - 1];
    return length > 1 || matches([before, words[at + length]].filter(Boolean), PAID_FOR).length > 0;
  });
  return paidFor && says(words, TOOK_MONEY);
}

const PAY_PERIOD = wordList(`
  oy uchun, oyi uchun, hafta uchun, oylik, haftalik, kunlik, за месяц, за этот месяц, за прошлый месяц, за неделю, за смену,
  for the month, for this month, for last month, for the week`);
const FOR_WORK = wordList(`
  ish uchun, ishi uchun, mehnat uchun, mehnati uchun, на руки, на карту, на счёт, на счет, за работу, for work, for the work`);
/** After a job title: "Qorovul haqi", "Ishchilar puli". */
const PAY_NOUNS = wordSet('haqi*, puli*');
const PURPOSE = wordList(`
  tushlik*, tushlikka, ovqat*, oziq*, oziqqa, kiyim*, yo'l*, обед, обеда, обедом, еду, еда, одежду, спецодежду, lunch, food, clothes, clothing`);
/** The money is for something else, and the person in the sentence is not being paid for it. */
const FOR_SOMETHING = wordList('uchun, на, puli');

function periodNamed(s: Scan, words: Piece[]): boolean {
  if (matches(words, PAY_PERIOD).length > 0) return true;
  return s.pieces.some((piece, at) => {
    if (monthOf(piece) === undefined) return false;
    return s.key(at + 1) === 'uchun' || s.key(at + 2) === 'uchun' || FOR_PERIOD_BEFORE.has(s.key(at - 1));
  });
}

const MONTHLY = wordSet('oylik, oylikka, oylikdan, monthly, ежемесячно, ежемесячная, ежемесячный');

/** Asked "wage or service?", "oylik" means the wage. Anywhere else it only means monthly, so `ownedWords` leaves it alone. */
export const monthlyWord = (text: string) => wordsOf(text).some((word) => MONTHLY.has(word.key));

/** A job title with a pay period, or plain payment to that person. "ishchilarga tushlik" is not: the money is for lunch. */
export function wageWords(text: string): boolean {
  const s = new Scan(blankNonAmounts(text));
  const words = s.pieces.filter((piece) => piece.kind === 'word');
  const jobs = matches(words, JOBS);
  if (jobs.length === 0) return false;
  if (periodNamed(s, words)) return true;
  if (matches(words, PURPOSE).length > 0) return false;
  if (matches(words, FOR_WORK).length > 0 || jobs.some(({ at, length }) => PAY_NOUNS.has(words[at + length]?.key ?? ''))) return true;
  if (matches(words, FOR_SOMETHING).length > 0) return false;
  if (says(words, PAID)) return true;
  return jobs.some(({ at, length }) => readFigure(s, words[at + length - 1].index + 1) !== null);
}

// ─── Whether it happened, and who paid whom ─────────────────────────────────

/** Verbs of paying and what can still happen to them: "to'laymiz", "beraman", "o'tkazing", "to'lasin", "to'layapman", "to'lasak". */
const PAYING_VERBS = ["to'la", 'tashla', 'ber', "o'tkaz", "jo'nat", 'qaytar', 'yubor'];
const MOVING_VERBS = ['ol', 'ket', 'tush', 'kel', 'sarfla'];
const endsInVowel = (stem: string) => /[aeiou]$/.test(stem);

/** It will happen, it is happening, or it would if: every Uzbek form that is not done. */
function notYetForms(stem: string): string[] {
  const will = `${stem}${endsInVowel(stem) ? 'y' : 'a'}`;
  return [
    ...['man', 'miz', 'san', 'siz', 'di'].map((ending) => will + ending),
    ...['sa', 'sam', 'sak', 'sang', 'sangiz', 'yapman', 'yapmiz', 'yapsiz', 'yapti', 'moqda', 'moqdaman', 'moqdamiz', 'moqdalar'].map((ending) => stem + ending),
  ];
}

/** An order or an offer to pay: "bering", "to'lang", "to'lasin", "to'laylik", "beraymi". */
function commandForms(stem: string): string[] {
  const vowel = endsInVowel(stem);
  const shall = `${stem}${vowel ? 'y' : 'ay'}`;
  const please = `${stem}${vowel ? 'ng' : 'ing'}`;
  return [shall, `${shall}mi`, `${shall}lik`, `${shall}likmi`, please, `${please}lar`, `${please}iz`, `${stem}sin`, `${stem}sinlar`];
}

const NOT_DONE = wordList(`
  ${[...PAYING_VERBS, ...MOVING_VERBS].flatMap(notYetForms).join(', ')}, ${PAYING_VERBS.flatMap(commandForms).join(', ')},
  kerak, kerakmi, kerakdir, lozim, to'lash shart, agar, basharti, mabodo, nechta, nega, nimaga, to'lashadi, to'lanadi, to'lanar, to'lanishi, to'lanadigan, to'laydigan,
  qo'yaman, qo'yamiz, to'lab qo'y, to'lab qo'ying, to'lab qo'yay, to'lab qo'yaymi, o'tkazib qo'y, o'tkazib qo'ying, berib qo'y, berib qo'ying, xarid qilaman, xarid qilamiz,
  uzaman, uzamiz, olib kel, olib keling, sotib ol, sotib oling, xarid qiling, ketadigan, beriladi, beriladigan, beradigan, berilsin, to'lansin, o'tkazilsin, o'tkaziladi, o'tkaziladigan,
  to'lamay qoldi, to'lamay qoldim, to'lamay qoldik, to'lanmay qoldi, to'lovi qoldi, yoki yo'q,
  to'lamadim, to'lamadik, to'lamadi, to'lanmadi, to'lanmagan, to'lamagan, to'lamaganman, to'lamaganmiz, to'laganim yo'q, to'laganimiz yo'q,
  bermadim, bermadik, berilmadi, berilmagan, bermagan, bermaganman, o'tkazmadim, o'tkazmadik, o'tkazilmadi, to'lay olmadim, to'lay olmadik, bera olmadim,
  ulgurmadim, ulgurmadik,
  надо, нужно, необходимо, должен, должна, должны, собираюсь, собираемся, собирался, собиралась, собирались, планирую, планируем, планируется, хочу, хотим, хотел, хотела, хотели,
  буду, будем, будет, будут, заплачу, заплатим, заплатит, заплатят, оплачу, оплатим, оплатит, оплатят, отдам, отдадим, отдаст, отдадут, переведу, переведем, переведём, переведёт, переведет, переведут,
  вернём, вернем, вернёт, вернет, вернут, куплю, купим, купит, купят, возьму, возьмём, возьмем, возьмёт, возьмет, возьмут, закуплю, закупим, закупят,
  пойдёт, пойдет, пойдут, уйдёт, уйдет, уйдут, плачу, платим, платят, покупаю, покупаем, покупают, беру, берём, берем, берут, перевожу, переводим, оплачиваю, оплачиваем, отдаю, отдаём, отдаем, закупаем,
  заплати, заплатите, оплати, оплатите, отдай, отдайте, переведи, переведите, перечисли, перечислите, купи, купите, возьми, возьмите, закупи, закупите, выдай, выдайте, верни, верните, плати, платите, покупай, покупайте,
  обойдётся, обойдется, неоплачено, неоплачена, неоплаченный, неоплаченная, неоплаченные, если, сколько, разве, почему, или нет,
  need to, needs to, have to, has to, must, should, going to, gonna, will, won't, we'll, i'll, they'll, shall, plan to, planning, want to, wants to, wanted to, if, would, might, could,
  how much, how many, why, not yet, or not, to be paid, be paid, didn't, did not, haven't, hasn't, have not, has not, couldn't, could not, wasn't, weren't, isn't, aren't, unpaid`);
/** These say it may not have happened, unless a verb says it did: "Reja bo'yicha 3 mln to'ladim", "Заплатил за план". */
const UNLESS_DONE = wordList(`
  reja*, rejalashtir*, mo'ljal*, qancha*, bo'ladi, to'lash, o'tkazish, отдать, перевести, платить, оплачивать, покупать, брать, отдавать, переводить, qarzimiz bor, qarzim bor, qarzi bor, qarzmiz, qarzman, qarzdormiz, qarzdorman,
  план, плана, плану, планировал, планировала, планировали, долг, долга, долгу, задолженность, задолженности, выставили, выставлен, выставлено,
  пришёл счёт, пришел счет, счёт пришёл, счет пришел, счёт на, счет на, planned, pay, paying, buy, buying, due, pending, outstanding, owe, owes, owed`);
const MONEY_MOVED = wordList(`
  to'ladim, to'ladik, to'ladi, to'landi, to'lashdi, to'lab berdim, to'lab berdik, to'lab qo'ydim, to'lab qo'ydik, berdim, berdik, berdi, berishdi, berildi, bervordim, bervordik, berib yubordim, berib yubordik,
  o'tkazdim, o'tkazdik, o'tkazdi, o'tkazildi, jo'natdim, jo'natdik, tashladim, tashladik, qaytardim, qaytardik, qaytardi, uzdim, uzdik, tarqatdim, tarqatdik, tarqatildi, ketdi, ketgan, sarfladim, sarfladik, sarflandi,
  xarajat qildim, xarajat qildik, tushdi, tushgan, oldim, oldik, olindi, perechislenie qildim, perechislenie qildik, o'tkazma qildim,
  o'tkazma qildik, to'lov qildim, to'lov qildik, упало, упали, зашло, зашли, закрыл, закрыла, закрыли, погашено, погашен, погашена, yopdim, yopdik,
  заплатил, заплатила, заплатили, заплачено, оплатил, оплатила, оплатили, оплачено, оплачена, отдал, отдала, отдали, дал, дала, дали, выдал, выдала, выдали, перевёл, перевел, перевела, перевели, перечислил, перечислила, перечислили,
  погасил, погасила, погасили, получил, получила, получили, получено, купил, купила, купили, взял, взяла, взяли, вернул, вернула, вернули, потратил, потратила, потратили, рассчитался, рассчиталась, рассчитались,
  выплатил, выплатила, выплатили, выплачено, скинул, скинули, перекинул, перекинули, поступило, поступили, пришло, пришли, paid, gave, sent, spent, bought, received, got, transferred, repaid, wired`);
/** Someone else's word for it. "Usta aytdi, 300 ming berdim" is not: there they paid themselves. */
const REPORTED = wordList(`
  aytdi, aytyapti, aytishicha, aytgan, deyapti, deydi, dedi, deyishdi, deyishyapti, deyishgan, deb, yozdi, yozibdi, yozyapti,
  сказал, сказала, сказали, говорит, говорят, по словам, пишет, пишут, написал, написала, написали, сообщил, сообщила, сообщили, утверждает, утверждают,
  said, says, told me, told us, according to, claims, claimed, writes, wrote`);
/** "Иккинчи одам керак эмас": something not needed is no plan. */
const NOT_NEEDED = /(?<![\p{L}])(?:(?:kerak|керак)\s+(?:emas|эмас)|не\s+(?:надо|нужно)|no\s+need\s+to|(?:don'?t|do\s+not)\s+need\s+to)(?![\p{L}])/giu;
const QUESTION_END = /[?？؟][\s\p{P}\p{S}]*$/u;
const INTENTION = /mo[qk]chi/;
const QUESTION_PARTICLES = wordSet('mi, mu');
const UZBEK_QUESTION = /(?:mi|mikan|mikin)$/;
/** Russian ends in -ми too, written here in full or as Latin: "наличными", "nalichnymi". */
const RUSSIAN_CASE = /(?:ами|ями|ыми|ьми)$/i;
const RUSSIAN_IN_LATIN = wordSet('nalichnymi, rublyami, dollarami, dengami, lyudmi');
const QUESTION_STARTS = wordList('did, do, does, is, are, can, could, should, shall, will, would, have we, have you, have they, has he, has she, has anyone, was it, was that, were they');
const BARE_COMMANDS = wordSet(PAYING_VERBS.join(', '));

function endsAsQuestion({ key, raw }: Piece): boolean {
  if (QUESTION_PARTICLES.has(key)) return true;
  return key.length > 3 && UZBEK_QUESTION.test(key) && !RUSSIAN_CASE.test(raw) && !RUSSIAN_IN_LATIN.has(key);
}

/** "что бы" is "so that". */
const conditional = (words: Piece[]) => words.some((word, at) => word.raw.toLowerCase() === 'бы' && words[at - 1]?.key !== fold('что'));
/** "Ли" with a capital, or at the start, is a surname. */
const askedWithLi = (words: Piece[]) => words.some((word, at) => word.raw === 'ли' && at > 0);

/** The message is itself a question. */
export function asksSomething(said: string): boolean {
  if (QUESTION_END.test(said.trim())) return true;
  const words = wordsOf(said);
  if (words.length === 0) return false;
  return endsAsQuestion(words.at(-1)!) || (/^[a-z]/i.test(words[0].raw) && QUESTION_STARTS.some((phrase) => fitsAt(words, 0, phrase)));
}

/** "to'ladim deyapti", "berdim dedi": a first person inside someone else's sentence. "Usta aytdi, 300 ming berdim" is the person's own. */
const quoted = (words: Piece[], { at, length }: Match) => REPORTED.some((phrase) => fitsAt(words, at + length, phrase));

/**
 * It did not happen, or is not stated as done: a question, an order, a plan, something still to pay. With
 * `answer` the words reply to a question, so they stand on what they answer: "naqd bo'ladi" names no payment
 * of its own, and that alone proves nothing.
 */
export function notHappened(said: string, answer = false): boolean {
  const text = said.replace(NOT_NEEDED, ' ');
  if (asksSomething(text)) return true;
  const words = wordsOf(text);
  if (words.length === 0) return false;
  if (BARE_COMMANDS.has(words.at(-1)!.key)) return true;
  if (words.some((word) => INTENTION.test(word.key)) || conditional(words) || askedWithLi(words)) return true;
  if (matches(words, NOT_DONE).length > 0 || matches(words, FUTURE).length > 0) return true;
  const ours = matches(words, WE_PAID).some((match) => !ruledOut(words, match) && !quoted(words, match));
  if (matches(words, REPORTED).length > 0 && !ours) return true;
  const moved = matches(words, MONEY_MOVED);
  if (moved.some((match) => NEGATIONS.has(words[match.at - 1]?.key ?? ''))) return true;
  // "в долг" says how it was paid, not that it is still to pay.
  return !answer && moved.length === 0 && !paidBy(text, words, DEBT) && matches(words, UNLESS_DONE).length > 0;
}

const YES = wordSet("ha, xo'p, albatta, да, конечно, ага, yes, yeah, yep");

/** Asked whether it has been paid, the answer has to say that it was. */
export function saysDone(text: string): boolean {
  const words = wordsOf(text);
  return !notHappened(text) && (words.some((word) => YES.has(word.key)) || says(words, MONEY_MOVED));
}

const CANCEL = wordList(`
  bekor*, o'chir, o'chiring, o'chirib tashla, o'chirib tashlang, yozma, yozmang, kerakmas, kerak emas, отмена, отмени, отмените, отменить, отменяй, удали, удалите, удалить,
  не надо, не нужно, не записывай, не записывайте, забудь, cancel, delete, remove, scrap, drop it, never mind, forget it`);

/** The person asked to drop a card. A model's reading of "rahmat" is not enough for that. */
export const cancelWords = (text: string) => matches(wordsOf(text), CANCEL).length > 0;

type Direction = 'payable' | 'receivable';

const WE_PAID = wordList(`
  to'ladim, to'ladik, to'lab berdim, to'lab berdik, to'lab qo'ydim, to'lab qo'ydik, to'lab yubordim, to'lab yubordik, to'laganman, to'laganmiz,
  berdim, berdik, bervordim, bervordik, berib yubordim, berib yubordik, berib qo'ydim, berib qo'ydik, qaytardim, qaytardik, o'tkazdim, o'tkazdik,
  jo'natdim, jo'natdik, tashladim, tashladik, uzdim, uzdik, yopdim, yopdik, perechislenie qildim, perechislenie qildik, o'tkazma qildim, o'tkazma qildik,
  to'lov qildim, to'lov qildik, qarzimiz*, qarzim*`);
/** A Russian or English past tense does not say who: the words around it do. */
const SOMEONE_PAID = wordList(`
  закрыл, закрыла, закрыли, заплатил, заплатила, заплатили, оплатил, оплатила, оплатили, отдал, отдала, отдали, перевёл, перевел, перевела, перевели, перечислил, перечислила, перечислили,
  погасил, погасила, погасили, выплатил, выплатила, выплатили, скинул, скинули, перекинул, перекинули, paid, sent, gave, transferred, repaid, wired`);
/** "Вернул" is said of either side as readily, so alone it says nothing at all. */
const SOMEONE_RETURNED = wordList('вернул, вернула, вернули, returned');
const SOMEONE_RECEIVED = wordList('получил, получила, получили, received');
const THEY_PAID = wordList(`
  to'ladi, to'lashdi, to'lab berdi, to'lab ketdi, to'lab berishdi, berdi, berishdi, berib ketdi, qaytardi, qaytarishdi, o'tkazdi, o'tkazishdi, o'tkazib berdi,
  o'tkazib berishdi, jo'natdi, jo'natishdi`);
const CAME_IN = wordList('tushdi, tushgan, oldik, oldim, получено, поступило, поступили, пришло, пришли, упало, упали, зашло, зашли, paid us, paid me, got paid');
const WE = wordSet('я, мы, i, we, biz, men');
const TO_US = wordSet('нам, мне, us, me, bizga, menga');
const FROM_US = wordList('от нас, от меня, from us, from me, bizdan, mendan');
/** "got" is for "got paid", where the verb is the same as in "we paid". */
const THIRD_PARTY = wordSet('он, она, они, клиент, покупатель, заказчик, he, she, they, customer, client, buyer, got');
/** Before the verb these leave it with no subject: "Сегодня заплатил". */
const NOT_A_SUBJECT = wordSet('сегодня, вчера, позавчера, уже, today, yesterday, already, just');
/** Russian dative, which puts the person paid before the verb: "Акмалу заплатил", "Нефт Базе отдал". */
const RUSSIAN_DATIVE = /[а-яё](?:у|ю|е|ам|ям)$/i;
const OUR_ACCOUNTS = wordSet('kassa*, bank*, hisob*, karta*, qarz*, naqd*');

/** Who a verb that does not mark the person is about, or null if the words leave it open. */
function subjectOf(words: Piece[], at: number): 'us' | 'them' | null {
  const before = words[at - 1];
  if (THIRD_PARTY.has(before.key)) return 'them';
  if (words.slice(Math.max(0, at - 3), at).some((word) => WE.has(word.key))) return 'us';
  return NOT_A_SUBJECT.has(before.key) || RUSSIAN_DATIVE.test(before.raw) ? 'us' : null;
}

/** Who paid whom. Both come back when the words leave it open, and none when they do not say. */
export function directionWords(text: string): Direction[] {
  const words = wordsOf(text);
  const found = new Set<Direction>();
  const fromUs = matches(words, FROM_US).length > 0;
  const toUs = ({ at, length }: Match) => TO_US.has(words[at - 1]?.key ?? '') || TO_US.has(words[at + length]?.key ?? '');

  const verbs = (list: Phrase[], ifOurs: Direction, whenAlone: 'us' | null) => {
    for (const match of matches(words, list)) {
      if (ruledOut(words, match)) continue;
      const subject = match.at === 0 ? whenAlone : subjectOf(words, match.at);
      if (toUs(match)) found.add('receivable');
      else if (fromUs) found.add('payable');
      else if (subject === 'us') found.add(ifOurs);
      else if (subject === 'them') found.add(ifOurs === 'payable' ? 'receivable' : 'payable');
      else found.add('payable').add('receivable');
    }
  };
  verbs(SOMEONE_PAID, 'payable', 'us');
  verbs(SOMEONE_RETURNED, 'payable', null);
  verbs(SOMEONE_RECEIVED, 'receivable', 'us');

  if (says(words, WE_PAID)) found.add('payable');
  if (says(words, CAME_IN)) found.add('receivable');
  const firstAt = (test: (word: Piece) => boolean) => words.findIndex(test);
  const firstToUs = firstAt((word) => TO_US.has(word.key));
  const firstTarget = firstAt((word) => DATIVE.test(word.key) && !OUR_ACCOUNTS.has(word.key) && !TO_US.has(word.key));
  const firstStaff = matches(words, JOBS)[0]?.at ?? -1;
  for (const match of matches(words, THEY_PAID)) {
    if (ruledOut(words, match)) continue;
    found.add('receivable');
    const before = (at: number) => at >= 0 && at < match.at;
    if (!before(firstToUs) && !toUs(match) && (before(firstTarget) || before(firstStaff))) found.add('payable');
  }
  return (['payable', 'receivable'] as const).filter((direction) => found.has(direction));
}

const CAME_TO_US = wordList(`
  tushdi, tushgan, tushibdi, поступило, поступили, поступила, зашло, зашли, упало, упали, пришло, пришли, получил, получила, получили, получено, came in, received`);
const SPENT = wordList(`
  oldim, oldik, sotib oldim, sotib oldik, xarid qildim, xarid qildik, sarfladim, sarfladik, ketdi, ketgan, купил, купила, купили, взял, взяла, взяли, потратил, потратила, потратили, bought, spent`);

/** Money arrived, and nothing here says any left. A narrow test: "oldim" alone is more often a purchase. */
export function moneyCameIn(text: string): boolean {
  const words = wordsOf(text);
  return says(words, CAME_TO_US) && !says(words, WE_PAID) && !says(words, SOMEONE_PAID) && !says(words, SPENT);
}

const DEBT_WORDS = wordList(`
  qarzimiz*, qarzim*, qarzni, qarzini, qarzdan, долг, долга, долгу, долги, задолженность, задолженности, debt, debts`);

/** Paying off a debt. "qarzga oldim" and "в долг" are the opposite: bought with money still owed. */
export function settlesDebt(text: string): boolean {
  const words = wordsOf(text);
  return says(words, DEBT_WORDS) && !paidBy(text, words, DEBT);
}

// ─── What kind of spending it is ────────────────────────────────────────────

const TOTAL_WORD = /(?<![\p{L}])(?:jami|итого|всего|в сумме|на сумму|total|altogether|in all)(?![\p{L}])/giu;
const NEAR_TOTAL = 16;

/** A sum said to be the whole, the one nearest the word for it: "8 million total", "jami 9 mln". */
export function statedTotals(text: string): number[] {
  const mentions = parseMoneyMentions(text).filter((m) => !m.negated && !m.uncertain && !m.rate);
  const sums = [...text.matchAll(TOTAL_WORD)].flatMap((word) => {
    const start = word.index;
    const end = start + word[0].length;
    const gap = (m: MoneyMention) => Math.max(m.start - end, start - m.end, 0);
    // "15 mingdan jami 3 mln": equally near, the price is the one that is no total.
    const nearest = [...mentions].sort((a, b) => gap(a) - gap(b) || Number(Boolean(a.perUnit)) - Number(Boolean(b.perUnit)))[0];
    return nearest && gap(nearest) <= NEAR_TOTAL ? [nearest.amount] : [];
  });
  return [...new Set(sums)];
}

const WATER = wordList('suv, suvga, suvni, suvi, suvning, suv uchun, вода, воду, воды, воде, water');
const WHICH_WATER = wordList(`
  suv haqi, sug'or*, ekin*, vodokanal*, ichimlik*, idora*, ofis*, kommunal*, полив, полива, поливу, поливом, поливная, поливную, поливной, поливные,
  орошение, орошения, водоканал, водоканала, водоканалу, водопровод, водопровода, контора, конторы, конторе, контору, офис, офиса, офисе, коммуналка, коммуналку,
  коммунальные, irrigation, irrigating, drinking, tap, office, utility, municipal, water bill, city water`);
/** "Suvga 900 ming" may be water for a field or the office's bill, and the two land in different places. */
export const waterIsOpen = (text: string) => matches(wordsOf(text), WATER).length > 0 && matches(wordsOf(text), WHICH_WATER).length === 0;

const SERVICE = wordList(`
  vet, vrach*, doktor*, veterinar*, vetvrach*, usta*, ko'rik*, xizmat*, mehnat haqi*, chaqirish haqi*, konsultatsiya*, врач, врача, врачу, врачом, доктор, доктора,
  доктору, ветеринар, ветеринара, ветеринару, ветврач, ветврача, ветврачу, мастер, мастера, мастеру, услуга, услуги, услугу, услуг, услугами, осмотр, осмотра, осмотру,
  за работу, консультация, консультацию, service, services, visit, visits, call out, consultation, labour, labor`);
const DIRECT_USE = wordList(`
  to'g'ridan to'g'ri, omborga kirmadi, omborga kirmagan, omborga kirgani yo'q, omborga tushmadi, omborga olmadik, ombordan o'tmadi,
  darrov quydim, darrov quydik, darrov quydirdik, darrov ishlatdim, darrov ishlatdik, darrov sarfladik, darhol quydik, darhol ishlatdik, shu zahoti ishlatdik,
  сразу залил, сразу залила, сразу залили, сразу заправил, сразу заправили, сразу использовал, сразу использовали, сразу потратили, сразу в бак, сразу в трактор,
  напрямую, минуя склад, мимо склада, на склад не, не на склад, не через склад, used straight away, used right away, used immediately, used on the spot, used directly,
  straight into, directly into, not into stock, not into the warehouse, never went to the warehouse, did not go to the warehouse`);

/** Paying for someone's work. */
export const serviceWords = (text: string) => matches(wordsOf(text), SERVICE).length > 0;

/** Goods used on the spot, which never went through the warehouse. */
export const directUseWords = (text: string) => matches(wordsOf(text), DIRECT_USE).length > 0;

/** Paying ahead. */
export const advanceWords = (text: string) => matches(wordsOf(text), ADVANCES).length > 0;

const WAREHOUSE = wordList('ombor*, склад, склада, складе, складу, warehouse, stock');

/** The goods went into the warehouse. */
export const warehouseWords = (text: string) => says(wordsOf(text), WAREHOUSE);

const GENERAL = wordList(`
  umumiy*, shared, general, hammasi uchun, hammaga, для всех, общий, общая, общее, общие, общего, общей, общему, общую, общим, общем, общих, общими`);

/** The cost is everyone's, said in so many words: "общежитие" is not that, and neither is "umumiy emas". */
export const saysGeneral = (text: string) => says(wordsOf(text), GENERAL);

const AND = wordSet('va, hamda, and');

/** The words join two things: the "и" of "за интернет и нотариусу", which folds to the English "I". */
export const joinsThings = (text: string) => wordsOf(text).some((word) => AND.has(word.key) || word.raw.toLowerCase() === 'и');

// ─── The model's own sentence ───────────────────────────────────────────────

const DONE = wordList(`
  saqlandi, saqladim, saqladik, saqlangan, saqlab qo'ydim, saqlab qo'ydik, saqlab oldim, saqlab oldik, yozildi, yozilgan, yozdim, yozdik, yozib qo'ydim, yozib qo'ydik, yozib oldim, yozib oldik,
  kiritildi, kiritilgan, kiritdim, kiritdik, kiritib qo'ydim, kiritib qo'ydik, qayd etildi, qayd etilgan, qayd qilindi, qayd qilingan, qayd etdim, qayd qildim, qayd etib qo'ydim, qayd qilib qo'ydim,
  qo'shildi, qo'shilgan, qo'shdim, qo'shib qo'ydim, qo'shib qo'ydik, bajarildi, bajarilgan, bajardim, tasdiqlandi, tasdiqlangan, tasdiqladim, amalga oshirildi, rasmiylashtirildi,
  ro'yxatga olindi, ro'yxatga oldim, hisobga olindi, hisobga oldim, yozib qo'yildi, kiritib qo'yildi, saqlab qo'yildi, kiritib bo'ldim, yozib bo'ldim, saqlab bo'ldim, bajarib qo'ydim, bajarib bo'ldim,
  записал, записала, записали, записан, записана, записано, записаны, запись создана, сохранил, сохранила, сохранили, сохранён, сохранен, сохранена, сохранено, сохранены,
  внёс, внес, внесла, внесли, внесён, внесен, внесена, внесено, внесены, добавил, добавила, добавили, добавлен, добавлена, добавлено, добавлены, создал, создала, создали, создан, создана, создано, созданы,
  проведён, проведен, проведена, проведено, проведены, провёл, провел, оформил, оформлен, оформлена, оформлено, зафиксировал, зафиксирован, зафиксирована, зафиксировано, учтён, учтен, учтена, учтено,
  подтверждён, подтвержден, подтверждена, подтверждено, подтвердил, готово, сделано, сделал, выполнено, выполнил, принято,
  recorded, saved, done, logged, added, entered, booked, posted, stored, confirmed, created, completed, finished`);
const NOT_YET = wordSet('not, never, nothing, will, once, after, until, when, if, be, не, ни, ничего, будет, будут, после, когда, если');
const CARD_READY = wordList("tayyor, tayyorlandi, tasdiqlang, tasdiqlab qo'ying, готов, готова, готово, готовы, подтвердите, ready, confirm");

/** The model says something is saved. "tayyorlandi" (prepared) is not that, and neither is "not saved yet". */
export function claimsDone(text: string): boolean {
  const words = wordsOf(text);
  return matches(words, DONE).some(({ at }) => !words.slice(Math.max(0, at - 3), at).some((word) => NOT_YET.has(word.key)));
}

/** The model says a card is waiting. True only when one is. */
export const claimsCard = (text: string) => matches(wordsOf(text), CARD_READY).length > 0;
