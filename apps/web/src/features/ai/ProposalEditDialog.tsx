import { useMemo } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ComboboxField, DateField, FormDialog, FormGrid, NumberField, SelectField, TextField } from '@/components';
import { apiOptions } from '@/components/ui';
import { accountLabel, useCenterName, useLocalName } from '@/features/finance/lib';
import type { AccountOption, CategoryOption, CostCenterOption } from '@/features/finance/types';
import { itemOptions, useWarehouseOptions } from '@/features/inventory/shared';
import { useSession } from '@/lib/auth';
import { currencyLabel, formatNumber } from '@/lib/format';
import { zDate, zOptionalNumber, zOptionalRef, zOptionalText, zPositive } from '@/lib/forms';
import { useDetail } from '@/lib/query';
import { canSendForm, categoryLabel, changedFields } from './proposals';
import type { ProposalView } from './types';

/** Payment is one choice, an account or "on credit", so a method and an account can never disagree. */
const ON_CREDIT = 'debt';

const schema = z.object({
  amount: zPositive(),
  date: zDate(),
  categoryId: zOptionalRef(),
  costCenterId: zOptionalRef(),
  accountId: zOptionalRef(),
  toAccountId: zOptionalRef(),
  counterpartyId: zOptionalRef(),
  itemId: zOptionalRef(),
  warehouseId: zOptionalRef(),
  qty: zOptionalNumber(),
  description: zOptionalText(200),
});

export type ProposalFormValues = z.input<typeof schema>;
type FormOut = z.output<typeof schema>;

function toForm({ fields }: ProposalView): ProposalFormValues {
  return {
    // Only a masked card has no amount, and that one has no form.
    amount: fields.amount as number,
    date: fields.date,
    categoryId: fields.category?.id ?? null,
    costCenterId: fields.target?.costCenterId ?? null,
    accountId: fields.paymentMethod === 'debt' ? ON_CREDIT : (fields.account?.id ?? null),
    toAccountId: fields.toAccount?.id ?? null,
    counterpartyId: fields.counterparty?.id ?? null,
    itemId: fields.item?.id ?? null,
    warehouseId: fields.warehouse?.id ?? null,
    qty: fields.qty,
    description: fields.description,
  };
}

/** What PATCH takes: no nulls, and the payment choice split back into its two fields. */
function toChanges(before: ProposalFormValues, values: FormOut, accounts: AccountOption[]): Record<string, unknown> {
  const { description, accountId, ...changed } = changedFields(before as Record<string, unknown>, values as Record<string, unknown>);
  const changes: Record<string, unknown> = Object.fromEntries(Object.entries(changed).filter(([, value]) => value !== null));
  // The API takes an empty text as "no note"; it has no way to receive null.
  if (description !== undefined) changes.description = description ?? '';
  if (accountId === ON_CREDIT) changes.paymentMethod = 'debt';
  else if (accountId) {
    changes.accountId = accountId;
    const account = accounts.find((a) => a.id === accountId);
    if (account) changes.paymentMethod = account.type;
  }
  return changes;
}

