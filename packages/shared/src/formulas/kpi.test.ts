import { describe, expect, it } from 'vitest';
import {
  attendancePercent,
  feedCostPerHeadDay,
  feedLossPercent,
  machineryUtilizationPercent,
  operatingRatio,
  perEmployee,
  profitPerHead,
  tasksOnTime,
  type AssignedTask,
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

describe('tasksOnTime', () => {
  const november = { from: '2026-11-01', to: '2026-11-30' };
  const today = '2026-11-20';
  const task = (over: Partial<AssignedTask>): AssignedTask => ({
    dueDate: '2026-11-05',
    status: 'done',
    completedAt: '2026-11-05T04:00:00Z',
    completedByAssignee: true,
    completionSource: 'person',
    ...over,
  });

  it('a task finished at 23:30 Tashkent time on its due date is on time', () => {
    // 18:30 UTC on the 10th is 23:30 in Tashkent on the 10th.
    const result = tasksOnTime([task({ dueDate: '2026-11-10', completedAt: '2026-11-10T18:30:00Z' })], november, today);
    expect(result).toEqual({ onTime: 1, due: 1, percent: 100 });
  });

  it('half an hour after midnight at the farm is late, although the UTC date is still the due date', () => {
    // 19:30 UTC on the 10th is 00:30 in Tashkent on the 11th.
    const result = tasksOnTime([task({ dueDate: '2026-11-10', completedAt: '2026-11-10T19:30:00Z' })], november, today);
    expect(result).toEqual({ onTime: 0, due: 1, percent: 0 });
  });

  it('control numbers: 3 on time out of 6 due is 50 %', () => {
    const tasks: AssignedTask[] = [
      task({}), // on time: 09:00 on the due date
      task({ dueDate: '2026-11-10', completedAt: '2026-11-10T18:30:00Z' }), // on time: 23:30 on the due date
      task({ dueDate: '2026-11-10', completedAt: '2026-11-10T19:30:00Z' }), // late: 00:30 the next day
      task({ dueDate: '2026-11-12', status: 'open', completedAt: null, completionSource: null }), // overdue and open
      task({ dueDate: '2026-11-14', completedAt: '2026-11-13T06:00:00Z', completedByAssignee: false }), // a manager closed it
      task({ dueDate: '2026-11-28', completedAt: '2026-11-18T06:00:00Z' }), // on time: closed early
      // Left out of both sides:
      task({ dueDate: '2026-11-25', status: 'in_progress', completedAt: null, completionSource: null }), // not due yet
      task({ dueDate: '2026-11-15', status: 'cancelled', completedAt: null, completionSource: null }),
      task({ dueDate: null }),
      task({ dueDate: '2026-11-08', completedAt: '2026-11-07T06:00:00Z', completedByAssignee: false, completionSource: 'alert_resolved' }),
      task({ dueDate: '2026-10-31', completedAt: '2026-10-31T06:00:00Z' }), // fell due before the period
      task({ dueDate: '2026-12-01', completedAt: '2026-11-19T06:00:00Z' }), // falls due after the period
    ];
    expect(tasksOnTime(tasks, november, today)).toEqual({ onTime: 3, due: 6, percent: 50 });
  });

  it('2 of 3 is 66.7 %', () => {
    const tasks = [task({}), task({}), task({ status: 'open', completedAt: null, completionSource: null })];
    expect(tasksOnTime(tasks, november, today)).toEqual({ onTime: 2, due: 3, percent: 66.7 });
  });

  it('a task due today and still open is not late yet', () => {
    const open = task({ dueDate: today, status: 'open', completedAt: null, completionSource: null });
    expect(tasksOnTime([open], november, today)).toEqual({ onTime: 0, due: 0, percent: null });
    expect(tasksOnTime([open], november, '2026-11-21')).toEqual({ onTime: 0, due: 1, percent: 0 });
  });

  it('nothing due gives null, never 0 or 100', () => {
    expect(tasksOnTime([], november, today).percent).toBeNull();
    const leftOut = [task({ status: 'cancelled' }), task({ dueDate: null }), task({ completionSource: 'alert_resolved' })];
    expect(tasksOnTime(leftOut, november, today)).toEqual({ onTime: 0, due: 0, percent: null });
  });

  it('reads the clock of the farm it is given', () => {
    // 23:30 UTC on the 10th: still the 10th in London, already the 11th in Tashkent.
    const late = [task({ dueDate: '2026-11-10', completedAt: '2026-11-10T23:30:00Z' })];
    expect(tasksOnTime(late, november, today, 'Europe/London').onTime).toBe(1);
    expect(tasksOnTime(late, november, today).onTime).toBe(0);
  });
});
