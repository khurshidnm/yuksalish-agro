import { describe, expect, it } from 'vitest';
import * as f from './index';

describe('round', () => {
  it('rounds half away from zero and survives float noise', () => {
    expect(f.round(1.005, 2)).toBe(1.01);
    expect(f.round(-1.005, 2)).toBe(-1.01);
    expect(f.round(2.5, 0)).toBe(3);
    expect(f.round(0)).toBe(0);
  });
});

describe('livestock', () => {
  it('herdCount follows spec 8.6', () => {
    expect(
      f.herdCount({ opening: 500, born: 620, purchased: 10, sold: 300, slaughtered: 5, dead: 12 }),
    ).toBe(813);
    expect(
      f.herdCount({ opening: 10, born: 0, purchased: 0, sold: 0, slaughtered: 0, dead: 0, lost: 2 }),
    ).toBe(8);
  });

  it('lambingPercent and survivalPercent', () => {
    expect(f.lambingPercent(620, 500)).toBe(124);
    expect(f.lambingPercent(10, 0)).toBeNull();
    expect(f.survivalPercent(589, 620)).toBeCloseTo(95, 5);
    expect(f.survivalPercent(0, 0)).toBeNull();
  });

  it('mortalityPercent', () => {
    expect(f.mortalityPercent(5, 500)).toBe(1);
    expect(f.mortalityPercent(5, 0)).toBeNull();
  });

  it('averageDailyGain', () => {
    expect(f.averageDailyGain(30, 24, 30)).toBeCloseTo(0.2, 10);
    expect(f.averageDailyGain(30, 24, 0)).toBeNull();
    expect(f.averageDailyGain(30, 24, -1)).toBeNull();
    expect(f.averageDailyGain(24, 30, 30)).toBeCloseTo(-0.2, 10);
  });

  it('costPerKgLiveWeight', () => {
    expect(
      f.costPerKgLiveWeight({ feed: 800, vet: 100, labor: 300, overhead: 100, weightGainKg: 100 }),
    ).toBe(13);
    expect(f.costPerKgLiveWeight({ feed: 1, vet: 1, labor: 1, overhead: 1, weightGainKg: 0 })).toBeNull();
    expect(f.costPerKgLiveWeight({ feed: 1, vet: 1, labor: 1, overhead: 1, weightGainKg: -5 })).toBeNull();
  });

  it('feedConversion', () => {
    expect(f.feedConversion(600, 100)).toBe(6);
    expect(f.feedConversion(600, 0)).toBeNull();
  });

  it('scaleGainToHerd scales a fair sample and refuses a small one', () => {
    // 250 of 500 ewes gained 1 000 kg: the herd gained about 2 000 kg.
    expect(f.scaleGainToHerd(1000, 250, 500)).toBe(2000);
    expect(f.scaleGainToHerd(1000, 500, 500)).toBe(1000);
    expect(f.scaleGainToHerd(500, 125, 500)).toBeNull();
    expect(f.scaleGainToHerd(100, 0, 500)).toBeNull();
    expect(f.scaleGainToHerd(100, 10, 0)).toBeNull();
  });

  it('revenuePerEwe', () => {
    expect(f.revenuePerEwe(900, 100, 500)).toBe(2);
    expect(f.revenuePerEwe(900, 100, 0)).toBeNull();
  });

  it('expectedLambingDate uses 150 days by default', () => {
    expect(f.expectedLambingDate('2026-10-01')).toBe('2027-02-28');
    expect(f.expectedLambingDate('2026-10-01', 145)).toBe('2027-02-23');
    expect(() => f.expectedLambingDate('not-a-date')).toThrow(RangeError);
  });

  it('crosses a leap February correctly', () => {
    expect(f.expectedLambingDate('2027-10-01')).toBe('2028-02-28');
    expect(f.expectedLambingDate('2027-10-03')).toBe('2028-03-01');
  });

  it('lambingWindow spans 145 to 152 days', () => {
    expect(f.lambingWindow('2026-10-01')).toEqual({ earliest: '2027-02-23', latest: '2027-03-02' });
  });

  it('withdrawalUntil ignores negative days', () => {
    expect(f.withdrawalUntil('2026-11-01', 14)).toBe('2026-11-15');
    expect(f.withdrawalUntil('2026-11-01', -3)).toBe('2026-11-01');
  });
});

