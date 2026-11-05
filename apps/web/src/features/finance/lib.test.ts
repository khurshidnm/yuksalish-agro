/**
 * Which actions the journal offers on an entry. The lists are checked against the API's own source,
 * so a screen cannot offer what the server refuses, or hide what it allows.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canDeleteEntry, canEditEntry, canVoidEntry } from './lib';
import type { Transaction } from './types';

const read = (path: string) => readFileSync(new URL(`../../../../api/src/${path}`, import.meta.url), 'utf8');
const ledger = read('core/ledger.ts');
const service = read('modules/finance/transactions.service.ts');

const released = /SOURCES_RELEASED_BY_CANCEL = \[([^\]]*)\]/.exec(ledger)?.[1].match(/[a-z_]+/g) ?? [];
const purchase = /purchase = row\.sourceType === '([a-z_]+)'/.exec(service)?.[1];
const prepared = /row\.sourceType !== '([a-z_]+)'/.exec(service)?.[1];

const entry = (status: Transaction['status'], sourceType: string | null, type: Transaction['type'] = 'expense') => ({ status, sourceType, type });

describe('sources read from the API', () => {
  it('finds them, so a change in how the API writes them cannot pass unnoticed', () => {
    expect(released.length).toBeGreaterThanOrEqual(4);
    expect(purchase).toBe('stock_batch');
    expect(prepared).toBe('ai_proposal');
  });
});

describe('void', () => {
  it('is offered for an approved entry of each source the server cancels', () => {
    for (const source of [null, prepared!, purchase!, ...released]) expect(canVoidEntry(entry('approved', source)), String(source)).toBe(true);
  });

  it('stays away from the sources the server refuses, and from anything not approved', () => {
    for (const source of ['loan', 'loan_instalment', 'sale', 'payroll_run']) expect(canVoidEntry(entry('approved', source)), source).toBe(false);
    for (const status of ['pending', 'rejected', 'draft'] as const) expect(canVoidEntry(entry(status, null)), status).toBe(false);
  });
});

describe('edit and delete', () => {
  it('are offered while an entry of finance or the assistant is waiting', () => {
    for (const source of [null, prepared!]) {
      expect(canEditEntry(entry('pending', source)), String(source)).toBe(true);
      expect(canDeleteEntry(entry('pending', source)), String(source)).toBe(true);
    }
  });

  it('stop once the entry is decided', () => {
    for (const status of ['approved', 'rejected'] as const) {
      expect(canEditEntry(entry(status, null)), status).toBe(false);
      expect(canDeleteEntry(entry(status, null)), status).toBe(false);
    }
  });

  it('leave the entries of other modules to those modules', () => {
    for (const source of [purchase!, ...released, 'loan']) {
      expect(canEditEntry(entry('pending', source)), source).toBe(false);
      expect(canDeleteEntry(entry('pending', source)), source).toBe(false);
    }
  });

  it('delete a waiting settlement, because it can only be entered again', () => {
    for (const type of ['debt_payment', 'debt_receipt'] as const) {
      expect(canEditEntry(entry('pending', null, type)), type).toBe(false);
      expect(canDeleteEntry(entry('pending', null, type)), type).toBe(true);
    }
  });
});
