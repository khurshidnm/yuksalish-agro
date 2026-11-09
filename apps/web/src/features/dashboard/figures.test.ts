import { afterAll, describe, expect, it } from 'vitest';
import i18n from '@/lib/i18n';
import { consumptionToChart, expectedLambsText, feedNotInUse, monthInText, signedKg, weightDomain } from './figures';
import type { FeedItem, LivestockData } from './types';

afterAll(async () => {
  await i18n.changeLanguage('uz');
});

const lambing = (over: Partial<LivestockData['lambing']>): LivestockData['lambing'] => ({
  weeks: [],
  totalEwes: 700,
  overdue: 0,
  expectedLambs: null,
  next7Days: 0,
  nextDate: '2027-02-07',
  ...over,
});

const feedItem = (over: Partial<FeedItem>): FeedItem => ({
  itemId: 'wheat',
  name: "Bug'doy (yem)",
  unit: 'kg',
  stockQty: 29_200,
  plannedDaily: null,
  actualDaily: null,
  days: null,
  basis: null,
  minDays: 14,
  belowMinimum: false,
  ...over,
});

describe('monthInText', () => {
  it('writes the month in lower case inside an Uzbek or Russian sentence, with a capital in English', async () => {
    await i18n.changeLanguage('uz');
    expect(monthInText('2027-03')).toBe('mart 2027');
    expect(monthInText('2027-06-01', false)).toBe('iyun');
    await i18n.changeLanguage('uz-Cyrl');
    expect(monthInText('2027-03')).toBe('март 2027');
    await i18n.changeLanguage('ru');
    expect(monthInText('2027-03')).toBe('март 2027');
    expect(monthInText('2027-06', false)).toBe('июнь');
    await i18n.changeLanguage('en');
    expect(monthInText('2027-03')).toBe('March 2027');
  });
});

describe('expectedLambsText', () => {
  it("uses the farm's own lambing record once it has one", async () => {
    await i18n.changeLanguage('uz');
    const t = i18n.getFixedT('uz', 'dashboard');
    expect(expectedLambsText(lambing({ expectedLambs: 840, assumedLambs: 770, assumedLambsPerEwe: 1.1 }), t)).toBe('840');
  });

  it('gives the assumed figure, labelled as an assumption, while there is no record yet', async () => {
    await i18n.changeLanguage('uz');
    expect(expectedLambsText(lambing({ assumedLambs: 770, assumedLambsPerEwe: 1.1 }), i18n.getFixedT('uz', 'dashboard'))).toBe(
      "taxminan 770 (faraz: 1,1 qo'zi/sovliq)",
    );
    await i18n.changeLanguage('ru');
    expect(expectedLambsText(lambing({ assumedLambs: 770, assumedLambsPerEwe: 1.1 }), i18n.getFixedT('ru', 'dashboard'))).toBe(
      'около 770 (допущение: 1,1 ягнёнка на матку)',
    );
  });

  it('says the figure is not known yet when there is neither a record nor an assumption', async () => {
    await i18n.changeLanguage('uz');
    const t = i18n.getFixedT('uz', 'dashboard');
    expect(expectedLambsText(lambing({ assumedLambs: null, assumedLambsPerEwe: 1.1 }), t)).toBe("birinchi qo'zilashdan keyin ma'lum bo'ladi");
    // An API without the assumption fields keeps the old wording.
    expect(expectedLambsText(lambing({}), t)).toBe("birinchi qo'zilashdan keyin ma'lum bo'ladi");
  });
});

describe('consumptionToChart', () => {
  const days = [
    { date: '2026-11-07', qty: 2132 },
    { date: '2026-11-08', qty: 0 },
    { date: '2026-11-09', qty: 0 },
  ];

  it("leaves out today while nothing is logged for it, as the average does", () => {
    expect(consumptionToChart(days, '2026-11-09').map((d) => d.date)).toEqual(['2026-11-07', '2026-11-08']);
  });

  it('keeps today once something was issued, and keeps an empty earlier day, which is a real zero', () => {
    const fed = [...days.slice(0, 2), { date: '2026-11-09', qty: 350 }];
    expect(consumptionToChart(fed, '2026-11-09')).toEqual(fed);
    expect(consumptionToChart(days.slice(0, 2), '2026-11-09')).toEqual(days.slice(0, 2));
    expect(consumptionToChart([], '2026-11-09')).toEqual([]);
  });
});

describe('feedNotInUse', () => {
  it('tells feed nobody plans or issues apart from feed whose figures are missing', () => {
    expect(feedNotInUse(feedItem({}))).toBe(true);
    expect(feedNotInUse(feedItem({ plannedDaily: 8.4 }))).toBe(false);
    expect(feedNotInUse(feedItem({ actualDaily: 2 }))).toBe(false);
    expect(feedNotInUse(feedItem({ days: 176.2, actualDaily: 8.4, basis: 'actual' }))).toBe(false);
  });
});

describe('weight chart', () => {
  it('fits the axis around the weights, so a gain of 2,3 kg is not flat on a 0 to 80 axis', () => {
    expect(weightDomain([70.84, 73.17])).toEqual([65, 80]);
    expect(weightDomain([3.2, 4.1])).toEqual([0, 10]);
    expect(weightDomain([])).toBeUndefined();
  });

  it('writes the change with its sign', async () => {
    await i18n.changeLanguage('uz');
    // The unit stays on the number's line: formatQty joins them with a no-break space.
    expect(signedKg(73.17 - 70.84)).toBe('+2,3\u00a0kg');
    expect(signedKg(-1.5)).toBe('−1,5\u00a0kg');
    expect(signedKg(0.04)).toBe('0\u00a0kg');
  });
});