describe('feed', () => {
  const ewes = [{ kgPerHeadPerDay: 1.2, head: 500 }];

  it('dailyRequirementKg sums all consumers', () => {
    expect(f.dailyRequirementKg(ewes)).toBeCloseTo(600, 8);
    expect(f.dailyRequirementKg([...ewes, { kgPerHeadPerDay: 0.5, head: 100 }])).toBeCloseTo(650, 8);
    expect(f.dailyRequirementKg([])).toBe(0);
  });

  it('feedDays', () => {
    expect(f.feedDays(120_000, ewes)).toBeCloseTo(200, 8);
    expect(f.feedDays(120_000, [])).toBeNull();
  });

  it('feedDaysByActual', () => {
    expect(f.feedDaysByActual(120_000, 750)).toBe(160);
    expect(f.feedDaysByActual(120_000, 0)).toBeNull();
  });

  it('winterFeedBalance reports shortage and surplus', () => {
    expect(f.winterFeedBalance({ head: 500, days: 120, kgPerHeadPerDay: 1.2, stockKg: 60_000 })).toEqual({
      requiredKg: 72_000,
      shortageKg: 12_000,
      surplusKg: 0,
    });
    const surplus = f.winterFeedBalance({ head: 100, days: 10, kgPerHeadPerDay: 1, stockKg: 1500 });
    expect(surplus).toEqual({ requiredKg: 1000, shortageKg: 0, surplusKg: 500 });
    const exact = f.winterFeedBalance({ head: 100, days: 10, kgPerHeadPerDay: 1, stockKg: 1000 });
    expect(exact).toEqual({ requiredKg: 1000, shortageKg: 0, surplusKg: 0 });
  });

  it('hectaresForShortage', () => {
    expect(f.hectaresForShortage(24_000, 8)).toBe(3);
    expect(f.hectaresForShortage(24_000, 0)).toBeNull();
  });

  it('deviationPercent', () => {
    expect(f.deviationPercent(690, 600)).toBeCloseTo(15, 8);
    expect(f.deviationPercent(510, 600)).toBeCloseTo(-15, 8);
    expect(f.deviationPercent(10, 0)).toBeNull();
  });

  it('rationCostPerHeadDay', () => {
    expect(
      f.rationCostPerHeadDay([
        { kgPerHeadPerDay: 1.2, unitCostPerKg: 1000 },
        { kgPerHeadPerDay: 0.3, unitCostPerKg: 3000 },
      ]),
    ).toBeCloseTo(2100, 8);
  });
});

describe('crops', () => {
  const costs = { seed: 100, fertilizer: 200, water: 50, machinery: 300, labor: 150, overheadShare: 200 };

  it('cropCostTotal and costPerTon', () => {
    expect(f.cropCostTotal(costs)).toBe(1000);
    expect(f.costPerTon(costs, 4)).toBe(250);
    expect(f.costPerTon(costs, 0)).toBeNull();
  });

  it('yieldPerHectare', () => {
    expect(f.yieldPerHectare(60, 12)).toBe(5);
    expect(f.yieldPerHectare(60, 0)).toBeNull();
  });
});

