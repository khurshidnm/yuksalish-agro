import { describe, expect, it } from 'vitest';
import { waitsFor, type OutboxRecord, type SentRecord } from '@/lib/outbox';
import { afterLambingRecords, careReady, ewesLambed, pensTaken, type AfterLambing, type LambCareDraft } from './logic';

const record = (over: Partial<OutboxRecord>): OutboxRecord =>
  ({ id: 'r', kind: 'lambing', method: 'POST', status: 'pending', body: {}, meta: {}, createdAt: 1, ...over }) as OutboxRecord;

const draft = (lambId: string, over: Partial<LambCareDraft> = {}): LambCareDraft => ({
  lambId,
  colostrum: false,
  navelTreated: false,
  mothering: 'with_dam',
  fosterEweId: null,
  ...over,
});

const input = (over: Partial<AfterLambing>): AfterLambing => ({
  ewe: { id: 'ewe-1', tag: 'YA-0007' },
  lambingId: 'lambing-1',
  at: '2027-03-02T21:40:00.000Z',
  date: '2027-03-03',
  lambs: [],
  penId: null,
  titles: { care: (n) => `care ${n}`, pen: 'pen' },
  ...over,
});

describe('what follows a lambing in the queue', () => {
  it('sends a care record per lamb with only what was done, then the pen', () => {
    const records = afterLambingRecords(
      input({
        lambs: [draft('lamb-1', { colostrum: true, navelTreated: true }), draft('lamb-2', { mothering: 'bottle' })],
        penId: 'pen-4',
      }),
    );
    expect(records.map((r) => [r.kind, r.path, r.body])).toEqual([
      ['lamb_care', '/livestock/lambs/lamb-1/care', { colostrumAt: '2027-03-02T21:40:00.000Z', navelTreated: true }],
      ['lamb_care', '/livestock/lambs/lamb-2/care', { mothering: 'bottle' }],
      ['pen_stay', '/livestock/pens/stays', { facilityId: 'pen-4', eweId: 'ewe-1', lambingId: 'lambing-1', sinceDate: '2027-03-03' }],
    ]);
    expect(records.map((r) => r.title)).toEqual(['care 1', 'care 2', 'pen']);
  });

  it('queues nothing for a lamb nothing was done for, so a later record is not overwritten', () => {
    expect(afterLambingRecords(input({ lambs: [draft('lamb-1'), draft('lamb-2', { navelTreated: true })] })).map((r) => r.path)).toEqual([
      '/livestock/lambs/lamb-2/care',
    ]);
    expect(afterLambingRecords(input({ lambs: [draft('lamb-1')] }))).toEqual([]);
  });

  it('names the foster ewe, and is not ready until she is chosen', () => {
    const waiting = [draft('lamb-1', { mothering: 'fostered' })];
    expect(careReady(waiting)).toBe(false);
    const chosen = [draft('lamb-1', { mothering: 'fostered', fosterEweId: 'ewe-9' })];
    expect(careReady(chosen)).toBe(true);
    expect(afterLambingRecords(input({ lambs: chosen }))[0].body).toEqual({ mothering: 'fostered', fosterEweId: 'ewe-9' });
    expect(careReady([draft('lamb-1'), draft('lamb-2', { mothering: 'bottle' })])).toBe(true);
  });

  it('waits behind the lambing of the same ewe when that one is stuck, and not behind another ewe', () => {
    const [care, pen] = afterLambingRecords(input({ lambs: [draft('lamb-1', { colostrum: true })], penId: 'pen-4' })).map((r, index) =>
      record({ ...r, photos: [], id: `after-${index}`, createdAt: 2 }),
    );
    const stuck = record({ id: 'lambing-1', status: 'stuck', meta: { tag: 'YA-0007', eweId: 'ewe-1' } });
    const other = record({ id: 'lambing-2', status: 'stuck', meta: { tag: 'YA-0008', eweId: 'ewe-2' } });
    expect(waitsFor(care, [stuck, care, pen])?.id).toBe('lambing-1');
    expect(waitsFor(pen, [stuck, care, pen])?.id).toBe('lambing-1');
    expect(waitsFor(care, [other, care, pen])).toBeUndefined();
  });
});

describe('the night-watch list and the queue', () => {
  it('marks a ewe as lambed while her record waits and after it is sent', () => {
    const records = [record({ meta: { tag: 'YA-0007', eweId: 'ewe-1' } }), record({ kind: 'weight', meta: { tag: 'YA-0002', eweId: 'ewe-2' } })];
    const sent = [{ kind: 'lambing', meta: { tag: 'YA-0003', eweId: 'ewe-3' } }] as unknown as SentRecord[];
    expect([...ewesLambed(records, sent)].sort()).toEqual(['ewe-1', 'ewe-3']);
    // A lambing queued by an older version of the app has no ewe id: it marks nobody.
    expect(ewesLambed([record({ meta: { tag: 'YA-0007' } })], []).size).toBe(0);
  });

  it('takes a pen off the free list as soon as a stay for it is queued', () => {
    const records = [record({ kind: 'pen_stay', meta: { tag: 'YA-0007', facilityId: 'pen-4' } })];
    const sent = [{ kind: 'pen_stay', meta: { facilityId: 'pen-5' } }] as unknown as SentRecord[];
    expect([...pensTaken(records, sent)].sort()).toEqual(['pen-4', 'pen-5']);
  });
});
