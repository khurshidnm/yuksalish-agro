import { COST_TREATMENTS, CURRENCIES, todayIso } from '@yap/shared';
import { Loader2, Paperclip, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ComboboxField, DateField, FormDialog, FormField, FormGrid, NumberField, SelectField, TextField } from '@/components';
import { Button, Label, Switch, apiOptions } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { zDate, zEnum, zOptionalDate, zOptionalNumber, zOptionalRef, zOptionalText, zPositive } from '@/lib/forms';
import i18n, { enumOptions } from '@/lib/i18n';
import { errorMessage, useApiMutation, useDetail } from '@/lib/query';
import { FINANCE_PATHS, MONEY_QUERIES, useCenterName, useLocalName } from './lib';
import type { AccountOption, CategoryOption, CostCenterOption, Transaction } from './types';

const TYPES = ['expense', 'income', 'transfer'] as const;
type EntryType = (typeof TYPES)[number];

const schema = z
  .object({
    type: zEnum(TYPES),
    date: zDate(),
    amount: zPositive(),
    currency: zEnum(CURRENCIES),
    fxRate: zOptionalNumber(),
    onCredit: z.boolean(),
    accountId: zOptionalRef(),
    toAccountId: zOptionalRef(),
    categoryId: zOptionalRef(),
    counterpartyId: zOptionalRef(),
    costCenterId: zOptionalRef(),
    costTreatment: zEnum(COST_TREATMENTS),
    dueDate: zOptionalDate(),
    description: zOptionalText(500),
    fileId: zOptionalRef(),
  })
  .superRefine((v, ctx) => {
    const need = (ok: unknown, path: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [path], message: i18n.t('common:validation.required') });
    };
    if (v.type === 'transfer') {
      need(v.accountId, 'accountId');
      need(v.toAccountId, 'toAccountId');
      return;
    }
    need(v.categoryId, 'categoryId');
    need(v.costCenterId, 'costCenterId');
    if (v.onCredit) need(v.counterpartyId, 'counterpartyId');
    else need(v.accountId, 'accountId');
  });

type FormValues = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;

export interface TransactionFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: Transaction | null;
  defaultType?: EntryType;
}

function toForm(row: Transaction): FormValues {
  return {
    type: row.type as EntryType,
    date: row.date,
    amount: row.amount,
    currency: row.currency as FormValues['currency'],
    fxRate: row.currency === 'UZS' ? null : row.fxRate,
    onCredit: row.paymentMethod === 'debt',
    accountId: row.accountId,
    toAccountId: row.toAccountId,
    categoryId: row.categoryId,
    counterpartyId: row.counterpartyId,
    costCenterId: row.costCenterId,
    costTreatment: row.costTreatment as FormValues['costTreatment'],
    dueDate: row.dueDate,
    description: row.description,
    fileId: row.fileId,
  };
}

/** Payment method follows from the account chosen, so nobody has to answer the same thing twice. */
function toPayload(values: FormOutput, accounts: AccountOption[]) {
  const { onCredit, ...rest } = values;
  const account = accounts.find((a) => a.id === values.accountId);
  const method = account?.type ?? 'cash';
  if (values.type === 'transfer') {
    return { ...rest, paymentMethod: method, categoryId: null, costCenterId: null, counterpartyId: null, dueDate: null };
  }
  return onCredit
    ? { ...rest, paymentMethod: 'debt', accountId: null, toAccountId: null }
    : { ...rest, paymentMethod: method, toAccountId: null, dueDate: null };
}

