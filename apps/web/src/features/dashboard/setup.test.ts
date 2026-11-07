import { describe, expect, it } from 'vitest';
import { SETUP_STEPS, setupProgress } from './setup';

const counts = (value: number) => Object.fromEntries(SETUP_STEPS.map((step) => [step.key, value]));

describe('setupProgress', () => {
  it('an empty farm has every step open, in the order they have to be done', () => {
    const progress = setupProgress(SETUP_STEPS, counts(0));
    expect(progress.open.map((step) => step.key)).toEqual(['accounts', 'fields', 'warehouses', 'items', 'suppliers', 'stock', 'rations', 'herds', 'staff']);
    expect(progress).toMatchObject({ done: 0, total: 9, finished: false });
  });

  it('a step leaves the list once it is done', () => {
    const progress = setupProgress(SETUP_STEPS, { ...counts(0), warehouses: 1, items: 12 });
    expect(progress.open.map((step) => step.key)).not.toContain('warehouses');
    expect(progress.done).toBe(2);
  });

  it('the owner alone is not staff', () => {
    expect(setupProgress(SETUP_STEPS, { ...counts(3), staff: 1 }).open.map((step) => step.key)).toEqual(['staff']);
    expect(setupProgress(SETUP_STEPS, { ...counts(3), staff: 2 }).finished).toBe(true);
  });

  it('a list that did not answer hides its step, and nothing counts as finished for good', () => {
    const progress = setupProgress(SETUP_STEPS, { ...counts(3), fields: null });
    expect(progress.open).toEqual([]);
    expect(progress.finished).toBe(false);
  });

  it('a person sees only the steps they can do', () => {
    const allowed = SETUP_STEPS.filter((step) => step.access !== 'users.create');
    expect(setupProgress(allowed, counts(1))).toMatchObject({ total: 8, finished: true });
  });

  it('a farm with no supplier is told so, and a storekeeper is not given a step only finance can do', () => {
    expect(setupProgress(SETUP_STEPS, { ...counts(3), suppliers: 0 }).open.map((step) => step.key)).toEqual(['suppliers']);
    expect(SETUP_STEPS.find((step) => step.key === 'suppliers')).toMatchObject({ source: '/finance/counterparties', access: 'finance.create' });
  });
});
