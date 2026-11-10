import { describe, expect, it } from 'vitest';
import { OUTLOOK_ASSUMPTIONS, lambCohort, lambsForSale } from './outlook';
import { SCENARIO_MONTHS, runScenario, scenarioMonthAt, type ScenarioAssumptions } from './scenario';

/**
 * A flock small enough to work by hand. The plan starts in January 2027, so month 0 is January,
 * lambing (March) is months 2, 14 and 26, and lambs sold at six months leave in months 8, 20, 32.
 * Stall feed: January to March and November, December. No ewe dies or is culled.
 */
const tiny: ScenarioAssumptions = {
  startMonth: '2027-01',
  openingEwes: 100,
  openingRams: 2,
  openingReplacements: 0,
  openingLambs: 0,
  lambingMonth: 3,
  lambingShare: 0.9,
  lambsPerEweLambing: 1.2,
  lambSurvival: 0.9,
  eweDeathsPerYear: 0,
  eweCullsPerYear: 0,
  replacementShare: 0.4,
  firstLambingAgeMonths: 24,
  saleAgeMonths: 6,
  saleWeightKg: 40,
  pricePerKg: 50,
  cullEwePrice: 1000,
  feedAdultStallPerMonth: 30,
  feedAdultGrazingPerMonth: 10,
  stallMonths: [11, 12, 1, 2, 3],
  feedLambPerMonth: 8,
  otherCostPerHeadPerMonth: 2,
  fixedCostPerMonth: 1000,
  oneOffs: [{ month: 0, amount: 5000 }],
  openingCash: 20000,
};

describe('scenarioMonthAt', () => {
  it('counts months across a year end', () => {
    expect(scenarioMonthAt('2026-11', 0)).toBe('2026-11');
    expect(scenarioMonthAt('2026-11', 2)).toBe('2027-01');
    expect(scenarioMonthAt('2026-11', 35)).toBe('2029-10');
  });
});

describe('lambCohort', () => {
  it('splits a lamb crop the way the outlook does', () => {
    // 770 born × 0.92 alive = 708.4; a fifth kept = 141.68; the rest for sale = 566.72
    const cohort = lambCohort(770, OUTLOOK_ASSUMPTIONS);
    expect(cohort.weaned).toBeCloseTo(708.4, 6);
    expect(cohort.kept).toBeCloseTo(141.68, 6);
    expect(cohort.forSale).toBeCloseTo(lambsForSale(700), 6);
  });
});

