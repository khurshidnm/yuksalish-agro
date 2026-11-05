import { describe, expect, it } from 'vitest';
import { convertQty, fold, lineTotal, unitOf, wordSet } from './units';

describe('units', () => {
  it.each([
    ['litr', 'l'], ['Литр', 'l'], ['л', 'l'], ['liters', 'l'], ['l.', 'l'],
    ['tonna', 't'], ['тонн', 't'], ['tonnes', 't'], ['т', 't'],
    ['kg', 'kg'], ['КГ', 'kg'], ['kilo', 'kg'],
    ['doza', 'dose'], ['доз', 'dose'], ['flakon', 'vial'], ['шт', 'pcs'], ['dona', 'pcs'], ['bosh', 'head'],
    ['sentner', 'sentner'], ['центнер', 'sentner'],
  ])('%s means %s', (word, unit) => {
    expect(unitOf(word)).toBe(unit);
  });

  it('does not recognise a word that is not a unit', () => {
    expect(unitOf('qop')).toBeNull();
    expect(unitOf('мешок')).toBeNull();
    expect(unitOf('')).toBeNull();
  });

  // Control numbers worked by hand: 1 t = 10 sentner = 1000 kg, 1 l = 1000 ml.
  it.each([
    [2, 't', 'kg', 2000],
    [3.5, 'tonna', 'kg', 3500],
    [250, 'kg', 't', 0.25],
    [12, 'sentner', 'kg', 1200],
    [12, 'центнер', 't', 1.2],
    [500, 'g', 'kg', 0.5],
    [500, 'litr', 'l', 500],
    [250, 'ml', 'l', 0.25],
    [20, 'flakon', 'vial', 20],
    [500, 'doza', 'dose', 500],
  ])('%d %s is %d %s', (qty, from, to, expected) => {
    expect(convertQty(qty, from, to as string)).toBe(expected);
  });

  it('a conversion that would be a guess is refused', () => {
    expect(convertQty(50, 'qop', 'kg')).toBeNull();
    expect(convertQty(10, 'bale', 'kg')).toBeNull();
    expect(convertQty(100, 'l', 'kg')).toBeNull();
    expect(convertQty(5, 'dose', 'vial')).toBeNull();
    expect(convertQty(5, 'pcs', 'kg')).toBeNull();
  });
});

describe('convertQty is exact, because callers compare with ===', () => {
  // Control numbers worked by hand: 4.1 t = 4100 kg, and plain floating point gives 4099.999999999999.
  it.each<[number, string, string, number]>([
    [4.1, 't', 'kg', 4_100], [8.2, 't', 'kg', 8_200], [1.1, 't', 'kg', 1_100], [2.3, 't', 'kg', 2_300], [4.35, 't', 'kg', 4_350], [0.07, 't', 'kg', 70], [3.3, 'sentner', 'kg', 330], [1.15, 'tonna', 'kilo', 1_150],
    [4_100, 'kg', 't', 4.1], [330, 'kg', 'sentner', 3.3], [0.7, 'l', 'ml', 700], [1.1, 'kg', 'g', 1_100], [1, 'g', 't', 0.000001], [1.5, 'g', 't', 0.0000015],
  ])('%d %s in %s', (qty, from, to, exact) => {
    expect(convertQty(qty, from, to)).toBe(exact);
  });

  it('the price of an exact conversion stays exact', () => {
    expect(lineTotal(4.1, 't', 3_000, 'kg')).toBe(12_300_000);
    expect(lineTotal(2.3, 't', 2_000_000, 't')).toBe(4_600_000);
  });
});

describe('units with endings', () => {
  it.each([
    ['tonnaga', 't'], ['tonnadan', 't'], ['tonnasi', 't'], ['tonnasiga', 't'], ['тоннага', 't'], ['litrdan', 'l'], ['litrga', 'l'], ['litri', 'l'], ['litriga', 'l'], ['литрга', 'l'], ['kilosi', 'kg'], ['kiloga', 'kg'], ['кг', 'kg'],
    ['boshiga', 'head'], ['boshga', 'head'], ['flakondan', 'vial'], ['flakoni', 'vial'], ['dozasi', 'dose'], ['donasi', 'pcs'], ['ta', 'pcs'], ['та', 'pcs'], ['tonnalar', 't'],
  ])('%s means %s', (word, unit) => {
    expect(unitOf(word)).toBe(unit);
  });

  it.each([['boshqa'], ['boshliq'], ['kunjara'], ["ta'mir"], ['tonik'], ['litsenziya'], ['motor'], ['штраф'], ['грузчик'], ["ko'p"]])('%s is not a unit', (word) => {
    expect(unitOf(word)).toBeNull();
  });
});

