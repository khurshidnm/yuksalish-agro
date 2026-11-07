import { describe, expect, it } from 'vitest';
import type { AccountOption } from './types';
import { type RecordFormIn, accountsFor, recordDate, recordPayload, recordSchema } from './recordReceipt';

const till: AccountOption = { id: 'till', name: 'Kassa', type: 'cash', currency: 'UZS' };
const bank: AccountOption = { id: 'bank', name: 'Bank', type: 'bank', currency: 'UZS' };
const safe: AccountOption = { id: 'safe', name: 'Dollar seyf', type: 'cash', currency: 'USD' };

const form = (over: Partial<RecordFormIn> = {}): RecordFormIn => ({ date: '2026-11-05', accountId: null, dueDate: null, categoryId: null, ...over });

const problems = (schema: ReturnType<typeof recordSchema>, values: RecordFormIn) => {
  const parsed = schema.safeParse(values);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'));
};

describe('recording a receipt', () => {
  it('a payment needs an account, a debt does not', () => {
    expect(problems(recordSchema('payment', false), form())).toEqual(['accountId']);
    expect(problems(recordSchema('payment', false), form({ accountId: 'till' }))).toEqual([]);
    expect(problems(recordSchema('debt', false), form())).toEqual([]);
  });

  it('asks for a category only when the goods have none of their own', () => {
    expect(problems(recordSchema('debt', true), form())).toEqual(['categoryId']);
    expect(problems(recordSchema('debt', true), form({ categoryId: 'other' }))).toEqual([]);
  });

  it('a debt dates from the goods, a payment from today', () => {
    expect(recordDate('debt', '2026-10-30', '2026-11-05')).toBe('2026-10-30');
    expect(recordDate('payment', '2026-10-30', '2026-11-05')).toBe('2026-11-05');
  });

  it('offers only accounts that can move the base currency', () => {
    expect(accountsFor([till, safe, bank], 'UZS')).toEqual([till, bank]);
  });

  it('a payment goes the way its account works', () => {
    const accounts = [till, bank];
    expect(recordPayload('payment', recordSchema('payment', false).parse(form({ accountId: 'bank' })), accounts)).toMatchObject({ paymentMethod: 'bank', accountId: 'bank' });
    expect(recordPayload('payment', recordSchema('payment', false).parse(form({ accountId: 'till' })), accounts)).toMatchObject({ paymentMethod: 'cash', accountId: 'till' });
  });

  it('a debt carries its due date and no account', () => {
    const sent = recordPayload('debt', recordSchema('debt', false).parse(form({ accountId: 'till', dueDate: '2026-12-01' })), [till]);
    expect(sent).toEqual({ paymentMethod: 'debt', date: '2026-11-05', dueDate: '2026-12-01', categoryId: null });
  });

  it('a payment carries no due date', () => {
    const sent = recordPayload('payment', recordSchema('payment', false).parse(form({ accountId: 'till', dueDate: '2026-12-01' })), [till]);
    expect(sent).not.toHaveProperty('dueDate');
  });
});
