/**
 * Turns the words a person used into records. Names are compared word by word, never as raw
 * substrings: a number only equals itself, and a word may carry a grammatical ending, so
 * "Agrobankdan" is Agrobank while №12 is not №1 and "mol" is not Shimoliy.
 *
 * Order: id, then key and exact name, then the whole name with endings, then a remembered phrase,
 * then part of a name. Several matches are reported rather than picked: choosing is the person's job.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ACCOUNT_TYPES } from '@yap/shared';
import { parseMoneyMentions } from '@yap/shared/formulas/money-text';
import { parseQuantities, paymentWords } from '@yap/shared/formulas/record-words';
import { APOSTROPHES, unitOf } from '@yap/shared/formulas/units';
import { schema } from '../../../db/client';
import { ctx, hasPermission, tx } from '../../../core/context';
import { BARE_AMOUNT_FLOOR } from './routing';
import { GOODS, HERD_WORDS, ITEM_KINDS, MACHINES, ORDINALS, PLACE_WORDS } from './vocabulary';

export type TargetType =
  | 'category' | 'account' | 'counterparty' | 'item' | 'warehouse' | 'cost_center';

export interface Candidate {
  id: string;
  name: string;
  /** Other names it answers to: translations, a key, an inventory number. */
  names: string[];
  key?: string;
  /** A person who stands for it. They point at the record but are not its name. */
  contact?: string;
  /** Goods, a machine, a place: a word ending can't turn it into someone else, as it can Aziz into Aziza. */
  thing?: boolean;
  extra?: Record<string, unknown>;
}

export type Resolution =
  | { status: 'found'; candidate: Candidate; how: 'id' | 'alias' | 'exact' | 'partial' }
  | { status: 'ambiguous'; candidates: Candidate[] }
  | { status: 'none'; candidates: Candidate[] };

// ─── Words ──────────────────────────────────────────────────────────────────

const LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', ғ: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', қ: 'q',
  л: 'l', м: 'm', н: 'n', о: 'o', ў: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ҳ: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

const CYRILLIC = /\p{Script=Cyrillic}/u;
/** Apostrophes, combining marks and invisible characters: none of them changes a word. */
const SILENT = new RegExp(`[${APOSTROPHES}\\p{M}\\p{Cf}]`, 'gu');
const inLatin = (text: string) => text.replace(/\p{Script=Cyrillic}/gu, (letter) => LATIN[letter] ?? letter);

/** Spellings the scripts and a Russian keyboard do not keep apart: Хамкор is Hamkor, Ем is Yem, цемент is sement. */
const sameSound = (word: string) =>
  word.replace(/c(?!h)/g, 'k').replace(/ts/g, 's').replace(/q/g, 'k').replace(/(?<![sc])k?h/g, 'x').replace(/(^|[aeiou])e/g, '$1ye');

interface Word {
  text: string;
  cyrillic: boolean;
  /** A № sign stands before this number, or its typed form: N1, No 1, nomer 1. */
  signed?: boolean;
}

const isNumber = (word: Word) => /^\p{N}/u.test(word.text);

/** What can follow a number and leave it that number: 3chi, 3-chi, 3-sonli, 3ga, 3rd. */
const AFTER_NUMBER = /^(?:(?:[iu]?n?chi)?(?:si)?(?:ga|ka|da|dan|ni|ning)?|sonli|rakamli|nomerli|st|nd|rd|th)$/;
/** Only written onto the number, in Cyrillic: 3-го, 2-ое, 2-м. "3 м" is three metres, and T-40M is a tractor. */
const RUSSIAN_ORDINAL = /^(?:y|ya|ye|yu|iy|oy|yey|aya|uyu|oye|yee|m|om|yem|im|x|ix|go|mu|ogo|omu|yego|yemu)$/;
/** The № sign as typed on a keyboard that has none: N1, No 1, nomer 1. */
const NUMBER_SIGN = /^(?:n|no|nomer|rakam|rakami)$/;

const tidyNumber = (raw: string) => raw.replace(',', '.').replace(/^0+(?=\p{N})/u, '');