describe('fold', () => {
  it.each([
    ["to'landi", 'tolandi'], ['тўланди', 'tolandi'], ['to‘landi', 'tolandi'], ['toʻlandi', 'tolandi'], ['to`landi', 'tolandi'], ['hisobdan', 'xisobdan'], ['ҳисобдан', 'xisobdan'], ['хисобдан', 'xisobdan'], ['ЁҚИЛҒИ', 'yoqilgi'], ["yoqilg'i", 'yoqilgi'],
    ['перечисление', 'perechislenie'], ['ПЕРЕЧИСЛЕНИЕ', 'perechislenie'], ['perechisleniye', 'perechislenie'], ['yetti', 'eti'], ['етти', 'eti'], ['эллик', 'elik'], ['ellik', 'elik'], ['доллар', 'dolar'], ['dollar', 'dolar'], ['миллион', 'milion'], ['million', 'milion'],
    ['шесть', 'shest'], ['cash', 'cash'], ['chek', 'chek'],
  ])('%s is %s', (word, key) => {
    expect(fold(word)).toBe(key);
  });

  it('joins a letter typed as two code points', () => {
    expect(fold('йил')).toBe(fold('йил'));
  });
});

describe('word lists', () => {
  it('cover the Russian keyboard, which has neither қ nor ў', () => {
    expect(wordSet("qarz").has(fold('карз'))).toBe(true);
    expect(wordSet("to'ladi").has(fold('тулади'))).toBe(true);
    expect(wordSet("to'ladi").has(fold('toladi'))).toBe(true);
  });

  it('add case endings only where asked', () => {
    expect(wordSet('kassa*').has(fold('kassadan'))).toBe(true);
    expect(wordSet('kassa').has(fold('kassadan'))).toBe(false);
    expect(wordSet("so'm*").has(fold('somon'))).toBe(false);
    expect(wordSet("so'm*").has(fold('sumka'))).toBe(false);
  });
});

describe('convertQty between counted units', () => {
  it('a count of things is the same count in any counted unit', () => {
    expect(convertQty(10, 'ta', 'head')).toBe(10);
    expect(convertQty(10, 'bosh', 'pcs')).toBe(10);
  });

  it('a word that is not a unit still equals itself', () => {
    expect(convertQty(50, 'qop', 'qop')).toBe(50);
    expect(convertQty(50, 'QOP', 'қоп')).toBe(50);
    expect(convertQty(50, '', '')).toBeNull();
  });
});

describe('lineTotal', () => {
  // Control numbers worked by hand.
  it.each<[number, string, number, string, number]>([
    [4, 't', 2_000_000, 't', 8_000_000],
    [4, 'tonna', 2_000_000, 't', 8_000_000],
    [500, 'kg', 3_000, 'kg', 1_500_000],
    [2, 't', 3_000, 'kg', 6_000_000],
    [2, 'тонны', 3_000, 'кило', 6_000_000],
    [10, 'tonna', 3_000, 'kg', 30_000_000],
    [500, 'kg', 2_000_000, 't', 1_000_000],
    [250, 'kg', 2_000_000, 't', 500_000],
    [300, 'litr', 15_000, 'l', 4_500_000],
    [500, 'ml', 40_000, 'l', 20_000],
    [33.3, 'litr', 14_750, 'l', 491_175],
    [10, 'ta', 2_000_000, 'head', 20_000_000],
    [12, 'sentner', 2_000_000, 't', 2_400_000],
    [20, 'flakon', 45_000, 'vial', 900_000],
    [50, 'qop', 40_000, 'qop', 2_000_000],
  ])('%d %s at %d per %s is %d', (qty, qtyUnit, price, priceUnit, total) => {
    expect(lineTotal(qty, qtyUnit, price, priceUnit)).toBe(total);
  });

  it('rounds to two decimals', () => {
    expect(lineTotal(0.1, 'l', 0.2, 'l')).toBe(0.02);
    expect(lineTotal(1, 'kg', 1.005, 'kg')).toBe(1.01);
    expect(lineTotal(333, 'g', 1000, 'kg')).toBe(333);
    expect(lineTotal(1, 'g', 1, 'kg')).toBe(0);
  });

  it('is null when the units do not convert', () => {
    expect(lineTotal(2, 't', 40_000, 'bag')).toBeNull();
    expect(lineTotal(50, 'qop', 3_000, 'kg')).toBeNull();
    expect(lineTotal(100, 'l', 3_000, 'kg')).toBeNull();
    expect(lineTotal(5, 'dose', 3_000, 'vial')).toBeNull();
    expect(lineTotal(5, 'pcs', 3_000, 'kg')).toBeNull();
    expect(lineTotal(5, 't', 3_000, 'unit')).toBeNull();
  });
});
