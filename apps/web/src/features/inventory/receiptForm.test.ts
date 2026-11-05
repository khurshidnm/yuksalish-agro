import { readFileSync } from 'node:fs';
import { ITEM_CATEGORIES } from '@yap/shared';
import { describe, expect, it } from 'vitest';
import { type ReceiptFormIn, needsCategory, receiptSchema, toPayload } from './receiptForm';

const stockService = readFileSync(new URL('../../../../api/src/modules/inventory/stock.service.ts', import.meta.url), 'utf8');
const kindsWithACategory = /CATEGORY_BY_ITEM[^=]*= \{([^}]*)\}/.exec(stockService)?.[1].match(/^\s*([a-z_]+):/gm)?.map((key) => key.trim().slice(0, -1)) ?? [];

const line = (itemCategory: string) => ({ itemId: 'item', itemCategory, unit: 'kg', qty: 2, unitCost: 1000 });

const receipt = (over: Partial<ReceiptFormIn> = {}): ReceiptFormIn => ({
  warehouseId: 'warehouse',
  date: '2026-11-05',
  source: 'purchase',
  counterpartyId: null,
  invoiceNo: '',
  currency: 'UZS',
  fxRate: null,
  notes: '',
  lines: [line('feed')],
  pay: false,
  paymentMethod: 'cash',
  accountId: null,
  categoryId: null,
  dueDate: null,
  ...over,
});

const problems = (values: ReceiptFormIn) => {
  const parsed = receiptSchema.safeParse(values);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'));
};

const payload = (values: ReceiptFormIn) => toPayload(receiptSchema.parse(values), 'UZS');

describe('the supplier', () => {
  it('may stay unnamed when the goods are paid on the spot', () => {
    expect(problems(receipt({ pay: true, paymentMethod: 'cash', accountId: 'cash' }))).toEqual([]);
    expect(problems(receipt({ pay: true, paymentMethod: 'bank', accountId: 'bank' }))).toEqual([]);
  });

  it('is required on debt, and when nothing is paid yet, because someone is then owed', () => {
    expect(problems(receipt({ pay: true, paymentMethod: 'debt' }))).toEqual(['counterpartyId']);
    expect(problems(receipt())).toEqual(['counterpartyId']);
    expect(problems(receipt({ pay: true, paymentMethod: 'debt', counterpartyId: 'supplier' }))).toEqual([]);
  });

  it('is not asked for what is not a purchase', () => {
    expect(problems(receipt({ source: 'opening' }))).toEqual([]);
    expect(problems(receipt({ source: 'return', pay: true, paymentMethod: 'debt' }))).toEqual([]);
  });
});

describe('the expense category', () => {
  it('is asked for exactly the item kinds the API has no default for', () => {
    expect(kindsWithACategory.length).toBeGreaterThanOrEqual(9);
    for (const kind of ITEM_CATEGORIES) expect(needsCategory([{ itemCategory: kind }]), kind).toBe(!kindsWithACategory.includes(kind));
  });

  it('is not asked before an item is chosen', () => {
    expect(needsCategory([undefined, { itemCategory: null }, {}])).toBe(false);
  });

  it('is required when the money is recorded for an item with no default, on any line, cash or debt', () => {
    const lines = [line('feed'), line('product')];
    expect(problems(receipt({ lines, pay: true, accountId: 'cash' }))).toEqual(['categoryId']);
    expect(problems(receipt({ lines, pay: true, paymentMethod: 'debt', counterpartyId: 'supplier' }))).toEqual(['categoryId']);
    expect(problems(receipt({ lines, pay: true, accountId: 'cash', categoryId: 'other' }))).toEqual([]);
  });

  it('is not asked when no money is recorded', () => {
    expect(problems(receipt({ lines: [line('product')], counterpartyId: 'supplier' }))).toEqual([]);
    expect(problems(receipt({ lines: [line('product')], source: 'opening', pay: true }))).toEqual([]);
  });

  it('travels with the payment', () => {
    const sent = payload(receipt({ lines: [line('product')], pay: true, accountId: 'cash', categoryId: 'other' }));
    expect(sent.payment).toEqual({ paymentMethod: 'cash', accountId: 'cash', categoryId: 'other', dueDate: null });
  });
});

describe('what the server receives', () => {
  it('leaves out what only the form needs', () => {
    expect(payload(receipt({ counterpartyId: 'supplier' })).lines).toEqual([{ itemId: 'item', qty: 2, unitCost: 1000, batchNo: null, expiryDate: null }]);
  });

  it('sends no payment that the type or the switch took away', () => {
    expect(payload(receipt({ counterpartyId: 'supplier', accountId: 'cash', categoryId: 'other' }))).not.toHaveProperty('payment');
    expect(payload(receipt({ source: 'opening', pay: true, accountId: 'cash' }))).not.toHaveProperty('payment');
  });

  it('keeps an account off a debt and a due date off a payment made on the spot', () => {
    const debt = payload(receipt({ counterpartyId: 'supplier', pay: true, paymentMethod: 'debt', accountId: 'cash', dueDate: '2026-12-01' }));
    expect(debt.payment).toMatchObject({ accountId: null, dueDate: '2026-12-01' });
    const paid = payload(receipt({ pay: true, accountId: 'cash', dueDate: '2026-12-01' }));
    expect(paid.payment).toMatchObject({ accountId: 'cash', dueDate: null });
  });
});
