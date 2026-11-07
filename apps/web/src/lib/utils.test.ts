import { describe, expect, it } from 'vitest';
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
