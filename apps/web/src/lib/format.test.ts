import { afterAll, describe, expect, it } from 'vitest';
import { formatAgo, formatCompact, formatDate, formatDateLong, formatDateTime, formatMoney, formatMonth, formatMonthShort, formatNumber, formatPercent, formatQty } from './format';
import i18n from './i18n';

// Group separators are non-breaking spaces in these locales.
const plain = (s: string) => s.replace(/[  ]/g, ' ');

describe('format, in Russian (stable separators across ICU versions)', () => {
  afterAll(() => {
    void i18n.changeLanguage('uz');
  });

  it('renders every missing value as a dash, never 0', async () => {
    await i18n.changeLanguage('ru');
    for (const fn of [formatNumber, formatMoney, formatPercent, formatCompact]) {
      expect(fn(null)).toBe('—');
      expect(fn(undefined)).toBe('—');
      expect(fn('')).toBe('—');
      expect(fn('not a number')).toBe('—');
    }
    expect(formatQty(null, 'kg')).toBe('—');
    expect(formatDate(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatDate('garbage')).toBe('—');
    expect(formatMonth(null)).toBe('—');
  });

  it('keeps a real zero', async () => {
    await i18n.changeLanguage('ru');
    expect(formatNumber(0)).toBe('0');
    expect(plain(formatMoney(0))).toBe('0 сум');
    expect(formatPercent(0)).toMatch(/^0/);
  });

  it('formats money with the translated currency', async () => {
    await i18n.changeLanguage('ru');
    expect(plain(formatMoney(2_100_000_000))).toBe('2 100 000 000 сум');
    expect(plain(formatMoney('1500'))).toBe('1 500 сум');
    expect(plain(formatMoney(12.5, { currency: 'USD' }))).toBe('12,50 $');
    expect(plain(formatMoney(1500, { plain: true }))).toBe('1 500');
  });

  it('formats quantities with the unit label', async () => {
    await i18n.changeLanguage('ru');
    expect(plain(formatQty(1200, 'kg'))).toBe('1 200 кг');
    expect(plain(formatQty(1.2345, 't'))).toBe('1,235 т');
    expect(formatQty(5)).toBe('5');
  });

  it('keeps a number on the same line as its unit or currency', async () => {
    for (const lang of ['uz', 'uz-Cyrl', 'ru', 'en']) {
      await i18n.changeLanguage(lang);
      // A no-break space joins them, so a narrow cell never shows "56,3 mln" over "so'm".
      expect(formatMoney(56_300_000, { compact: true })).toMatch(/^[^ ]+$/);
      expect(formatMoney(645_800)).toMatch(/^[^ ]+$/);
      expect(formatQty(210, 'kg')).toMatch(/^[^ ]+$/);
      expect(formatQty(700, 'dose')).toMatch(/^[^ ]+$/);
      expect(formatCompact(15_400_000)).toMatch(/^[^ ]+$/);
    }
    await i18n.changeLanguage('ru');
    expect(formatQty(210, 'kg')).toBe('210\u00a0кг');
    expect(formatMoney(15_400_000, { compact: true })).toBe('15,4\u00a0млн\u00a0сум');
  });

  it('treats percentages as already scaled', async () => {
    await i18n.changeLanguage('ru');
    expect(plain(formatPercent(124))).toBe('124 %');
    expect(plain(formatPercent(12.34))).toBe('12,3 %');
  });

  it('reads a plain date as a calendar date, not UTC midnight', async () => {
    await i18n.changeLanguage('ru');
    expect(formatDate('2026-11-04')).toBe('04.11.2026');
    expect(formatDate('2027-01-01')).toBe('01.01.2027');
  });

  it('shows timestamps in farm time', async () => {
    await i18n.changeLanguage('ru');
    // 20:30 UTC is 01:30 the next day in Tashkent.
    expect(plain(formatDateTime('2026-11-04T20:30:00Z'))).toBe('05.11.2026, 01:30');
    expect(formatDate('2026-11-04T20:30:00Z')).toBe('05.11.2026');
  });
});

describe('format, in Uzbek (browsers ship almost no `uz` data, so nothing may rely on it)', () => {
  afterAll(() => {
    void i18n.changeLanguage('uz');
  });

  it('groups digits and uses a decimal comma', async () => {
    await i18n.changeLanguage('uz');
    expect(plain(formatNumber(2100000.5))).toBe('2 100 000,5');
    expect(plain(formatMoney(2_100_000_000))).toBe("2 100 000 000 so'm");
    expect(plain(formatQty(1200, 'head'))).toBe('1 200 bosh');
  });

  it('writes compact numbers in Uzbek, never "2.1G"', async () => {
    await i18n.changeLanguage('uz');
    expect(plain(formatCompact(2_100_000_000))).toBe('2,1 mlrd');
    expect(plain(formatCompact(185_000_000))).toBe('185 mln');
    expect(plain(formatCompact(12_900))).toBe('12,9 ming');
    expect(formatCompact(950)).toBe('950');
    expect(plain(formatCompact(-2_500_000))).toBe('-2,5 mln');
    expect(plain(formatMoney(2_100_000_000, { compact: true }))).toBe("2,1 mlrd so'm");
  });

  it('names months from the dictionary, never "M11"', async () => {
    await i18n.changeLanguage('uz');
    expect(formatMonth('2026-11')).toBe('Noyabr 2026');
    expect(formatMonth('2026-11-04')).toBe('Noyabr 2026');
    expect(formatMonthShort('2026-11')).toBe('Noy');
    expect(formatMonthShort('2026-11', true)).toBe('Noy 2026');
    expect(formatDateLong('2026-11-04')).toBe('4 noyabr 2026');
    expect(formatDate('2026-11-04')).toBe('04.11.2026');
  });

  it('derives the same in Cyrillic', async () => {
    await i18n.changeLanguage('uz-Cyrl');
    expect(formatMonth('2026-11')).toBe('Ноябрь 2026');
    expect(plain(formatCompact(2_100_000_000))).toBe('2,1 млрд');
    expect(plain(formatMoney(1500))).toBe('1 500 сўм');
  });

  it('uses Russian grammar for dates in Russian', async () => {
    await i18n.changeLanguage('ru');
    expect(formatDateLong('2026-11-04')).toBe('4 ноября 2026');
    expect(formatMonth('2026-11')).toBe('Ноябрь 2026');
  });

  it("says how long ago in the reader's own words, and gives the date after a week", async () => {
    const now = Date.parse('2026-11-08T10:00:00Z');
    const back = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    await i18n.changeLanguage('uz');
    expect(formatAgo(back(0), now)).toBe('hozirgina');
    expect(formatAgo(back(5), now)).toBe('5 daq. oldin');
    expect(formatAgo(back(150), now)).toBe('2 soat oldin');
    expect(formatAgo(back(3 * 24 * 60), now)).toBe('3 kun oldin');
    expect(formatAgo(back(8 * 24 * 60), now)).toBe('31.10.2026, 15:00');
    expect(formatAgo(null, now)).toBe('—');
    await i18n.changeLanguage('ru');
    expect(formatAgo(back(5), now)).toBe('5 мин назад');
  });

  it('reads a timestamp in farm time for the long form', async () => {
    await i18n.changeLanguage('en');
    expect(formatDateLong('2026-12-31T20:30:00Z')).toBe('1 January 2027');
    expect(formatCompact(2_100_000_000)).toBe('2.1B');
  });
});