/** The words of a text. A letter or a decimal on a number stays on it, because 3A and 82.1 are not 3 and 82. */
function wordsOf(text: string): Word[] {
  const clean = text.normalize('NFC').toLowerCase().replace(SILENT, '');
  const words: Word[] = [];
  let end = 0;
  for (const match of clean.matchAll(/\p{N}+(?:[.,]\p{N}+)?|\p{L}+/gu)) {
    const [raw] = match;
    const gap = clean.slice(end, match.index);
    end = match.index + raw.length;
    const last = words.at(-1);
    if (/^\p{N}/u.test(raw)) {
      const typedSign = last !== undefined && NUMBER_SIGN.test(last.text);
      if (typedSign) words.pop();
      words.push({ text: tidyNumber(raw), cyrillic: false, signed: typedSign || /[№#]/.test(gap) });
      continue;
    }
    // Only Russian ends a word in ы, so it is a case ending there, and not the Uzbek -i it would read as.
    const word = { text: sameSound(inLatin(raw.replace(/ы$/, 'y'))), cyrillic: CYRILLIC.test(raw) };
    if (last && isNumber(last)) {
      const written = gap === '' || gap === '-';
      if (AFTER_NUMBER.test(word.text) || (written && word.cyrillic && RUSSIAN_ORDINAL.test(word.text))) continue;
      if ((written && raw.length === 1) || (gap === '' && !isCounted(word) && unitOf(raw) === null)) {
        last.text += word.text;
        continue;
      }
    }
    words.push(word);
  }
  return words;
}

const spelled = (words: Word[]) => words.map((word) => word.text).join(' ');
const listOf = (source: string) => source.trim().split(/\s+/).flatMap(wordsOf);

/** One form for every spelling that compares equal, so a phrase is stored once whichever way it was written. */
export const normalize = (text: string) => spelled(wordsOf(text));

// ─── Does this word fit that word ───────────────────────────────────────────

const NOT = 0;
/** It fits, but it may as well be someone else. */
const UNSURE = 1;
const SURE = 2;

/** A name word shorter than this takes no endings: "unga" is not Un. */
const MIN_STEM = 3;
/** A cut-off word shorter than this is no evidence of a name. */
const MIN_FRAGMENT = 4;
/** Longer than this, a word is not taken for a personal name. */
const PERSONAL_NAME = 6;

const CASE = '(?:ning|ni|ga|da|dan|dagi|niki)?';
const ENDING = new RegExp(`^(?:s|(?:lar)?(?:i|si|imiz|miz|ingiz|ngiz)?${CASE})$`);
/** "my" and "your": kassamdan, Agrobankimdan. Four letters at least, or Karim would be a form of Kar. */
const AFTER_VOWEL = new RegExp(`^(?:m|ng)${CASE}$`);
const AFTER_CONSONANT = new RegExp(`^(?:im|ing)${CASE}$`);
const RUSSIAN_ENDING = /^(?:a|ya|u|yu|e|i|y|om|em|oy|ey|am|yam|ax|yax|ami|yami)$/;

/**
 * A word of the name as it stands or with an ending. Russian endings only count in Cyrillic, so Latin
 * "Salima" is not Salim. In Cyrillic, Азиза is "of Aziz" or Aziza, who is someone else; only -ом is his alone.
 */
function fit(said: Word, name: Word): number {
  if (said.text === name.text) return SURE;
  if (isNumber(said) || isNumber(name)) return NOT;
  const ends = (stem: string, ending: RegExp) => said.text.startsWith(stem) && ending.test(said.text.slice(stem.length));
  if (name.text.length >= MIN_STEM && ends(name.text, ENDING)) return SURE;
  const mine = /[aeiou]$/.test(name.text) ? AFTER_VOWEL : AFTER_CONSONANT;
  if (name.text.length > MIN_STEM && ends(name.text, mine)) return SURE;
  // -ga turns to -ka only after k, and q has merged into k: Agrobankka, while "boshqa" (other) is not Bosh.
  if (name.text.length >= MIN_STEM && name.text.endsWith('k') && said.text === `${name.text}ka`) return SURE;
  if (!said.cyrillic) return NOT;
  const stem = name.text.replace(/(?:ya|a|o|e)$/, '');
  if (stem.length < MIN_STEM || /[aeiou]$/.test(stem) || !ends(stem, RUSSIAN_ENDING)) return NOT;
  const hers = stem === name.text && stem.length <= PERSONAL_NAME && !/[oe]m$/.test(said.text);
  return hers ? UNSURE : SURE;
}

const fits = (said: Word, name: Word) => fit(said, name) > NOT;
const isOneOf = (word: Word | undefined, list: Word[]) => word !== undefined && list.some((entry) => fits(word, entry));

/** The head of an Uzbek compound carries a possessive that a person may drop: Ozuqa ombori, "omborga". */
const withoutPossessive = (word: Word): Word => ({ ...word, text: word.text.replace(/s?i$/, '') });

/** How a said word fits the word at this place in a name. */
function fitAt(said: Word, name: Word[], at: number): number {
  return Math.max(fit(said, name[at]), at > 0 ? fit(said, withoutPossessive(name[at])) : NOT);
}

/** Said short: "Veterinar" for Veterinariya. */
const isFragment = (said: Word, name: Word) => !isNumber(said) && said.text.length >= MIN_FRAGMENT && name.text.startsWith(said.text);

const GENERIC_WORDS = listOf('dala maydon uchastka участок поле field');
/** These only say what kind of thing it is: "7-dala" is field №7, and "dala" alone names no field. */
const isGeneric = (word: Word) => isOneOf(word, GENERIC_WORDS);

/** Whether a name is a field's, by its type or, with none known, by its label. Only there is "dala" a kind of name. */
const namesField = (name: string, type?: unknown) =>
  type === undefined ? /^\s*№/.test(name) || wordsOf(name).some(isGeneric) : type === 'field';

const TIME_WORDS = listOf(`
  yanvar fevral mart aprel may iyun iyul avgust sentabr sentyabr oktabr oktyabr noyabr dekabr
  january february march april june july august september october november december
  kun hafta oy oyi oyga oyda oydan yil soat день дня дней неделя недель месяц месяцев год лет час часов
  day week month year hour`);
/** A number on one of these is the document's or a phone's: "faktura №3", "№3 faktura". */
const DOCUMENT_WORDS = listOf(`
  faktura schet chek kvitansiya shartnoma nakladnoy hujjat akt tel telefon
  счет счёт фактура чек квитанция договор накладная накладной акт телефон invoice receipt bill contract phone`);
/** Before one of these a number counts something, so it does not number the name beside it. */
const COUNT_WORDS = [...TIME_WORDS, ...DOCUMENT_WORDS, ...listOf(`
  kishi odam nafar marta tup foiz ishchi smena reys chorak brigada guruh kvartal tiyin daqiqa minut sekund gektar sotix
  kunlik haftalik oylik yillik soatlik yosh km metr kvt
  человек люди людей раз рейс рейсов смена бригада процент процентов гектар гектаров минута минут секунда число чисел
  people person time percent minute second hectare shift trip kw`)];
const isCounted = (word: Word) => isOneOf(word, COUNT_WORDS);
/** After one of these it is a date, a time or a document's number. */
const COUNTED_AFTER = [...TIME_WORDS, ...DOCUMENT_WORDS];

const textsOf = (source: string) => new Set(listOf(source).map((word) => word.text));

const ADJECTIVES = textsOf(`
  yangi eski katta kichik kichkina mayda oq qora qizil ko'k yashil sariq asosiy umumiy bosh yaxshi yomon baland past uzun
  qisqa keng tor og'ir yengil toza arzon qimmat birinchi ikkinchi uchinchi oxirgi boshqa hamma barcha butun
  новый новая новое старый старая старое большой большая большое малый малая малое главный главная главное
  основной основная основное общий общая общее белый белая белое черный черная черное красный красная красное другой другая другое
  new old big small large main general common white black red green blue good first second third last other another`);
/** Words that start a name without telling it apart: "yangi nasos" is not Yangi dala, and "qo'y" is not Qo'y Savdo. */
const COMMON = new Set([...ADJECTIVES, ...textsOf(`
  chorva qo'y qo'zi qo'chqor sovliq mol qoramol sigir buzoq ot echki hayvon tovuq parranda baliq
  don yem ozuqa pichan somon suv tuz neft gaz moy dori go'sht sut jun teri urug' o'g'it
  скот овца баран корова зерно вода соль
  sheep cattle cow goat horse livestock water gas oil salt grain feed`)]);

/** Uzbek says "Chorva tarozisi" for the scale of livestock: the first word says whose, not what. */
function isCompound(name: Word[]): boolean {
  const letters = name.filter((word) => !isNumber(word));
  return letters.length > 1 && /[^aeiou]i$/.test(letters.at(-1)!.text);
}

/** The words that can tell a name apart alone: its number, and its first real word if that is more than a common word. */
function leading(name: Word[]): Word[] {
  const telling = name.filter((word) => !isGeneric(word));
  const words = telling.length > 0 ? telling : name;
  const first = words.find((word) => !isNumber(word));
  const named = first && !COMMON.has(first.text) && !isCompound(name) ? [first] : [];
  return isNumber(words[0]) ? [words[0], ...named] : named;
}

/** "Agro bank" for Agrobank, and "Kassa dan" for Kassadan: whether a name is one word or two is only spacing. */
function spacedAs(said: Word[], name: Word[]): Word[] {
  const joined = (from: number, length: number): Word | null => {
    const words = said.slice(from, from + length);
    if (words.length < length || words.some(isNumber)) return null;
    const whole = { text: words.map((word) => word.text).join(''), cyrillic: words.some((word) => word.cyrillic) };
    return name.some((part) => fits(whole, part)) ? whole : null;
  };
  const spaced: Word[] = [];
  for (let i = 0; i < said.length; i += 1) {
    const length = [3, 2].find((n) => joined(i, n)) ?? 1;
    spaced.push(length === 1 ? said[i] : joined(i, length)!);
    i += length - 1;
  }
  return spaced;
}

// ─── How well words cover a name ────────────────────────────────────────────

const NO_MATCH = 0;
/** Fits, but too little to rest a record on: a later word, or a word cut short. */
const WEAK = 1;
/** Enough to say which record: the leading word, or two whole words. */
const STRONG = 2;
const WHOLE_NAME = 3;
const EXACT = 4;
const KEY = 5;

interface Reading {
  /** The word for field may be left out, or added. */
  field?: boolean;
  /** It may be a person, so a word that may be someone else is not enough for a name of one word. */
  person?: boolean;
}

/** How well a person's words cover a name. All their words must be in it, so "Arpa urug'i" is not Arpa. */
function coverage(said: Word[], name: Word[], { field = false, person = false }: Reading = {}): number {
  if (name.length === 0) return NO_MATCH;
  const covered = new Set<Word>();
  const least = person && name.length === 1 ? SURE : UNSURE;
  let weak = false;
  for (const word of spacedAs(said, name)) {
    const hits = name.filter((_, at) => fitAt(word, name, at) >= least);
    hits.forEach((hit) => covered.add(hit));
    if (hits.length > 0) continue;
    if (name.some((part, at) => fitAt(word, name, at) > NOT || isFragment(word, part))) weak = true;
    else if (!(field && isGeneric(word))) return NO_MATCH;
  }
  if (weak) return WEAK;
  if (covered.size === name.length) return WHOLE_NAME;
  return covered.size > 1 || leading(name).some((word) => covered.has(word)) ? STRONG : WEAK;
}

/** Typed into an optional field to get past it. Punctuation alone already normalises to nothing. */
const PLACEHOLDER = /^(?:0+|n a|na|net|none|null|yok|nomalum|neizvestno|unknown)$/;
const usable = (words: Word[]) => words.length > 0 && !PLACEHOLDER.test(spelled(words));

/** Latin c, which sameSound reads as k, read as s: Acros can be Акрос or Асрос. */
const softC = (text: string) => text.replace(/c(?!h)/gi, 's');

/** A name as it may be read: Latin c as k or as s, and two of its words as one (Hamkor bank, Hamkorbank). */
function readings(name: string): Word[][] {
  return [...new Set([name, softC(name)])].map(wordsOf).flatMap((words) => [
    words,
    ...words.slice(1).flatMap((word, i) =>
      isNumber(word) || isNumber(words[i]) ? [] : [[...words.slice(0, i), { ...word, text: words[i].text + word.text }, ...words.slice(i + 2)]],
    ),
  ]);
}

function namesOf(candidate: Candidate): Word[][] {
  const others = [...candidate.names, candidate.key ?? ''].filter((name) => usable(wordsOf(name)));
  return [candidate.name, ...others].flatMap(readings).filter((words) => words.length > 0);
}

const contactOf = (candidate: Candidate) => [wordsOf(candidate.contact ?? '')].filter(usable);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A record's id, as a settled card holds it, and no word anyone said. */
export const isRecordId = (phrase: string) => UUID.test(phrase.trim());

// ─── Matching ───────────────────────────────────────────────────────────────

interface Match {
  candidate: Candidate;
  grade: number;
}

function matchesOf(said: Word[], candidates: Candidate[], person: boolean): Match[] {
  const text = spelled(said);
  const grade = (candidate: Candidate) => {
    if (candidate.key !== undefined && spelled(wordsOf(candidate.key)) === text) return KEY;
    const names = namesOf(candidate);
    if (names.some((name) => spelled(name) === text)) return EXACT;
    const reading = { field: namesField(candidate.name, candidate.extra?.type), person };
    const byName = names.map((name) => coverage(said, name, reading));
    const byContact = contactOf(candidate).map((name) => Math.min(STRONG, coverage(said, name, { person: true })));
    return Math.max(NO_MATCH, ...byName, ...byContact);
  };
  return candidates.map((candidate) => ({ candidate, grade: grade(candidate) })).filter((match) => match.grade > NO_MATCH);
}

/** What the names alone decide. Null when nothing fits a whole name, and only then may a remembered phrase speak. */
function settled(matches: Match[]): Resolution | null {
  const graded = (grade: number) => matches.filter((match) => match.grade === grade);
  // A category's key is exact by definition, even where a translation also fits: "water" is Suv haqi.
  const named = [KEY, EXACT].map(graded).find((hits) => hits.length === 1);
  if (named) return { status: 'found', candidate: named[0].candidate, how: 'exact' };
  const whole = matches.filter((match) => match.grade >= WHOLE_NAME).map((match) => match.candidate);
  if (whole.length === 1) return { status: 'found', candidate: whole[0], how: 'partial' };
  return whole.length > 1 ? { status: 'ambiguous', candidates: whole } : null;
}

/** Part of a name. A phrase settles only a word that matches no name; once one does, the phrase brings the question back. */
function partly(matches: Match[], aliased: Candidate[], candidates: Candidate[]): Resolution {
  if (matches.length === 0) {
    if (aliased.length === 1) return { status: 'found', candidate: aliased[0], how: 'alias' };
    return aliased.length > 1 ? { status: 'ambiguous', candidates: aliased } : { status: 'none', candidates };
  }
  const choices = [...new Set([...matches.map((match) => match.candidate), ...aliased])];
  if (choices.length === 1 && matches[0].grade === STRONG) return { status: 'found', candidate: choices[0], how: 'partial' };
  return { status: 'ambiguous', candidates: choices };
}

/** The candidates this farm's remembered phrases give for these words. A phrase that overlaps its own record's name says nothing. */
async function remembered(type: TargetType, said: Word[], candidates: Candidate[]): Promise<Candidate[]> {
  const { aiAliases } = schema;
  const rows = await tx()
    .select({ phrase: aiAliases.phrase, targetId: aiAliases.targetId })
    .from(aiAliases)
    .where(and(eq(aiAliases.farmId, ctx().farmId), eq(aiAliases.targetType, type)));
  const spoken = rows.filter((row) => coverage(said, wordsOf(row.phrase)) === WHOLE_NAME);
  return candidates.filter((c) => spoken.some((row) => row.targetId === c.id && canLearn(row.phrase, [c])));
}

async function byWords(type: TargetType, said: Word[], candidates: Candidate[]): Promise<Resolution> {
  if (said.length === 0) return { status: 'none', candidates };
  const matches = matchesOf(said, candidates, type === 'counterparty');
  return settled(matches) ?? partly(matches, await remembered(type, said, candidates), candidates);
}

const isCatalogLabel = (word: string) => (ACCOUNT_TYPES as readonly string[]).includes(word) || unitOf(word) !== null;

/** The catalog writes "Kassa (cash)", "Dizel (l)" and "gas = Gaz", and a model may copy that whole. */
function withoutCatalogLabels(phrase: string): string {
  const label = /\s*\(([^()]*)\)$/.exec(phrase);
  const named = label && isCatalogLabel(label[1].trim()) ? phrase.slice(0, label.index) : phrase;
  return named.replace(/^[a-z_]+ = /, '');
}

/** "третье поле" is field 3, as "3-dala" is. Only beside a word for a place, because "second" has other work to do. */
const BEFORE_A_PLACE = '(?=[\\s-]+(?:dala|дала|maydon|майдон|uchastk|участ|пол[еёяю]|field|plot))';
const ORDINAL_WORDS = ORDINALS.map(([number, words]) => ({
  number: String(number),
  pattern: new RegExp(`(?<![\\p{L}\\p{N}])(?:${words})${BEFORE_A_PLACE}`, 'giu'),
}));
const withNumbers = (text: string) => ORDINAL_WORDS.reduce((rest, { number, pattern }) => rest.replace(pattern, number), text);

const LINKING_WORDS = textsOf('от из для на по за и с у в к of for from the a an uchun bilan va');

/** A phrase without the small words around it: having said "uchun" vouches for nothing it was glued to. */
const withoutLinks = (phrase: string) => phrase.split(/\s+/).filter((token) => !LINKING_WORDS.has(spelled(wordsOf(token)))).join(' ');

export async function resolve(type: TargetType, phrase: string, candidates: Candidate[]): Promise<Resolution> {
  const wanted = withNumbers(phrase.trim());
  if (UUID.test(wanted)) {
    const candidate = candidates.find((c) => c.id === wanted);
    return candidate ? { status: 'found', candidate, how: 'id' } : { status: 'none', candidates };
  }
  const plain = withoutCatalogLabels(wanted);
  for (const spelling of new Set([wanted, plain, softC(plain)])) {
    const hit = await byWords(type, wordsOf(spelling), candidates);
    if (hit.status !== 'none') return hit;
  }
  // "Вакцина от ящура": the small words join the name up, and are no part of it.
  return byWords(type, wordsOf(plain).filter((word) => !LINKING_WORDS.has(word.text)), candidates);
}

/**
 * Whether a word may be remembered as a nickname: only a word that shares nothing with any name.
 * What fits a name is for the name match to answer each time, and a bare number is not a nickname.
 */
export function canLearn(phrase: string, candidates: Candidate[]): boolean {
  const said = wordsOf(phrase).filter((word) => !isGeneric(word));
  if (UUID.test(phrase.trim()) || !usable(said) || said.every(isNumber)) return false;
  const shares = (name: Word[]) =>
    spacedAs(said, name).some((word) => name.some((part, at) => fitAt(word, name, at) > NOT || isFragment(word, part)));
  return !candidates.some((candidate) => [...namesOf(candidate), ...contactOf(candidate)].some(shares));
}

// ─── What the person really said ────────────────────────────────────────────

/** Numbers that are dates or shares, which the money and stock parsers have no reason to pick out. */
const NOT_NAMES = [
  /(?<![\p{L}\p{N}.,-])\p{N}{4}[-./]\p{N}{1,2}[-./]\p{N}{1,2}(?![\p{L}\p{N}])/gu, // 2026-11-04
  /(?<![\p{L}\p{N}.,-])\p{N}{1,2}[-./]\p{N}{1,2}[-./]\p{N}{2,4}(?![\p{L}\p{N}])/gu, // 04.11.2026
  // 04.11, and the hyphen keeps out a model number: SZ-3.6.
  /(?<![\p{L}\p{N}.,-])(?:0?[1-9]|[12]\p{N}|3[01])[./](?:0?[1-9]|1[0-2])(?![\p{L}\p{N}]|[.,]\p{N})/gu,
  /\p{N}{1,2}:\p{N}{2}/gu, // 14:30
  /\p{N}+(?:[.,]\p{N}+)?\s*%/gu,
  // "5 ga" is five hectares, unless the number is plainly a name: "№2 ga", "MTZ-82 ga".
  /(?<![\p{L}\p{N}№#.,-]|[№#]\s+)\p{N}{1,4}(?:[.,]\p{N}+)?\s+(?:ga|га)(?![\p{L}\p{N}])/gu,
];

/** The person's words, cut at every amount, quantity and date, and without the numbers that count something. */
function heardIn(text: string): Word[][] {
  const plain = NOT_NAMES.reduce((rest, pattern) => rest.replace(pattern, '\n'), text.toLowerCase());
  const measures = [
    ...parseMoneyMentions(plain).filter((m) => !m.bare || m.amount >= BARE_AMOUNT_FLOOR).map((m) => m.raw),
    ...parseQuantities(plain).map((q) => q.raw),
  ].sort((a, b) => b.length - a.length);
  const pieces = measures.reduce((parts, raw) => parts.flatMap((part) => part.split(raw)), plain.split('\n'));
  const counts = (words: Word[], i: number) => isNumber(words[i]) && (isOneOf(words[i + 1], COUNT_WORDS) || isOneOf(words[i - 1], COUNTED_AFTER));
  return pieces.map(wordsOf).map((words) => words.filter((_, i) => !counts(words, i)));
}

const NEGATIONS = textsOf('не ни not вместо instead');
const BETWEEN_NEGATION = textsOf('из с со в во на от у к за по для до через from the of to in at on via through');
const AFTER_NAME = textsOf('bilan uchun orqali ham');
const TAKEN_BACK = textsOf("emas yo'q нет no nope o'rniga вернее точнее adashdim adashibman");
/** These leave a number free. After any other word it is that word's number: "Molxona №1" is no field №1. */
const OWN_NO_NUMBER = new Set([...TAKEN_BACK, ...textsOf('va ham yoki ha да а и bugun kecha сегодня вчера today yesterday')]);
/** A number this long is an id, a TIN or a barcode, and cannot be counting anything. */
const ID_LENGTH = 7;

/** "Shimoliy emas", "не из кассы", "not from Kassa", "Kassadan, yo'q": the words name it only to rule it out. */
function ruledOut(words: Word[], from: number, to: number): boolean {
  let after = to;
  while (AFTER_NAME.has(words[after]?.text)) after += 1;
  if (TAKEN_BACK.has(words[after]?.text)) return true;
  let before = from - 1;
  while (BETWEEN_NEGATION.has(words[before]?.text)) before -= 1;
  return NEGATIONS.has(words[before]?.text);
}

interface Setting {
  field: boolean;
  /** Nothing else was said in the message. */
  alone: boolean;
  /** The word before these is one a number would belong to. */
  owned: boolean;
  /** The word before these describes them: "yangi nasos" may not be the pump on the books. */
  described: boolean;
  person: boolean;
}

/**
 * Whether words side by side point at this name. A number proves it only when it can be nothing else:
 * alone in a message, after a № sign that belongs to no other word, or beside a word of the name.
 * Any other number counts something, so a list of the things people count would never be complete.
 */
function pointsAt(run: Word[], name: Word[], { field, alone, owned, described, person }: Setting): boolean {
  const beside = (word: Word) => [run[run.indexOf(word) - 1], run[run.indexOf(word) + 1]];
  const numbersOther = (word: Word) => word.signed || beside(word).some((next) => next && isGeneric(next));
  const others = run.filter((word) => isNumber(word) && !name.some((part) => part.text === word.text));
  if (others.some((word) => name.some(isNumber) || numbersOther(word))) return false;
  const said = run.filter((word) => !others.includes(word));
  if (!usable(said)) return false;
  if (said.every(isNumber)) return alone || said.some((word) => (word.signed && !owned) || word.text.length >= ID_LENGTH);
  return coverage(said, name, { field, person }) >= (described ? WHOLE_NAME : STRONG);
}

interface Place {
  run: Word[];
  /** The nearest words on either side, past the small ones. */
  beside: Word[];
}

/** Each place in these words that names this name. */
function placesOf(pieces: Word[][], name: Word[], field: boolean, person: boolean): Place[] {
  const alone = pieces.flat().length === 1;
  const inName = (word: Word) => isNumber(word) || (field && isGeneric(word)) || name.some((_, at) => fitAt(word, name, at) > NOT);
  return pieces.flatMap((piece) => {
    const words = spacedAs(piece, name);
    const nearest = (from: number, step: number) => {
      let at = from;
      while (LINKING_WORDS.has(words[at]?.text)) at += step;
      return words[at] ? [words[at]] : [];
    };
    const places: Place[] = [];
    let from = 0;
    for (let to = 0; to <= words.length; to += 1) {
      if (to < words.length && inName(words[to])) continue;
      const before = words[from - 1];
      const run = words.slice(from, to);
      const owned = before !== undefined && !isNumber(before) && !OWN_NO_NUMBER.has(before.text);
      const described = ADJECTIVES.has(before?.text);
      if (pointsAt(run, name, { field, alone, owned, described, person }) && !ruledOut(words, from, to)) {
        places.push({ run, beside: [...nearest(from - 1, -1), ...nearest(to, 1)] });
      }
      from = to + 1;
    }
    return places;
  });
}

function placesNamed(texts: string[], names: string[], field: (name: string) => boolean, person: boolean): Place[] {
  const heard = texts.map(withNumbers).map(heardIn);
  return names
    .filter((name) => !UUID.test(name.trim()))
    .flatMap((name) => readings(name).flatMap((words) => heard.flatMap((pieces) => placesOf(pieces, words, field(name), person))));
}

/**
 * Whether the person's own words really contain one of these names, so a name they said can be told
 * from one the model supplied. Enough of the name to tell it apart will do, or one of its numbers if it
 * can only be a name. The words may still fit other records too: `singledOut` is the check for that.
 */
export function groundedIn(texts: string[], names: string[], { thing = false } = {}): boolean {
  return placesNamed(texts, names, (name) => namesField(name), !thing).length > 0;
}

/**
 * Answering "which one?", a part of the name is enough: "yemga" settles Bug'doy (yem) against Bug'doy urug'i.
 * It has to tell the record from the others, so a word they share proves nothing, nor does a word the person
 * ruled out, and a number that belongs to another record ("2-dala") speaks against it.
 */
export function saysPartOf(text: string, chosen: Candidate, candidates: Candidate[]): boolean {
  const words = wordsOf(text);
  const others = candidates.filter((candidate) => candidate.id !== chosen.id);
  const inName = (word: Word, candidate: Candidate) => wordsOf(candidate.name).some((part) => fits(word, part));
  const inAnother = (word: Word) => others.some((other) => inName(word, other));
  const stands = (at: number) => !ruledOut(words, at, at + 1);
  if (words.some((word, at) => isNumber(word) && stands(at) && inAnother(word) && !inName(word, chosen))) return false;
  return words.some((word, at) => stands(at) && inName(word, chosen) && !inAnother(word));
}

/** Goods only: a word beside the name says it is another kind, as "urug'i" does beside plain Arpa. */
function anotherKindBeside(chosen: Candidate, beside: Word[]): boolean {
  const own = chosen.extra?.category;
  if (typeof own !== 'string') return false;
  const others = Object.entries(ITEM_KINDS).flatMap(([kind, words]) => (kind === own ? [] : words.flatMap(wordsOf)));
  return beside.some((word) => isOneOf(word, others));
}

/**
 * Whether the person's words pick out this record among all the candidates: `groundedIn`, and the
 * words that do it resolve to this record and no other. "MTZ" with two tractors picks neither, so the
 * model cannot settle what the person left open by supplying a full name. `phrase` is what the model passed.
 */
export function singledOut(texts: string[], phrase: string, chosen: Candidate, candidates: Candidate[]): boolean {
  const type = chosen.extra?.type;
  // "Bankdan kassaga": on a farm with one bank account, the word for the kind of account is its name.
  const accountKind = (ACCOUNT_TYPES as readonly unknown[]).includes(type) && candidates.filter((c) => c.extra?.type === type).length === 1;
  if (accountKind && texts.some((text) => (paymentWords(text) as unknown[]).includes(type))) return true;
  const names = [withoutLinks(phrase), chosen.name, ...chosen.names, chosen.key ?? '', chosen.contact ?? ''];
  const person = !chosen.thing;
  const nothingElseFits = (said: Word[]) => {
    const matches = matchesOf(said, candidates, person);
    const hit = settled(matches);
    if (hit) return hit.status === 'found' && hit.candidate.id === chosen.id;
    return matches.every((match) => match.candidate.id === chosen.id);
  };
  const ownNumbers = new Set(names.flatMap(wordsOf).filter(isNumber).map((word) => word.text));
  // With all its numbers "Kassa 2" is another record, and without a stray one "Akmal 500" may fit several.
  // Those words must fit something: a word no record has cannot vouch for the record the model chose.
  return placesNamed(texts, names, (name) => namesField(name, type), person).some(({ run, beside }) => {
    const words = run.filter((word) => !isNumber(word) || ownNumbers.has(word.text));
    return !anotherKindBeside(chosen, beside) && nothingElseFits(run) && nothingElseFits(words) && matchesOf(words, candidates, person).length > 0;
  });
}

const SOURCE_WORDS = textsOf('из с со от from');
const DESTINATION_WORDS = textsOf('в во на к to into');
const ACCOUNT_KIND_WORDS: Record<string, Word[]> = { cash: listOf('kassa naqd'), bank: listOf('bank'), card: listOf('karta') };

/** The way the person's newest words send this account: "Kassadan", "из кассы", "from cash", "Agrobankka", "в банк". */
export function accountSide(texts: string[], account: Candidate): 'from' | 'to' | null {
  const names = [...namesOf(account).flat(), ...(ACCOUNT_KIND_WORDS[String(account.extra?.type)] ?? [])];
  for (const text of [...texts].reverse()) {
    const words = wordsOf(text);
    for (const [at, word] of words.entries()) {
      if (!isOneOf(word, names)) continue;
      const before = words[words[at - 1]?.text === 'the' ? at - 2 : at - 1]?.text;
      if (word.text.endsWith('dan') || SOURCE_WORDS.has(before)) return 'from';
      if (/(?:ga|ka)$/.test(word.text) || DESTINATION_WORDS.has(before)) return 'to';
    }
  }
  return null;
}

/** "3-dala", "третье поле": a place is named here, whether or not the farm has it. */
export function namesAPlace(texts: string[]): boolean {
  const places = PLACE_WORDS.flatMap(wordsOf);
  const beside = (word: Word | undefined) => word !== undefined && isNumber(word);
  return texts.some((text) => {
    const words = wordsOf(withNumbers(text));
    return words.some((word, at) => isOneOf(word, places) && (beside(words[at - 1]) || beside(words[at + 1])));
  });
}

// ─── What can be chosen from ────────────────────────────────────────────────

const goodsOf = (name: string) => {
  const own = wordsOf(name);
  return GOODS.filter((group) => own.some((word) => isOneOf(word, group.flatMap(wordsOf))));
};

/**
 * The other names of an item: Dizel also answers to salyarka, and to "fuel" while nothing else is fuel. A bare
 * translation names the plain item alone, so "ячмень" is Arpa, while Arpa urug'i takes "семена ячменя".
 */
function goodsNames(name: string, category: string, all: { name: string }[]): string[] {
  const own = wordsOf(name);
  const kinds = ITEM_KINDS[category] ?? [];
  const translated = goodsOf(name).flatMap((group) => {
    const words = group.flatMap(wordsOf);
    const others = group.filter((entry) => !wordsOf(entry).some((word) => own.some((part) => fits(part, word))));
    const bare = own.every((word) => isOneOf(word, words)) || all.filter((item) => goodsOf(item.name).includes(group)).length === 1;
    const paired = group.flatMap((word) => kinds.flatMap((kind) => [`${word} ${kind}`, `${kind} ${word}`]));
    return bare ? [...others, ...paired] : paired;
  });
  return [...translated, ...kinds];
}

export async function categoryCandidates(kind: 'expense' | 'income'): Promise<(Candidate & { key: string })[]> {
  const t = schema.financeCategories;
  const rows = await tx()
    .select()
    .from(t)
    .where(and(eq(t.tenantId, ctx().tenantId), eq(t.kind, kind), eq(t.active, true)));
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name.uz,
    names: [row.name.uz, row.name.ru, row.name.en, row.key, row.key.replaceAll('_', ' ')],
  }));
}

export async function accountCandidates(): Promise<Candidate[]> {
  const t = schema.accounts;
  const rows = await tx().select().from(t).where(and(eq(t.farmId, ctx().farmId), eq(t.active, true)));
  return rows.map((row) => ({ id: row.id, name: row.name, names: [row.name, row.bankName ?? ''], extra: { type: row.type, currency: row.currency } }));
}

export async function counterpartyCandidates(): Promise<Candidate[]> {
  const t = schema.counterparties;
  const rows = await tx().select().from(t).where(and(eq(t.farmId, ctx().farmId), eq(t.active, true)));
  // A contact person is personal data: a search must not confirm which supplier someone belongs to.
  const searchable = hasPermission('finance.view') || hasPermission('pii.view');
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    names: [row.name, row.tin ?? ''],
    contact: searchable ? (row.contactPerson ?? undefined) : undefined,
  }));
}