describe('runScenario, a flock of 100 ewes worked by hand', () => {
  const result = runScenario(tiny);
  const at = (index: number) => result.months[index];
  const [y1, y2, y3] = result.years;

  it('covers 36 months from the start month', () => {
    expect(result.months).toHaveLength(SCENARIO_MONTHS);
    expect(at(0).month).toBe('2027-01');
    expect(at(35).month).toBe('2029-12');
    expect(result.missing).toEqual([]);
  });

  it('lambs in March: born, weaned, kept and held for sale', () => {
    // 100 ewes × 0.9 lamb = 90; × 1.2 = 108 born
    expect(at(2).lambsBorn).toBeCloseTo(108, 9);
    // 108 × 0.9 alive = 97.2 weaned. Ewe lambs are half, 0.4 of them kept: 97.2 × 0.5 × 0.4 = 19.44
    expect(at(2).herd.replacements).toBeCloseTo(19.44, 9);
    // the rest, 97.2 − 19.44 = 77.76, are held for sale
    expect(at(2).herd.lambs).toBeCloseTo(77.76, 9);
    // 100 + 2 + 19.44 + 77.76
    expect(at(2).herd.total).toBeCloseTo(199.2, 9);
    expect(at(1).lambsBorn).toBe(0);
    expect(at(1).herd.total).toBe(102);
  });

  it('sells the lambs six months on, by the kilogram', () => {
    expect(at(7).lambsSold).toBe(0);
    // month 2 + 6 = month 8, September
    expect(at(8).month).toBe('2027-09');
    expect(at(8).lambsSold).toBeCloseTo(77.76, 9);
    // 77.76 × 40 kg = 3110.4 kg; × 50 = 155 520
    expect(at(8).kgSold).toBeCloseTo(3110.4, 9);
    expect(at(8).revenue.total).toBeCloseTo(155520, 6);
    expect(at(8).herd.lambs).toBe(0);
    expect(at(8).animalsSold).toBeCloseTo(77.76, 9);
  });

  it('charges feed by season and by class', () => {
    // January: 102 adults × 30 (stall)
    expect(at(0).costs.feed).toBeCloseTo(3060, 9);
    // March: 102 × 30 + 97.2 growing lambs × 8 = 3060 + 777.6
    expect(at(2).costs.feed).toBeCloseTo(3837.6, 9);
    // April, grazing: 102 × 10 + 777.6
    expect(at(3).costs.feed).toBeCloseTo(1797.6, 9);
    // September, grazing: the lambs are sold and the 19.44 replacements, now six months old, eat as
    // adults: 121.44 × 10
    expect(at(8).costs.feed).toBeCloseTo(1214.4, 9);
    // November, stall: 121.44 × 30
    expect(at(10).costs.feed).toBeCloseTo(3643.2, 9);
  });

  it('adds the cost per head, the fixed cost and the one-off outlay', () => {
    // January: feed 3060 + 102 × 2 + 1000 + 5000 = 9264
    expect(at(0).costs).toMatchObject({ other: 204, fixed: 1000, oneOff: 5000 });
    expect(at(0).costs.total).toBeCloseTo(9264, 9);
    expect(at(0).net).toBeCloseTo(-9264, 9);
    // 20 000 − 9264
    expect(at(0).closingCash).toBeCloseTo(10736, 9);
    // February: 3060 + 204 + 1000 = 4264, so 6472 is left
    expect(at(1).closingCash).toBeCloseTo(6472, 9);
    // March: 3837.6 + 199.2 × 2 + 1000 = 5236, so 1236 is left
    expect(at(2).closingCash).toBeCloseTo(1236, 9);
  });

  it('year 1 adds up', () => {
    expect(y1).toMatchObject({ year: 1, from: '2027-01', to: '2027-12' });
    // Feed: Jan 3060 + Feb 3060 + Mar 3837.6 + Apr to Aug 5 × 1797.6 + Sep 1214.4 + Oct 1214.4
    //       + Nov, Dec 2 × 3643.2 = 28 660.8
    expect(y1.costs.feed).toBeCloseTo(28660.8, 6);
    // Per head: 2 × 204 + 6 × 398.4 + 4 × 242.88 = 3769.92
    expect(y1.costs.other).toBeCloseTo(3769.92, 6);
    expect(y1.costs.fixed).toBe(12000);
    expect(y1.costs.oneOff).toBe(5000);
    // 28 660.8 + 3769.92 + 12 000 + 5000
    expect(y1.costs.total).toBeCloseTo(49430.72, 6);
    expect(y1.revenue.total).toBeCloseTo(155520, 6);
    // 155 520 − 49 430.72
    expect(y1.profit).toBeCloseTo(106089.28, 6);
    // 20 000 + 106 089.28
    expect(y1.closingCash).toBeCloseTo(126089.28, 6);
    expect(y1.lambsBorn).toBeCloseTo(108, 9);
    expect(y1.lambsSold).toBeCloseTo(77.76, 9);
    expect(y1.kgSold).toBeCloseTo(3110.4, 9);
    expect(y1.herd.ewes).toBe(100);
    expect(y1.herd.replacements).toBeCloseTo(19.44, 9);
    expect(y1.herd.lambs).toBe(0);
  });

  it('finds the month cash runs out and the lowest point', () => {
    // After March 1236 is left; April costs 1797.6 + 398.4 + 1000 = 3196, so cash is −1960.
    expect(at(3).closingCash).toBeCloseTo(-1960, 9);
    expect(result.summary.cashKnown).toBe(true);
    expect(result.summary.firstNegativeCashMonth).toBe('2027-04');
    // Four more months at 3196 each: −1960 − 4 × 3196 = −14 744 in August, before the lambs sell.
    expect(y1.lowestCash).toBeCloseTo(-14744, 6);
    expect(y1.lowestCashMonth).toBe('2027-08');
    expect(result.summary.lowestCash).toBeCloseTo(-14744, 6);
    expect(result.summary.lowestCashMonth).toBe('2027-08');
    // September: −14 744 + 155 520 − (1214.4 + 242.88 + 1000) = 138 318.72
    expect(at(8).closingCash).toBeCloseTo(138318.72, 6);
  });

  it('pays back in the month the first lambs sell', () => {
    // Everything spent up to August exceeds everything earned; September turns it positive.
    expect(result.summary.netKnown).toBe(true);
    expect(result.summary.paybackMonth).toBe('2027-09');
  });

  it('year 2 carries the first replacements as adults and raises a second crop', () => {
    // Feed: Jan, Feb 2 × 121.44 × 30 = 7286.4; Mar 3643.2 + 777.6 = 4420.8;
    //       Apr to Aug 5 × (1214.4 + 777.6) = 9960; Sep, Oct 2 × 140.88 × 10 = 2817.6;
    //       Nov, Dec 2 × 140.88 × 30 = 8452.8. Together 32 937.6
    expect(y2.costs.feed).toBeCloseTo(32937.6, 6);
    // Per head: 2 × 242.88 + 6 × 437.28 + 4 × 281.76 = 4236.48
    expect(y2.costs.other).toBeCloseTo(4236.48, 6);
    // 32 937.6 + 4236.48 + 12 000
    expect(y2.costs.total).toBeCloseTo(49174.08, 6);
    // 155 520 − 49 174.08
    expect(y2.profit).toBeCloseTo(106345.92, 6);
    expect(y2.closingCash).toBeCloseTo(232435.2, 6);
    expect(y2.herd.ewes).toBe(100);
    // two crops of 19.44
    expect(y2.herd.replacements).toBeCloseTo(38.88, 9);
  });

  it('year 3: the first replacements join the ewes at 24 months and lamb', () => {
    expect(at(25).herd.ewes).toBe(100);
    // month 2 + 24 = month 26: 100 + 19.44
    expect(at(26).herd.ewes).toBeCloseTo(119.44, 9);
    // 119.44 × 0.9 × 1.2 = 128.9952 born
    expect(at(26).lambsBorn).toBeCloseTo(128.9952, 9);
    // × 0.9 = 116.09568 weaned; kept 116.09568 × 0.2 = 23.219136; for sale 92.876544
    expect(at(26).herd.lambs).toBeCloseTo(92.876544, 9);
    // the second crop's 19.44 and the new 23.219136
    expect(at(26).herd.replacements).toBeCloseTo(42.659136, 9);
    // 92.876544 × 40 × 50
    expect(y3.revenue.total).toBeCloseTo(185753.088, 6);
    // Feed: Jan, Feb 2 × 4226.4; Mar 4226.4 + 116.09568 × 8 = 5155.16544;
    //       Apr to Aug 5 × (1408.8 + 928.76544) = 11 687.8272; Sep, Oct 2 × 164.099136 × 10;
    //       Nov, Dec 2 × 164.099136 × 30. Together 38 423.72352
    expect(y3.costs.feed).toBeCloseTo(38423.72352, 5);
    // Per head: 2 × 281.76 + 6 × 513.95136 + 4 × 328.198272 = 4960.021248
    expect(y3.costs.other).toBeCloseTo(4960.021248, 5);
    // 185 753.088 − (38 423.72352 + 4960.021248 + 12 000)
    expect(y3.profit).toBeCloseTo(130369.343232, 5);
    expect(y3.closingCash).toBeCloseTo(362804.543232, 5);
    expect(y3.herd).toMatchObject({ rams: 2, lambs: 0 });
    expect(y3.herd.ewes).toBeCloseTo(119.44, 9);
  });

  it('break-even price is all cost over all kilograms sold', () => {
    // Costs: 49 430.72 + 49 174.08 + 55 383.744768 = 153 988.544768
    expect(result.summary.costs).toBeCloseTo(153988.544768, 5);
    // Kilograms: 3110.4 + 3110.4 + 92.876544 × 40 = 9935.86176
    expect(result.summary.kgSold).toBeCloseTo(9935.86176, 6);
    // 153 988.544768 / 9935.86176 = 15.498…, against an assumed price of 50
    expect(result.summary.breakEvenPricePerKg).toBeCloseTo(153988.544768 / 9935.86176, 6);
    expect(result.summary.breakEvenPricePerKg).toBeCloseTo(15.498, 3);
  });

  it('profit per ewe per year uses the average flock', () => {
    // Profit 342 804.543232 over 3 years. Ewes: 26 months at 100 and 10 at 119.44, average 105.4.
    expect(result.summary.profit).toBeCloseTo(342804.543232, 5);
    expect(result.summary.profitPerEwePerYear).toBeCloseTo(342804.543232 / 3 / 105.4, 5);
  });
});

