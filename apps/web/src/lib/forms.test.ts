import { describe, expect, it } from 'vitest';
import { zOptionalNumber, zPositive } from './forms';
import i18n from './i18n';

describe('a number field whose text cannot be read', () => {
  it('stops a required field, and says what is wrong', async () => {
    await i18n.changeLanguage('en');
    const result = zPositive().safeParse(Number.NaN);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe("This number can't be read. Write it like 1500000 or 1 500 000.");
  });

  it('stops an optional field too, where null would have saved nothing and said nothing', () => {
    expect(zOptionalNumber().safeParse(Number.NaN).success).toBe(false);
    expect(zOptionalNumber().parse(null)).toBeNull();
    expect(zOptionalNumber().parse(5)).toBe(5);
  });
});