export async function itemCandidates(): Promise<Candidate[]> {
  const t = schema.items;
  const rows = await tx().select().from(t).where(and(eq(t.farmId, ctx().farmId), eq(t.active, true)));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    names: [row.name, row.sku ?? '', row.barcode ?? '', ...goodsNames(row.name, row.category, rows)],
    thing: true,
    extra: { unit: row.unit, category: row.category, defaultWarehouseId: row.defaultWarehouseId },
  }));
}

export async function warehouseCandidates(): Promise<Candidate[]> {
  const t = schema.warehouses;
  const rows = await tx().select().from(t).where(and(eq(t.farmId, ctx().farmId), eq(t.active, true)));
  return rows.map((row) => ({ id: row.id, name: row.name, names: [row.name], extra: { type: row.type } }));
}

/** Cost centers of the given types, with the general one kept apart. A center can outlive what it was for. */
export async function costCenterCandidates(types: string[]): Promise<Candidate[]> {
  const { assets, costCenters: t, fields, herds } = schema;
  const rows = await tx()
    .select({ id: t.id, name: t.name, type: t.type, refId: t.refId, assetType: assets.type })
    .from(t)
    .leftJoin(fields, and(eq(t.type, 'field'), eq(fields.id, t.refId)))
    .leftJoin(herds, and(eq(t.type, 'herd'), eq(herds.id, t.refId)))
    .leftJoin(assets, and(eq(t.type, 'asset'), eq(assets.id, t.refId)))
    .where(
      and(
        eq(t.farmId, ctx().farmId),
        eq(t.active, true),
        inArray(t.type, types),
        sql`${fields.status} is distinct from 'archived'`,
        sql`${herds.status} is distinct from 'archived'`,
        sql`${assets.status} is distinct from 'written_off'`,
      ),
    );
  const kindOf = (row: (typeof rows)[number]) => (row.type === 'herd' ? HERD_WORDS : (MACHINES[row.assetType ?? ''] ?? []));
  return rows.map((row) => ({ id: row.id, name: row.name, names: [row.name, ...kindOf(row)], thing: true, extra: { type: row.type, refId: row.refId } }));
}

export async function generalCenter(): Promise<Candidate | null> {
  return (await costCenterCandidates(['general']))[0] ?? null;
}
