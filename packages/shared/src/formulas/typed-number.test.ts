import { describe, expect, it } from 'vitest';
import { parseMoneyMentions } from './money-text';
import { readTypedNumber, type TypedNumberRules } from './typed-number';

const MONEY: TypedNumberRules = { money: true, decimals: 2 };
/** An exchange rate: money, with decimals of its own. */
const RATE: TypedNumberRules = { money: true, decimals: 4 };
const WHOLE: TypedNumberRules = { decimals: 0 };
const QUANTITY: TypedNumberRules = { decimals: 3 };
const WEIGHT: TypedNumberRules = { decimals: 2 };

const value = (text: string, rules?: TypedNumberRules) => readTypedNumber(text, rules).value;

describe('a money field', () => {
  it.each<[string, number]>([
    ['1500000', 1_500_000],
    ['1 500 000', 1_500_000],
    ['1 500 000', 1_500_000],
    ['1 500 000', 1_500_000],
    ['1.500.000', 1_500_000],
    ['1,500,000', 1_500_000],
    ['150.000.000', 150_000_000],
    ['25.000', 25_000],
    ['25,000', 25_000],
    ['1.125', 1_125],
    ['1.500.000,50', 1_500_000.5],
    ['1,500,000.50', 1_500_000.5],
    ['1.500,50', 1_500.5],
    ['1,500.50', 1_500.5],
    ['1 500 000,50', 1_500_000.5],
    ['25.5', 25.5],
    ['25,50', 25.5],
    ['25.00', 25],
    ['0.500', 0.5],
    ['.5', 0.5],
  ])('%s is %d', (text, expected) => {
    expect(readTypedNumber(text, MONEY)).toEqual({ value: expected, unreadable: false, otherReading: null });
  });
});

describe('a whole count', () => {
  it.each<[string, number]>([
    ['1.500', 1_500],
    ['1,500', 1_500],
    ['1.500.000', 1_500_000],
    ['45', 45],
  ])('%s is %d', (text, expected) => {
    expect(readTypedNumber(text, WHOLE)).toEqual({ value: expected, unreadable: false, otherReading: null });
  });
});

describe('a quantity that keeps decimals', () => {
  it.each<[string, TypedNumberRules, number, number]>([
    ['1.125', QUANTITY, 1.125, 1_125],
    ['1,125', QUANTITY, 1.125, 1_125],
    ['25.000', QUANTITY, 25, 25_000],
    ['25,000', QUANTITY, 25, 25_000],
    // A scale that shows grams: nothing about two kept decimals makes this forty-five thousand kilos.
    ['45.250', WEIGHT, 45.25, 45_250],
  ])('%s does not guess: it reads the decimal and names the other reading', (text, rules, expected, other) => {
    expect(readTypedNumber(text, rules)).toEqual({ value: expected, unreadable: false, otherReading: other });
  });

  it.each<[string, number]>([
    ['1,5', 1.5],
    ['1.5', 1.5],
    ['1.25', 1.25],
    ['1.2345', 1.2345],
    ['0.125', 0.125],
    ['1500.125', 1500.125],
    ['1.500.000', 1_500_000],
    ['1,500,000', 1_500_000],
    ['1.500,25', 1_500.25],
    ['2 100 000', 2_100_000],
    ['2 100 000', 2_100_000],
    ['0', 0],
    ['5.', 5],
    ['5,', 5],
  ])('%s has one reading', (text, expected) => {
    expect(readTypedNumber(text, QUANTITY)).toEqual({ value: expected, unreadable: false, otherReading: null });
  });
});

describe('an exchange rate', () => {
  it('reads 12.700 as twelve thousand, and keeps its own decimals', () => {
    expect(value('12.700', RATE)).toBe(12_700);
    expect(value('12 700,25', RATE)).toBe(12_700.25);
    expect(value('12700.125', RATE)).toBe(12_700.125);
    expect(value('1.2345', RATE)).toBe(1.2345);
  });
});

describe('text that is not a number', () => {
  it.each(['1.500.00', '1.50.000', '1.5.5', '12,34,567', '1.500,000.5', '1,5,5', '1.500.', 'abc', '5 mln', '5k', '1e5', '$5', "1'500", '1-2', '+5', '٥'])(
    '%s is refused, in every kind of field',
    (text) => {
      for (const rules of [MONEY, RATE, WHOLE, QUANTITY, WEIGHT]) {
        expect(readTypedNumber(text, rules)).toEqual({ value: null, unreadable: true, otherReading: null });
      }
    },
  );

  it('1500.000 in money is neither proper groups nor a possible decimal', () => {
    expect(readTypedNumber('1500.000', MONEY).unreadable).toBe(true);
    expect(readTypedNumber('1500.000', WHOLE).unreadable).toBe(true);
    expect(value('1500.000', QUANTITY)).toBe(1500);
  });

  it('a sign is refused unless the field takes one', () => {
    expect(readTypedNumber('-5').unreadable).toBe(true);
    expect(value('-5', { negative: true })).toBe(-5);
    expect(value('-3,5', { negative: true })).toBe(-3.5);
    expect(value('-1.500.000', { negative: true, money: true })).toBe(-1_500_000);
  });
});

describe('nothing typed yet', () => {
  it.each(['', '   ', '.', ',', '-'])('%j is empty, and not an error', (text) => {
    expect(readTypedNumber(text, { negative: true })).toEqual({ value: null, unreadable: false, otherReading: null });
  });
});

describe('the form and the chat', () => {
  it.each(['1.500.000', '1,500,000', '150.000.000', '25.000', '25,000', '1 500 000', '1.500,50', '1,500.50', '1 500 000,50', '1,5', '2.5'])(
    '%s reads the same in a money field and in a message',
    (text) => {
      const [mention] = parseMoneyMentions(`${text} so'm`);
      expect(value(text, MONEY)).toBe(mention.amount);
    },
  );
});
