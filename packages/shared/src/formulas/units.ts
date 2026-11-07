/**
 * Units as people say them. A stock item is kept in one unit, and a quantity in another unit is
 * converted only where the conversion is exact. A bag or a bale has no fixed weight, so "50 qop"
 * of something kept in kg cannot be worked out here: the answer is null, which means ask.
 *
 * This file also holds the one normalisation step that all word evidence goes through, because
 * units are the first thing that needs it.
 */
import { round } from './index';

const LETTERS: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sh', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h',
};

/** Every apostrophe people type, including the ones Uzbek keyboards and phones produce. */
export const APOSTROPHES = "'ʻʼʹ‘’′`´";
const MARKS = new RegExp(`[${APOSTROPHES}\\p{M}]`, 'gu');

/**
 * One spelling for a word however it was typed, so one list covers Uzbek Latin, Uzbek Cyrillic and
 * Russian, typed or transcribed: "to'landi", "tolandi" and "тўланди" are one key, as are "hisobdan",
 * "xisobdan" and "ҳисобдан", and "перечисление" and "perechislenie". Double letters count once,
 * because they are what people drop: "dolar", "kasa", "milion".
 */
export function fold(word: string): string {
  const latin = Array.from(word.normalize('NFC').toLowerCase(), (char) => LETTERS[char] ?? char).join('');
  return latin
    .replace(MARKS, '')
    .replace(/(?<![sc])h/g, 'x')
    .replace(/ye/g, 'e')
    .replace(/(.)\1+/g, '$1');
}

/** Whole-word endings of an Uzbek noun, so a list entry written "kassa*" covers "kassadan" and no more. */
const CASE_ENDINGS = [
  '', 'ga', 'da', 'dan', 'ni', 'ning', 'lik', 'li', 'lar', 'lari', 'larga', 'lardan', 'larni', 'larning',
  'si', 'siga', 'sidan', 'sini', 'sida', 'i', 'iga', 'idan', 'ini', 'ida', 'imiz', 'imizga', 'imizdan',
  'imizni', 'im', 'imga', 'imdan', 'imni', 'gacha', 'cha', 'dagi',
];

/**
 * The keys one word can arrive as. A Russian keyboard has neither ў nor қ, so "тулади" is "тўлади" and
 * "карз" is "қарз". Doing this in the list and not in fold keeps "ko'p" (many) apart from "qop" (a bag).
 */
function spellings(word: string): string[] {
  const plain = [fold(word), fold(word.replace(/o'/g, 'u'))];
  return [...new Set(plain.flatMap((key) => [key, key.replace(/q/g, 'k')]))];
}

function forms(word: string): Set<string> {
  if (!word.endsWith('*')) return new Set(spellings(word));
  const stem = word.slice(0, -1);
  return new Set(CASE_ENDINGS.flatMap((ending) => spellings(stem + ending)));
}

/** One list entry: consecutive words, each given as the keys it may arrive as. */
export type Phrase = Set<string>[];

/**
 * A named word list, written in natural spelling and separated by commas. An entry may be several
 * words ("со счёта"), and a final * adds the Uzbek case endings to its last word.
 */
export function wordList(source: string): Phrase[] {
  return source
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(/\s+/).map(forms));
}

/** The same for lists of single words, as a plain set of keys. */
export function wordSet(source: string): Set<string> {
  return new Set(wordList(source).flatMap(([keys]) => [...keys]));
}

/** Whether these keys, in this order, hold an entry of the list. */
export const hasPhrase = (keys: string[], list: Phrase[]) =>
  keys.some((_, at) => list.some((phrase) => phrase.every((options, i) => options.has(keys[at + i] ?? ''))));

const WORDS = {
  g: 'g, gr, gramm*, gram*, грамм, грамма, граммов, граммы',
  kg: 'kg*, kilo*, kilogramm*, kilogram*, кг, кило, килограмм, килограмма, килограммов, килограммы, kilos, kilogram, kilograms',
  sentner: 'sentner*, centner, centners, tsentner*, центнер, центнера, центнеров, центнеры, ц',
  t: 't, tn, tonna*, tonn, tonne, tonnes, ton, tons, тонн, тонны, тонну, тонне, тоннах, тоннами',
  ml: 'ml, millilitr*, миллилитр, миллилитра, миллилитров',
  l: 'l, lt, ltr, litr*, litre, liter, litres, liters, литр, литра, литров, литры, литрах',
  dose: 'dose, doses, doza*, доза, дозы, доз, дозу',
  vial: 'vial, vials, flakon*, флакон, флакона, флаконов, флаконы',
  bale: 'bale, bales, toy, тюк, тюка, тюков, тюки',
  pcs: 'pcs, pc, piece, pieces, dona*, ta*, шт, штук, штука, штуки, штуку',
  head: 'head, heads, bosh*, голова, головы, голов, голову',
} as const;

export type UnitWord = keyof typeof WORDS;

const LOOKUP = new Map<string, UnitWord>(
  (Object.entries(WORDS) as [UnitWord, string][]).flatMap(([unit, source]) =>
    [...wordSet(source)].map((key) => [key, unit] as const),
  ),
);

/** How many of the smallest unit each one holds, within a family that converts exactly. */
const FAMILIES: Partial<Record<UnitWord, number>>[] = [
  { g: 1, kg: 1_000, sentner: 100_000, t: 1_000_000 },
  { ml: 1, l: 1_000 },
  { pcs: 1, head: 1 },
];

const clean = (word: string) => fold(word.trim().replace(/\.$/, ''));

/** The unit a word means, or null if it is not one we know. */
export function unitOf(word: string): UnitWord | null {
  return LOOKUP.get(clean(word)) ?? null;
}

/** A quantity in the item's own unit, or null when that cannot be known exactly. */
export function convertQty(qty: number, from: string, to: string): number | null {
  if (clean(from) !== '' && clean(from) === clean(to)) return qty;
  const a = unitOf(from);
  const b = unitOf(to);
  if (!a || !b) return null;
  if (a === b) return qty;
  const family = FAMILIES.find((f) => f[a] !== undefined && f[b] !== undefined);
  if (!family) return null;
  // Rounded, because 4.1 t is 4099.999999999999 kg in floating point and the caller compares for equality.
  return round((qty * family[a]!) / family[b]!, 9);
}

/** Total for a quantity at a unit price, converting between the two units first. Null if they do not convert. */
export function lineTotal(qty: number, qtyUnit: string, price: number, priceUnit: string): number | null {
  const inPriceUnit = convertQty(qty, qtyUnit, priceUnit);
  return inPriceUnit === null ? null : round(inPriceUnit * price, 2);
}