function AttachmentInput({ value, onChange, name }: { value: string | null; onChange: (id: string | null) => void; name: string | null }) {
  const { t } = useTranslation('finance');
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [fileName, setFileName] = useState(name);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const uploaded = await api.upload(file);
      onChange(uploaded.id);
      setFileName(uploaded.name);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      {value ? (
        <div className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm">
          <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{fileName ?? t('journal.attached')}</span>
          <Button variant="ghost" size="icon-sm" aria-label={t('journal.removeFile')} onClick={() => onChange(null)}>
            <X aria-hidden />
          </Button>
        </div>
      ) : (
        <Button variant="outline" onClick={() => input.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="animate-spin" aria-hidden /> : <Paperclip aria-hidden />}
          {t('journal.attach')}
        </Button>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}

function Fields({
  form,
  accounts,
  categories,
  editing,
}: {
  form: UseFormReturn<FormValues, unknown, FormOutput>;
  accounts: AccountOption[];
  categories: CategoryOption[];
  editing?: Transaction | null;
}) {
  const { t } = useTranslation('finance');
  const localName = useLocalName();
  const centerName = useCenterName();
  const session = useSession();
  const baseCurrency = session.tenant?.currency ?? 'UZS';

  const type = form.watch('type');
  const onCredit = form.watch('onCredit');
  const currency = form.watch('currency');
  const treatment = form.watch('costTreatment');
  const isTransfer = type === 'transfer';

  const accountOptions = useMemo(
    () =>
      accounts.map((a) => {
        const kind = t(`enums:accountType.${a.type}`);
        return { value: a.id, label: a.name === kind ? a.name : `${a.name} (${kind})` };
      }),
    [accounts, t],
  );
  const categoryOptions = useMemo(
    () =>
      categories
        .filter((c) => c.kind === type)
        .map((c) => ({
          value: c.id,
          label: localName(c.name),
          hint: t(`enums:${c.kind === 'expense' ? 'expenseGroup' : 'incomeGroup'}.${c.group}`),
        })),
    [categories, type, localName, t],
  );

  return (
    <>
      <div role="radiogroup" aria-label={t('journal.fields.type')} className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
        {TYPES.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={type === value}
            disabled={Boolean(editing)}
            onClick={() => {
              form.setValue('type', value);
              form.setValue('categoryId', null);
            }}
            className={`focus-ring min-h-11 rounded-md px-2 text-sm font-medium transition-colors ${
              type === value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(`enums:transactionType.${value}`)}
          </button>
        ))}
      </div>

      <FormGrid>
        <DateField form={form} name="date" label={t('journal.fields.date')} required />
        <div className="grid grid-cols-[1fr_6rem] gap-2">
          <NumberField money form={form} name="amount" label={t('journal.fields.amount')} required />
          <SelectField form={form} name="currency" label={t('journal.fields.currency')} options={enumOptions('currency', CURRENCIES)} />
        </div>
      </FormGrid>

      {currency !== baseCurrency && (
        <NumberField money form={form} name="fxRate" label={t('journal.fields.fxRate')} hint={t('journal.fxHint')} maxDigits={4} />
      )}

      {isTransfer ? (
        <FormGrid>
          <SelectField form={form} name="accountId" label={t('journal.fields.fromAccount')} required options={accountOptions} placeholder={t('journal.chooseAccount')} />
          <SelectField form={form} name="toAccountId" label={t('journal.fields.toAccount')} required options={accountOptions} placeholder={t('journal.chooseAccount')} />
        </FormGrid>
      ) : (
        <>
          <ComboboxField
            form={form}
            name="categoryId"
            label={t('journal.fields.category')}
            required
            options={categoryOptions}
            placeholder={t('journal.chooseCategory')}
            selectedLabel={editing?.categoryName ? localName(editing.categoryName) : undefined}
          />
          <ComboboxField
            form={form}
            name="costCenterId"
            label={t('journal.fields.costCenter')}
            required
            loadOptions={apiOptions<CostCenterOption>('/finance/cost-centers/lookup', (c) => ({
              value: c.id,
              label: centerName(c.name, c.type),
              hint: t(`enums:costCenterType.${c.type}`),
            }))}
            selectedLabel={editing ? centerName(editing.costCenterName, editing.costCenterType) : undefined}
            placeholder={t('journal.chooseCostCenter')}
          />
          {type === 'expense' && (
            <SelectField
              form={form}
              name="costTreatment"
              label={t('journal.fields.costTreatment')}
              hint={t(`journal.treatmentHint.${treatment}`)}
              options={enumOptions('costTreatment', COST_TREATMENTS)}
            />
          )}
          <div className="flex min-h-11 items-center justify-between gap-3">
            <Label htmlFor="tx-on-credit">{t('journal.fields.onCredit')}</Label>
            <Switch id="tx-on-credit" checked={onCredit} onCheckedChange={(checked) => form.setValue('onCredit', checked)} />
          </div>
          {onCredit ? (
            <DateField form={form} name="dueDate" label={t('journal.fields.dueDate')} />
          ) : (
            <SelectField form={form} name="accountId" label={t('journal.fields.account')} required options={accountOptions} placeholder={t('journal.chooseAccount')} />
          )}
          <ComboboxField
            form={form}
            name="counterpartyId"
            label={t('journal.fields.counterparty')}
            required={onCredit}
            loadOptions={apiOptions<{ id: string; name: string; type: string }>('/finance/counterparties/lookup', (c) => ({
              value: c.id,
              label: c.name,
              hint: t(`enums:counterpartyType.${c.type}`),
            }))}
            selectedLabel={editing?.counterpartyName}
            placeholder={t('journal.chooseCounterparty')}
          />
        </>
      )}

      <TextField form={form} name="description" label={t('journal.fields.description')} />
      <FormField form={form} name="fileId" label={t('journal.fields.file')}>
        {(field) => <AttachmentInput value={field.value ?? null} onChange={field.onChange} name={null} />}
      </FormField>
    </>
  );
}

/**
 * Money entry. Remembers date, account and cost center between entries, and "add another" keeps
 * the form open, because a pile of receipts is usually typed in one sitting.
 */
export function TransactionFormDialog({ open, onOpenChange, editing, defaultType = 'expense' }: TransactionFormDialogProps) {
  const { t } = useTranslation('finance');
  const session = useSession();
  const accounts = useDetail<AccountOption[]>('/finance/accounts/lookup', undefined, { enabled: open }).data ?? [];
  const categories = useDetail<CategoryOption[]>('/finance/categories', undefined, { enabled: open }).data ?? [];

  const [addAnother, setAddAnother] = useState(false);
  const [round, setRound] = useState(0);
  const justSaved = useRef(false);
  const last = useRef<Partial<FormValues>>({});

  const save = useApiMutation<FormOutput, Transaction>({
    mutationFn: (values) => {
      const payload = toPayload(values, accounts);
      return editing
        ? api.patch(`${FINANCE_PATHS.transactions}/${editing.id}`, { ...payload, baseUpdatedAt: editing.updatedAt })
        : api.postOnce(FINANCE_PATHS.transactions, payload);
    },
    invalidate: MONEY_QUERIES,
    silentError: true,
    onSuccess: (_, values) => {
      justSaved.current = true;
      last.current = { type: values.type, date: values.date, accountId: values.accountId, costCenterId: values.costCenterId };
    },
  });

  const defaults: FormValues = editing
    ? toForm(editing)
    : {
        type: defaultType,
        date: todayIso(),
        amount: undefined as unknown as number,
        currency: (session.tenant?.currency ?? 'UZS') as FormValues['currency'],
        fxRate: null,
        onCredit: false,
        accountId: null,
        toAccountId: null,
        categoryId: null,
        counterpartyId: null,
        costCenterId: null,
        costTreatment: 'expense',
        dueDate: null,
        description: null,
        fileId: null,
        ...last.current,
      };

  const handleOpenChange = (next: boolean) => {
    if (!next && justSaved.current && addAnother && !editing) {
      // Remounting gives a clean form, with the remembered fields already filled in.
      justSaved.current = false;
      setRound((value) => value + 1);
      return;
    }
    justSaved.current = false;
    onOpenChange(next);
  };

  return (
    <FormDialog
      key={round}
      open={open}
      onOpenChange={handleOpenChange}
      title={editing ? t('journal.edit') : t('journal.add')}
      description={editing ? undefined : t('journal.addHint')}
      schema={schema}
      defaultValues={defaults}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
      size="lg"
    >
      {(form) => (
        <>
          <Fields form={form} accounts={accounts} categories={categories} editing={editing} />
          {!editing && (
            <div className="flex min-h-11 items-center justify-between gap-3 border-t border-border pt-3">
              <Label htmlFor="tx-add-another">{t('journal.addAnother')}</Label>
              <Switch id="tx-add-another" checked={addAnother} onCheckedChange={setAddAnother} />
            </div>
          )}
        </>
      )}
    </FormDialog>
  );
}