describe('runScenario, ewes leaving', () => {
  it('takes a twelfth of the yearly deaths and culls each month and sells the culls by the head', () => {
    const result = runScenario({ ...tiny, eweDeathsPerYear: 0.12, eweCullsPerYear: 0.24 });
    // Month 0: 100 × 0.12 / 12 = 1 dies, 100 × 0.24 / 12 = 2 are culled, 97 stay.
    expect(result.months[0].ewesDied).toBeCloseTo(1, 9);
    expect(result.months[0].ewesCulled).toBeCloseTo(2, 9);
    expect(result.months[0].herd.ewes).toBeCloseTo(97, 9);
    // 2 × 1000
    expect(result.months[0].revenue.culls).toBeCloseTo(2000, 9);
    // Month 1: 97 × 0.03 = 2.91 leave, 94.09 stay.
    expect(result.months[1].herd.ewes).toBeCloseTo(94.09, 9);
    // Month 2, lambing on the ewes left: 94.09 × 0.97 = 91.2673; × 0.9 × 1.2 = 98.568684
    expect(result.months[2].lambsBorn).toBeCloseTo(98.568684, 9);
  });
});

describe('runScenario, animals on the farm at the start', () => {
  it('sells opening lambs once they reach the sale age', () => {
    // The plan starts in November 2026, lambing is in March: the lambs are 8 months old, past the
    // sale age of 6, so all 50 sell in month 0. 50 × 40 × 50 = 100 000
    const result = runScenario({ ...tiny, startMonth: '2026-11', openingLambs: 50 });
    expect(result.months[0].lambsSold).toBe(50);
    expect(result.months[0].revenue.lambs).toBe(100000);
    expect(result.months[0].herd.lambs).toBe(0);
    // The first lambing is March 2027, month 4.
    expect(result.months[4].month).toBe('2027-03');
    expect(result.months[4].lambsBorn).toBeCloseTo(108, 9);
  });

  it('holds opening lambs younger than the sale age until they reach it', () => {
    // Start in May, lambing in March: two months old. Sold at six months, in month 4 (September).
    const result = runScenario({ ...tiny, startMonth: '2027-05', openingLambs: 50 });
    expect(result.months[3].lambsSold).toBe(0);
    expect(result.months[3].herd.lambs).toBe(50);
    expect(result.months[4].lambsSold).toBe(50);
  });

  it('moves opening replacements to the ewes at the first-lambing age', () => {
    // Start in January 2027, born March 2026: ten months old. They reach 24 months in month 14,
    // March 2028, and lamb with the ewes: (100 + 10) × 0.9 × 1.2 = 118.8
    const result = runScenario({ ...tiny, openingReplacements: 10 });
    expect(result.months[13].herd.ewes).toBe(100);
    expect(result.months[14].herd.ewes).toBe(110);
    expect(result.months[14].lambsBorn).toBeCloseTo(118.8, 9);
  });
});

