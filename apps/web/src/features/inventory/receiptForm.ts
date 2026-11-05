import { z } from 'zod';
import { zDate, zEnum, zNonNegative, zOptionalDate, zOptionalNumber, zOptionalRef, zOptionalText, zPositive, zRef } from '@/lib/forms';
import i18n from '@/lib/i18n';

export const SOURCES = ['purchase', 'opening', 'return'] as const;
export const METHODS = ['cash', 'bank', 'card', 'debt'] as const;

/** Item kinds the API posts to an expense category on its own. Any other kind needs a person to choose one. */
const KINDS_WITH_A_CATEGORY = ['feed', 'seed', 'fertilizer', 'chemical', 'vet_drug', 'vaccine', 'fuel', 'lubricant', 'spare_part'];

export const needsCategory = (lines: ({ itemCategory?: string | null } | undefined)[]) =>
  lines.some((line) => line?.itemCategory && !KINDS_WITH_A_CATEGORY.includes(line.itemCategory));

/** Paid on the spot, nothing is owed to anyone, so the supplier may stay unnamed. */
export const supplierRequired = (values: { source: string; pay: boolean; paymentMethod: string }) =>
  values.source === 'purchase' && (!values.pay || values.paymentMethod === 'debt');

export const receiptSchema = z
  .object({
    warehouseId: zRef(),
    date: zDate(),
    source: zEnum(SOURCES),
    counterpartyId: zOptionalRef(),
    invoiceNo: zOptionalText(60),
    currency: z.string(),
    fxRate: zOptionalNumber(),
    notes: zOptionalText(1000),
    lines: z
      .array(
        z.object({
          itemId: zRef(),
          itemCategory: z.string().nullish(),
          unit: z.string().nullish(),
          qty: zPositive(),
          unitCost: zNonNegative(),
          batchNo: zOptionalText(60),
          expiryDate: zOptionalDate(),
        }),
      )
      .min(1),
    pay: z.boolean(),
    paymentMethod: zEnum(METHODS),
    accountId: zOptionalRef(),
    categoryId: zOptionalRef(),
    dueDate: zOptionalDate(),
  })
  .superRefine((values, ctx) => {
    const required = (path: string) => ctx.addIssue({ code: 'custom', path: [path], message: i18n.t('common:validation.required') });
    if (supplierRequired(values) && !values.counterpartyId) required('counterpartyId');
    // Payment fields only show for a purchase, so a hidden one must never block saving.
    if (values.source !== 'purchase' || !values.pay) return;
    if (values.paymentMethod !== 'debt' && !values.accountId) required('accountId');
    if (needsCategory(values.lines) && !values.categoryId) required('categoryId');
  });

export type ReceiptFormIn = z.input<typeof receiptSchema>;
export type ReceiptFormOut = z.output<typeof receiptSchema>;

export function toPayload({ pay, paymentMethod, accountId, categoryId, dueDate, lines, currency, fxRate, counterpartyId, invoiceNo, ...rest }: ReceiptFormOut, baseCurrency: string) {
  // Supplier, currency and payment apply to a purchase only. They keep their values if the
  // user switched the type after filling them in, so they are dropped here.
  const purchase = rest.source === 'purchase';
  const onDebt = paymentMethod === 'debt';
  return {
    ...rest,
    lines: lines.map(({ unit: _unit, itemCategory: _itemCategory, ...line }) => line),
    ...(purchase ? { counterpartyId, invoiceNo } : {}),
    ...(purchase && currency !== baseCurrency ? { currency, fxRate } : {}),
    ...(purchase && pay ? { payment: { paymentMethod, accountId: onDebt ? null : accountId, categoryId, dueDate: onDebt ? dueDate : null } } : {}),
  };
}
