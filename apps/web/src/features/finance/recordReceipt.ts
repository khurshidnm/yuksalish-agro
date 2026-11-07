import { z } from 'zod';
import { zDate, zOptionalDate, zOptionalRef } from '@/lib/forms';
import i18n from '@/lib/i18n';
import type { AccountOption } from './types';

export type RecordKind = 'payment' | 'debt';

const fields = z.object({
  date: zDate(),
  accountId: zOptionalRef(),
  dueDate: zOptionalDate(),
  categoryId: zOptionalRef(),
});

export type RecordFormIn = z.input<typeof fields>;
export type RecordFormOut = z.output<typeof fields>;

export const recordSchema = (kind: RecordKind, askCategory: boolean) =>
  fields.superRefine((values, ctx) => {
    const required = (path: string) => ctx.addIssue({ code: 'custom', path: [path], message: i18n.t('common:validation.required') });
    if (kind === 'payment' && !values.accountId) required('accountId');
    if (askCategory && !values.categoryId) required('categoryId');
  });

/** A debt arose the day the goods came. A payment is entered when the money moved, which is usually today. */
export const recordDate = (kind: RecordKind, receiptDate: string, today: string) => (kind === 'debt' ? receiptDate : today);

/** The value of a receipt is in the base currency, and a foreign account moves only its own. */
export const accountsFor = (accounts: AccountOption[], baseCurrency: string) => accounts.filter((a) => a.currency === baseCurrency);

/** A payment is made the way its account works, as when a debt is settled. */
export function recordPayload(kind: RecordKind, { date, accountId, dueDate, categoryId }: RecordFormOut, accounts: AccountOption[]) {
  if (kind === 'debt') return { paymentMethod: 'debt', date, dueDate, categoryId };
  return { paymentMethod: accounts.find((a) => a.id === accountId)?.type, accountId, date, categoryId };
}