describe('finance', () => {
  it('profitabilityPercent', () => {
    expect(f.profitabilityPercent(150, 100)).toBe(50);
    expect(f.profitabilityPercent(50, 100)).toBe(-50);
    expect(f.profitabilityPercent(50, 0)).toBeNull();
  });

  it('budgetExecutionPercent', () => {
    expect(f.budgetExecutionPercent(75, 100)).toBe(75);
    expect(f.budgetExecutionPercent(75, 0)).toBeNull();
  });

  it('toBaseAmount', () => {
    expect(f.toBaseAmount(100, 12_650.55)).toBe(1_265_055);
  });

  it('allocateOverhead splits by weight', () => {
    expect(
      f.allocateOverhead(1000, [
        { id: 'herd', weight: 3 },
        { id: 'field', weight: 1 },
      ]),
    ).toEqual({ herd: 750, field: 250 });
  });

  it('allocateOverhead shares always sum exactly to the total', () => {
    const shares = f.allocateOverhead(100, [
      { id: 'a', weight: 1 },
      { id: 'b', weight: 1 },
      { id: 'c', weight: 1 },
    ]);
    const sum = Object.values(shares).reduce((a, b) => a + b, 0);
    expect(f.round(sum, 2)).toBe(100);
  });

  it('allocateOverhead skips empty cases', () => {
    expect(f.allocateOverhead(100, [])).toEqual({});
    expect(f.allocateOverhead(0, [{ id: 'a', weight: 1 }])).toEqual({});
    expect(f.allocateOverhead(100, [{ id: 'a', weight: 0 }])).toEqual({});
    expect(
      f.allocateOverhead(100, [
        { id: 'a', weight: 0 },
        { id: 'b', weight: 2 },
      ]),
    ).toEqual({ b: 100 });
  });

  it('depreciation', () => {
    expect(f.straightLineMonthly(1200, 0, 12)).toBe(100);
    expect(f.straightLineMonthly(1200, 200, 10)).toBe(100);
    expect(f.straightLineMonthly(100, 200, 10)).toBe(0);
    expect(f.straightLineMonthly(1200, 0, 0)).toBeNull();
    expect(f.unitsOfProductionDepreciation(1000, 0, 100, 10)).toBe(100);
    expect(f.unitsOfProductionDepreciation(1000, 0, 0, 10)).toBeNull();
  });

  it('machineryUnitCost', () => {
    expect(f.machineryUnitCost({ fuel: 40, labor: 30, repairs: 20, depreciation: 10 }, 5)).toBe(20);
    expect(f.machineryUnitCost({ fuel: 40, labor: 30, repairs: 20, depreciation: 10 }, 0)).toBeNull();
  });

  it('annuity loan repays exactly the principal', () => {
    const rows = f.loanSchedule(12_000_000, 14, 12);
    expect(rows).toHaveLength(12);
    expect(rows.at(-1)!.balance).toBe(0);
    expect(f.round(rows.reduce((s, r) => s + r.principal, 0), 2)).toBe(12_000_000);
    // Annuity payments are level, apart from the final rounding instalment.
    const payments = rows.slice(0, -1).map((r) => r.payment);
    expect(Math.max(...payments) - Math.min(...payments)).toBeLessThan(0.02);
    // Interest in the first month is principal × monthly rate.
    expect(rows[0].interest).toBe(140_000);
  });

  it('equal-principal loan has falling payments', () => {
    const rows = f.loanSchedule(1200, 12, 12, 'equal_principal');
    expect(rows[0].principal).toBe(100);
    expect(rows[0].payment).toBeGreaterThan(rows[11].payment);
    expect(rows.at(-1)!.balance).toBe(0);
  });

  it('zero-interest loan splits evenly and invalid input is empty', () => {
    const rows = f.loanSchedule(1200, 0, 12);
    expect(rows[0].payment).toBe(100);
    expect(rows[0].interest).toBe(0);
    expect(f.loanSchedule(0, 10, 12)).toEqual([]);
    expect(f.loanSchedule(100, 10, 0)).toEqual([]);
  });
});

describe('inventory costing', () => {
  const batches = [
    { id: 'a', qtyRemaining: 100, unitCost: 10 },
    { id: 'b', qtyRemaining: 100, unitCost: 20 },
  ];

  it('FIFO takes the oldest batch first at its own cost', () => {
    const r = f.consumeBatches(batches, 150);
    expect(r.lines).toEqual([
      { batchId: 'a', qty: 100, unitCost: 10 },
      { batchId: 'b', qty: 50, unitCost: 20 },
    ]);
    expect(r.totalCost).toBe(2000);
    expect(r.shortage).toBe(0);
  });

  it('reports a shortage instead of going negative', () => {
    const r = f.consumeBatches(batches, 250);
    expect(r.shortage).toBe(50);
    expect(r.totalCost).toBe(3000);
  });

  it('skips empty batches', () => {
    const r = f.consumeBatches([{ id: 'x', qtyRemaining: 0, unitCost: 5 }, batches[1]], 10);
    expect(r.lines).toEqual([{ batchId: 'b', qty: 10, unitCost: 20 }]);
  });

  it('weightedAverageCost', () => {
    expect(f.weightedAverageCost(batches)).toBe(15);
    expect(f.weightedAverageCost([])).toBe(0);
  });
});