describe('runScenario, missing data is null', () => {
  it('an unknown price leaves revenue, profit and cash unknown from the first sale on', () => {
    const result = runScenario({ ...tiny, pricePerKg: null });
    expect(result.missing).toEqual(['pricePerKg']);
    // Nothing is sold before September, so those months are known.
    expect(result.months[7].closingCash).toBeCloseTo(-14744, 6);
    expect(result.months[8].revenue.total).toBeNull();
    expect(result.months[8].closingCash).toBeNull();
    expect(result.years[0].profit).toBeNull();
    expect(result.years[0].lowestCash).toBeNull();
    expect(result.summary.cashKnown).toBe(false);
    expect(result.summary.firstNegativeCashMonth).toBeNull();
    expect(result.summary.paybackMonth).toBeNull();
    // Costs and kilograms do not rest on the price, so the break-even price is still known.
    expect(result.summary.breakEvenPricePerKg).toBeCloseTo(153988.544768 / 9935.86176, 6);
    expect(result.summary.profitPerEwePerYear).toBeNull();
  });

  it('with nothing sold there is no break-even price', () => {
    const result = runScenario({ ...tiny, lambingShare: 0 });
    expect(result.summary.kgSold).toBe(0);
    expect(result.summary.breakEvenPricePerKg).toBeNull();
    // Costs are still known, and nothing ever comes in.
    expect(result.summary.paybackMonth).toBeNull();
    expect(result.summary.netKnown).toBe(true);
  });

  it('unknown opening cash hides cash and nothing else', () => {
    const result = runScenario({ ...tiny, openingCash: null });
    expect(result.missing).toEqual(['openingCash']);
    expect(result.months[0].closingCash).toBeNull();
    expect(result.years[0].profit).toBeCloseTo(106089.28, 6);
    expect(result.summary.cashKnown).toBe(false);
    expect(result.summary.lowestCash).toBeNull();
    expect(result.summary.paybackMonth).toBe('2027-09');
  });

  it('without a lambing month no head count is known', () => {
    const result = runScenario({ ...tiny, lambingMonth: null });
    expect(result.missing).toContain('lambingMonth');
    expect(result.months[0].herd).toEqual({ ewes: null, rams: 2, replacements: null, lambs: null, total: null });
    expect(result.months[0].lambsBorn).toBeNull();
    expect(result.months[0].costs.total).toBeNull();
    expect(result.years[2].closingCash).toBeNull();
    expect(result.summary.breakEvenPricePerKg).toBeNull();
  });

  it('an unknown feed cost for lambs matters only once there are lambs', () => {
    const result = runScenario({ ...tiny, feedLambPerMonth: null });
    expect(result.months[1].costs.feed).toBeCloseTo(3060, 9);
    expect(result.months[2].costs.feed).toBeNull();
    expect(result.missing).toEqual(['feedLambPerMonth']);
  });

  it('a cull price is not asked for when no ewe is culled', () => {
    const result = runScenario({ ...tiny, cullEwePrice: null });
    expect(result.missing).toEqual([]);
    expect(result.years[0].profit).toBeCloseTo(106089.28, 6);
  });

  it('without stall months the adult feed cost is unknown', () => {
    const result = runScenario({ ...tiny, stallMonths: null });
    expect(result.missing).toEqual(['stallMonths']);
    expect(result.months[0].costs.feed).toBeNull();
  });

  it('an empty plan names everything it waits for and guesses nothing', () => {
    const empty = Object.fromEntries(Object.keys(tiny).map((key) => [key, null])) as unknown as ScenarioAssumptions;
    const result = runScenario({ ...empty, startMonth: '2027-01', oneOffs: [] });
    expect(result.months.every((row) => row.net === null && row.closingCash === null && row.herd.total === null)).toBe(true);
    expect(result.summary).toMatchObject({ profit: null, breakEvenPricePerKg: null, profitPerEwePerYear: null, firstNegativeCashMonth: null, paybackMonth: null });
    expect(result.missing).toEqual(expect.arrayContaining(['openingEwes', 'lambingMonth', 'saleAgeMonths', 'fixedCostPerMonth', 'openingCash', 'stallMonths']));
  });
});
