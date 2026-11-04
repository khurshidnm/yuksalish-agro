import { describe, expect, it } from 'vitest';
import {
  expectedHarvestT,
  fuelNormLiters,
  harvestSplit,
  onTimePercent,
  planCostEstimate,
  techCardNorms,
  waterPerTon,
} from './crops';

describe('tech card', () => {
  const lines = [
    { costPerHa: 300_000, seedKgHa: 220 },
    { costPerHa: 450_000, fertilizerKgHa: 150 },
    { costPerHa: 150_000, waterM3Ha: 1200, laborDaysHa: 0.5 },
    { waterM3Ha: 800 },
  ];

  it('sums norms per hectare and treats a missing norm as zero', () => {
    expect(techCardNorms(lines)).toEqual({
      costPerHa: 900_000,
      seedKgHa: 220,
      fertilizerKgHa: 150,
      waterM3Ha: 2000,
      laborDaysHa: 0.5,
    });
    expect(techCardNorms([]).costPerHa).toBe(0);
  });

  it('estimates plan cost as card cost per hectare × area', () => {
    expect(planCostEstimate(lines, 20)).toBe(18_000_000);
    expect(planCostEstimate([], 20)).toBe(0);
  });
});

describe('harvest', () => {
  it('expectedHarvestT is null, not zero, when the yield is unknown', () => {
    expect(expectedHarvestT(20, 4.5)).toBe(90);
    expect(expectedHarvestT(20, null)).toBeNull();
    expect(expectedHarvestT(20, undefined)).toBeNull();
    expect(expectedHarvestT(20, 0)).toBe(0);
  });

  it('harvestSplit divides by the own-use share', () => {
    expect(harvestSplit(200, 75)).toEqual({ ownUseT: 150, saleT: 50 });
    expect(harvestSplit(200, 0)).toEqual({ ownUseT: 0, saleT: 200 });
  });

  it('waterPerTon', () => {
    expect(waterPerTon(90_000, 60)).toBe(1500);
    expect(waterPerTon(90_000, 0)).toBeNull();
  });
});

describe('kpis and norms', () => {
  it('onTimePercent', () => {
    expect(onTimePercent(9, 12)).toBe(75);
    expect(onTimePercent(0, 0)).toBeNull();
  });

  it('prefers the per-hectare norm when area is known', () => {
    expect(fuelNormLiters({ motoHours: 8, volumeHa: 10, normLPerHour: 9, normLPerHa: 7 })).toBe(70);
  });

  it('falls back to the hourly norm', () => {
    expect(fuelNormLiters({ motoHours: 8, volumeHa: null, normLPerHour: 9, normLPerHa: 7 })).toBe(72);
    expect(fuelNormLiters({ motoHours: 8, volumeHa: 10, normLPerHour: 9 })).toBe(72);
  });

  it('is null when no norm applies', () => {
    expect(fuelNormLiters({ motoHours: 8, volumeHa: 10 })).toBeNull();
    expect(fuelNormLiters({ normLPerHour: 9, normLPerHa: 7 })).toBeNull();
  });
});