function Fields({ form, proposal }: { form: UseFormReturn<ProposalFormValues, unknown, FormOut>; proposal: ProposalView }) {
  const { t } = useTranslation('ai');
  const localName = useLocalName();
  const centerName = useCenterName();
  const { kind, fields } = proposal;
  const isStock = kind === 'stock_purchase';
  const isTransfer = kind === 'transfer';
  const hasCategory = fields.category !== null;
  const hasTarget = fields.target !== null;
  const foreign = fields.fxRate !== null && fields.currency !== (useSession().tenant?.currency ?? 'UZS');

  const accounts = useDetail<AccountOption[]>('/finance/accounts/lookup').data ?? [];
  const categories = useDetail<CategoryOption[]>(hasCategory ? '/finance/categories' : null).data ?? [];
  const warehouses = useWarehouseOptions();

  const accountOptions = useMemo(() => {
    const options = accounts.map((a) => {
      const type = t(`enums:accountType.${a.type}`);
      const name = accountLabel(a);
      return { value: a.id, label: name === type ? name : `${name} (${type})` };
    });
    return options.length > 0 ? options : [fields.account, fields.toAccount].flatMap((a) => (a ? [{ value: a.id, label: a.name }] : []));
  }, [accounts, fields.account, fields.toAccount, t]);
  const categoryOptions = useMemo(
    () =>
      categories
        .filter((c) => c.kind === (kind === 'income' ? 'income' : 'expense'))
        .map((c) => ({ value: c.id, label: localName(c.name) })),
    [categories, kind, localName],
  );

  return (
    <>
      <FormGrid>
        <NumberField money form={form} name="amount" label={t('records.fields.amount')} suffix={currencyLabel(fields.currency)} required />
        <DateField form={form} name="date" label={t('records.fields.date')} required />
      </FormGrid>
      {foreign && (
        <p className="text-sm text-muted-foreground">
          {t('records.card.fxRate', { currency: currencyLabel(fields.currency), rate: formatNumber(fields.fxRate, 4), base: currencyLabel() })}
        </p>
      )}

      {hasCategory && (
        <ComboboxField
          form={form}
          name="categoryId"
          label={t('records.fields.category')}
          options={categoryOptions}
          selectedLabel={fields.category ? categoryLabel(fields.category, localName) : undefined}
          clearable={false}
        />
      )}
      {hasTarget && (
        <ComboboxField
          form={form}
          name="costCenterId"
          label={t('records.fields.target')}
          loadOptions={apiOptions<CostCenterOption>('/finance/cost-centers/lookup', (c) => ({
            value: c.id,
            label: centerName(c.name, c.type),
            hint: t(`enums:costCenterType.${c.type}`),
          }))}
          selectedLabel={fields.target ? centerName(fields.target.name, fields.target.type) : undefined}
          clearable={false}
        />
      )}

      {isStock && (
        <>
          <ComboboxField form={form} name="itemId" label={t('records.fields.item')} loadOptions={itemOptions()} selectedLabel={fields.item?.name} clearable={false} />
          <SelectField form={form} name="warehouseId" label={t('records.fields.warehouse')} options={warehouses} />
          <NumberField form={form} name="qty" label={t('records.fields.qty')} hint={t('records.edit.unitPriceHint')} maxDigits={3} />
        </>
      )}

      {isTransfer ? (
        <FormGrid>
          <SelectField form={form} name="accountId" label={t('records.fields.fromAccount')} options={accountOptions} />
          <SelectField form={form} name="toAccountId" label={t('records.fields.toAccount')} options={accountOptions} />
        </FormGrid>
      ) : (
        <SelectField
          form={form}
          name="accountId"
          label={t('records.fields.account')}
          options={kind === 'debt_payment' ? accountOptions : [...accountOptions, { value: ON_CREDIT, label: t('enums:paymentMethod.debt') }]}
        />
      )}

      {!isTransfer && (
        <ComboboxField
          form={form}
          name="counterpartyId"
          label={t('records.fields.counterparty')}
          loadOptions={apiOptions<{ id: string; name: string; type: string }>('/finance/counterparties/lookup', (c) => ({
            value: c.id,
            label: c.name,
            hint: t(`enums:counterpartyType.${c.type}`),
          }))}
          selectedLabel={fields.counterparty?.name}
          clearable={false}
        />
      )}
      {fields.direction && (
        <p className="text-sm">
          <span className="text-muted-foreground">{t('records.fields.direction')}: </span>
          <span className="font-medium">{t(`records.direction.${fields.direction}`)}</span>
        </p>
      )}

      <TextField form={form} name="description" label={t('records.fields.description')} maxLength={200} />
    </>
  );
}

/** Corrects a prepared record. Only changed fields are sent, and the server re-checks all of it. */
export function ProposalEditDialog({
  proposal,
  open,
  onOpenChange,
  values,
  recheck,
  onSave,
}: {
  proposal: ProposalView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the person typed last time, when the server came back with a question instead of saving. */
  values?: ProposalFormValues;
  /** The card went stale. Saving must ask the server again, even when nothing was typed. */
  recheck: boolean;
  onSave: (changes: Record<string, unknown>, values: ProposalFormValues) => Promise<unknown>;
}) {
  const { t } = useTranslation('ai');
  const before = toForm(proposal);
  const accounts = useDetail<AccountOption[]>(open ? '/finance/accounts/lookup' : null).data ?? [];
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('records.edit.title')}
      description={t('records.edit.description')}
      schema={schema}
      defaultValues={values ?? before}
      submitLabel={t('records.edit.save')}
      onSubmit={async (submitted) => {
        const changes = toChanges(before, submitted, accounts);
        if (canSendForm(changes, recheck)) await onSave(changes, submitted);
      }}
    >
      {(form) => <Fields form={form} proposal={proposal} />}
    </FormDialog>
  );
}
