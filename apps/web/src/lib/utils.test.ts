import { describe, expect, it } from 'vitest';
import { parseNumber } from '@/components/ui/number-input';
import { normalizePhone } from './utils';

describe('normalizePhone', () => {
  it.each([
    ['+998 90 123 45 67', '+998901234567'],
    ['998901234567', '+998901234567'],
    ['90 123-45-67', '+998901234567'],
    ['(90) 123 45 67', '+998901234567'],
    ['901234567', '+998901234567'],
    ['+7 916 000 00 00', '+79160000000'],
  ])('%s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
});

describe('parseNumber', () => {
  it.each<[string, number | null]>([
    ['1500', 1500],
    ['1,5', 1.5],
    ['1.5', 1.5],
    ['2 100 000', 2_100_000],
    ['2 100 000', 2_100_000],
    ['0', 0],
    ['', null],
    ['-', null],
    ['.', null],
    ['abc', null],
    ['-3,5', -3.5],
  ])('%j', (input, expected) => {
    expect(parseNumber(input)).toBe(expected);
  });
});
