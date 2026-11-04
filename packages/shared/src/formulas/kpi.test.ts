import { describe, expect, it } from 'vitest';
import {
  attendancePercent,
  feedCostPerHeadDay,
  feedLossPercent,
  machineryUtilizationPercent,
  operatingRatio,
  perEmployee,
  profitPerHead,
} from './kpi';

describe('KPI formulas', () => {
  it('operatingRatio', () => {
    expect(operatingRatio(80, 100)).toBe(0.8);
    expect(operatingRatio(120, 100)).toBe(1.2);
    expect(operatingRatio(80, 0)).toBeNull();
  });

  it('profitPerHead', () => {
    expect(profitPerHead(1500, 1000, 500)).toBe(1);
    expect(profitPerHead(1000, 1500, 500)).toBe(-1);
  });

  it('profitPerHead has no answer before the first income or with no animals', () => {
    expect(profitPerHead(0, 1000, 500)).toBeNull();
    expect(profitPerHead(1500, 1000, 0)).toBeNull();
  });

  it('perEmployee', () => {
    expect(perEmployee(500, 10)).toBe(50);
    expect(perEmployee(500, 0)).toBeNull();
    expect(perEmployee(0, 10)).toBeNull();
  });

  it('attendancePercent ignores days that were not due', () => {
    expect(attendancePercent(18, 2)).toBe(90);
    expect(attendancePercent(20, 0)).toBe(100);
    expect(attendancePercent(0, 5)).toBe(0);
    expect(attendancePercent(0, 0)).toBeNull();
  });

  it('machineryUtilizationPercent', () => {
    // 2 machines × 10 days × 8 h = 160 h available; 40 h worked.
    expect(machineryUtilizationPercent(40, 2, 10)).toBe(25);
    expect(machineryUtilizationPercent(40, 2, 10, 10)).toBe(20);
    expect(machineryUtilizationPercent(40, 0, 10)).toBeNull();
    expect(machineryUtilizationPercent(40, 2, 0)).toBeNull();
  });

  it('feedLossPercent', () => {
    expect(feedLossPercent(5, 95)).toBe(5);
    expect(feedLossPercent(0, 95)).toBe(0);
    expect(feedLossPercent(0, 0)).toBeNull();
  });

  it('feedCostPerHeadDay', () => {
    expect(feedCostPerHeadDay(1_050_000, 500)).toBe(2100);
    expect(feedCostPerHeadDay(1_050_000, 0)).toBeNull();
  });
});
