import { describe, expect, it } from 'vitest';
import type { OutboxRecord, SentRecord } from '@/lib/outbox';
import {
  animalsLeaving,
  herdDayStatus,
  matchAnimals,
  notableDeviation,
  queuedFeed,
  stepDown,
  stepFor,
  stepUp,
  type DirectoryAnimal,
} from './logic';

const animal = (tag: string, over: Partial<DirectoryAnimal> = {}): DirectoryAnimal => ({
  id: tag,
  tag,
  sex: 'female',
  category: 'ewe',
  status: 'pregnant',
  herdId: 'h',
  codes: [],
  expectedDate: null,
  ...over,
});

const record = (over: Partial<OutboxRecord>): OutboxRecord =>
  ({ id: 'r', kind: 'daily_log', method: 'POST', status: 'pending', body: {}, meta: {}, ...over }) as OutboxRecord;

describe('matchAnimals', () => {
  const herd = [animal('YA-0012'), animal('YA-0123'), animal('YA-1230'), animal('YA-0500', { codes: ['982000123456789'] })];

  it('finds the number on the tag first, ignoring leading zeros', () => {
    expect(matchAnimals(herd, '123').map((a) => a.tag)).toEqual(['YA-0123', 'YA-1230']);
    expect(matchAnimals(herd, '0123')[0].tag).toBe('YA-0123');
    expect(matchAnimals(herd, '12').map((a) => a.tag)[0]).toBe('YA-0012');
  });

  it('matches a whole tag in any case, and scanned codes exactly', () => {
    expect(matchAnimals(herd, 'ya-0500')[0].tag).toBe('YA-0500');
    expect(matchAnimals(herd, '982000123456789').map((a) => a.tag)).toEqual(['YA-0500']);
    expect(matchAnimals(herd, '98200012345')).toEqual([]);
  });

  it('returns nothing for an empty query and respects the limit', () => {
    expect(matchAnimals(herd, '  ')).toEqual([]);
    expect(matchAnimals(herd, 'YA', 2)).toHaveLength(2);
  });
});

describe('stepper', () => {
  it('scales the step to the quantity', () => {
    expect(stepFor(600)).toBe(10);
    expect(stepFor(150)).toBe(5);
    expect(stepFor(12)).toBe(1);
    expect(stepFor(3.6)).toBe(0.5);
    expect(stepFor(0.9)).toBe(0.1);
  });

  it('does not collect float noise and stops at zero', () => {
    expect(stepUp(0.1, 0.2)).toBe(0.3);
    expect(stepDown(0.3, 0.1)).toBe(0.2);
    expect(stepDown(0.05, 0.1)).toBe(0);
    expect(stepUp(null, 10)).toBe(10);
  });
});

describe('notableDeviation', () => {
  it('speaks up only past the threshold, in both directions', () => {
    expect(notableDeviation(720, 600, 15)).toBe(20);
    expect(notableDeviation(480, 600, 15)).toBe(-20);
    expect(notableDeviation(690, 600, 15)).toBeNull();
  });

  it('stays quiet with nothing to compare', () => {
    expect(notableDeviation(null, 600, 15)).toBeNull();
    expect(notableDeviation(10, 0, 15)).toBeNull();
  });
});

describe('herdDayStatus', () => {
  const date = '2026-11-04';
  const herd = { id: 'h1', log: null };
  const queued = record({ meta: { herdId: 'h1', date } });

  it('is todo with nothing recorded', () => {
    expect(herdDayStatus(herd, [], [], date, date)).toBe('todo');
  });

  it('trusts the queue over the last download', () => {
    expect(herdDayStatus(herd, [queued], [], date, date)).toBe('queued');
    expect(herdDayStatus({ ...herd, log: {} }, [{ ...queued, status: 'conflict' }], [], date, date)).toBe('conflict');
    expect(herdDayStatus(herd, [{ ...queued, status: 'failed' }], [], date, date)).toBe('failed');
  });

  it('counts a log from the download only if the download is from today', () => {
    expect(herdDayStatus({ ...herd, log: {} }, [], [], date, date)).toBe('logged');
    expect(herdDayStatus({ ...herd, log: {} }, [], [], date, '2026-11-03')).toBe('todo');
  });

  it('counts a record sent since the last download', () => {
    const sent = [{ kind: 'daily_log', meta: { herdId: 'h1', date } }] as unknown as SentRecord[];
    expect(herdDayStatus(herd, [], sent, date, date)).toBe('logged');
    expect(herdDayStatus(herd, [], sent, '2026-11-05', date)).toBe('todo');
  });

  it("ignores another herd's or day's record", () => {
    expect(herdDayStatus(herd, [record({ meta: { herdId: 'h2', date } })], [], date, date)).toBe('todo');
    expect(herdDayStatus(herd, [record({ meta: { herdId: 'h1', date: '2026-11-03' } })], [], date, date)).toBe('todo');
  });
});

describe('queuedFeed', () => {
  const line = (qty: number) => ({ lines: [{ itemId: 'hay', actualQty: qty }] });

  it('adds up what the queue has promised', () => {
    const records = [record({ id: 'a', body: line(600) }), record({ id: 'b', body: line(610.5) })];
    expect(queuedFeed(records, 'hay')).toBe(1210.5);
    expect(queuedFeed(records, 'barley')).toBe(0);
  });

  it('leaves out the record being edited, conflicts and corrections', () => {
    const records = [
      record({ id: 'a', body: line(600) }),
      record({ id: 'b', body: line(100), status: 'conflict' }),
      record({ id: 'c', body: line(50), method: 'PATCH' }),
    ];
    expect(queuedFeed(records, 'hay', 'a')).toBe(0);
    expect(queuedFeed(records, 'hay')).toBe(600);
  });
});

describe('animalsLeaving', () => {
  it('collects animals with a queued death', () => {
    const records = [record({ kind: 'death', body: { animalId: 'x' } }), record({ kind: 'weight', body: { animalId: 'y' } })];
    expect([...animalsLeaving(records)]).toEqual(['x']);
  });
});
