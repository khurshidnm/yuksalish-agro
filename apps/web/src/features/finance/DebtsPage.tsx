import { todayIso } from '@yap/shared';
import { HandCoins, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import {
  type Column,
  DataTableView,
  DateField,
  FormDialog,
  FormGrid,
  MoneyText,
  NumberField,
  PageHeader,
  SelectField,
  StatCard,
  TextField,
  UrlTabs,
} from '@/components';
import { Alert, Badge, Button, Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission, useSession } from '@/lib/auth';
import { currencyLabel, formatDate, formatMoney } from '@/lib/format';
import { zDate, zOptionalText, zPositive, zRef } from '@/lib/forms';
import { useApiMutation, useDetail, useList } from '@/lib/query';
import { FINANCE_PATHS, MONEY_QUERIES } from './lib';
import type { AccountOption, Aging, CounterpartyDebt, DebtSummary, UnpaidReceipt } from './types';
import { UnpaidReceiptList } from './UnpaidReceipts';

const PATH = FINANCE_PATHS.debts;

const settleSchema = z.object({
  amount: zPositive(),
  date: zDate(),
  accountId: zRef(),
  description: zOptionalText(500),
});

const AGING_KEYS: (keyof Aging)[] = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90Plus'];

/** What can still be paid: what is owed, minus settlements already waiting for approval. */
const payable = (debt: CounterpartyDebt) => Math.max(0, debt.outstanding - debt.pendingSettlement);

function SettleFields({
  form,
  accounts,
  owed,
  baseCurrency,
}: {
  form: UseFormReturn<z.input<typeof settleSchema>, unknown, z.output<typeof settleSchema>>;
  accounts: AccountOption[];
  owed: number | null;
  baseCurrency: string;
}) {
  const { t } = useTranslation('finance');
  // The API reads the amount in the currency of the account it comes from.
  const currency = accounts.find((a) => a.id === form.watch('accountId'))?.currency;
  const foreign = currency !== undefined && currency !== baseCurrency;

  // What is owed is a base currency figure, so it must not stand as an amount in another currency.
  useEffect(() => {
    if (foreign && form.getValues('amount') === owed) form.setValue('amount', null as unknown as number);
  }, [foreign, form, owed]);

  return (
    <>
      <FormGrid>
        <NumberField money
          form={form}
          name="amount"
          label={t('journal.fields.amount')}
          required
          suffix={currency && currencyLabel(currency)}
          hint={foreign ? t('debts.amountInAccountCurrency', { currency: currencyLabel(currency) }) : undefined}
        />
        <DateField form={form} name="date" label={t('journal.fields.date')} required />
      </FormGrid>
      <SelectField
        form={form}
        name="accountId"
        label={t('journal.fields.account')}
        required
        options={accounts.map((a) => ({ value: a.id, label: `${a.name} (${currencyLabel(a.currency)})` }))}
        placeholder={t('journal.chooseAccount')}
      />
      <TextField form={form} name="description" label={t('journal.fields.description')} />
    </>
  );
}

function SettleDialog({ debt, onClose }: { debt: CounterpartyDebt | null; onClose: () => void }) {
  const { t } = useTranslation('finance');
  const baseCurrency = useSession().tenant?.currency ?? 'UZS';
  const accounts = useDetail<AccountOption[]>('/finance/accounts/lookup', undefined, { enabled: debt !== null }).data ?? [];
  const settle = useApiMutation<z.output<typeof settleSchema>>({
    mutationFn: (values) =>
      api.postOnce(`${PATH}/settle`, { ...values, counterpartyId: debt?.counterpartyId, direction: debt?.direction }),
    invalidate: MONEY_QUERIES,
    silentError: true,
  });

  return (
    <FormDialog
      open={debt !== null}
      onOpenChange={(open) => !open && onClose()}
      title={debt?.direction === 'payable' ? t('debts.pay') : t('debts.receive')}
      description={debt ? t('debts.settleHint', { name: debt.counterpartyName, amount: formatMoney(debt ? payable(debt) : 0) }) : undefined}
      schema={settleSchema}
      // The amount offered is what is owed, which is kept in the base currency.
      defaultValues={{ amount: debt ? payable(debt) : undefined, date: todayIso(), accountId: accounts.find((a) => a.currency === baseCurrency)?.id ?? '' }}
      onSubmit={(values) => settle.mutateAsync(values)}
      successMessage="common:toast.created"
    >
      {(form) => <SettleFields form={form} accounts={accounts} owed={debt ? payable(debt) : null} baseCurrency={baseCurrency} />}
    </FormDialog>
  );
}

function DebtSheet({ debt, onClose, onSettle }: { debt: CounterpartyDebt | null; onClose: () => void; onSettle?: () => void }) {
  const { t } = useTranslation('finance');
  return (
    <Sheet open={debt !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full max-w-lg overflow-y-auto p-5">
        <SheetTitle className="text-lg font-semibold">{debt?.counterpartyName}</SheetTitle>
        <SheetDescription className="text-sm text-muted-foreground">{debt && t(`debts.direction.${debt.direction}`)}</SheetDescription>
        {debt && (
          <div className="mt-4 flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground">{t('debts.outstanding')}</p>
                <p className="text-lg font-semibold">
                  <MoneyText value={debt.outstanding} />
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">{t('debts.overdue')}</p>
                <p className="text-lg font-semibold">
                  <MoneyText value={debt.overdue} className={debt.overdue > 0 ? 'text-danger' : undefined} />
                </p>
              </div>
            </div>
            {debt.pendingSettlement > 0 && (
              <Alert tone="info">{t('debts.pendingSettlement', { amount: formatMoney(debt.pendingSettlement) })}</Alert>
            )}
            <div>
              <h3 className="mb-2 text-sm font-medium">{t('debts.aging')}</h3>
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                {AGING_KEYS.map((key) => (
                  <div key={key} className="contents">
                    <dt className="text-muted-foreground">{t(`debts.agingBucket.${key}`)}</dt>
                    <dd className="text-right tabular-nums">{formatMoney(debt.aging[key])}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium">{t('debts.documents')}</h3>
              <ul className="divide-y divide-border">
                {debt.documents.map((doc) => (
                  <li key={doc.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate">{doc.description ?? formatDate(doc.date)}</span>
                      <span className="block text-muted-foreground">
                        {doc.dueDate ? t('debts.dueOn', { date: formatDate(doc.dueDate) }) : t('debts.noDueDate')}
                      </span>
                      {doc.daysOverdue > 0 && (
                        <Badge variant="danger" className="mt-1">
                          {t('debts.daysOverdue', { n: doc.daysOverdue })}
                        </Badge>
                      )}
                    </span>
                    <MoneyText value={doc.outstanding} className="shrink-0 font-medium" />
                  </li>
                ))}
              </ul>
            </div>
            {onSettle && payable(debt) > 0 && (
              <Button onClick={onSettle}>
                <HandCoins aria-hidden />
                {debt.direction === 'payable' ? t('debts.pay') : t('debts.receive')}
              </Button>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DebtList({ direction }: { direction: 'payable' | 'receivable' }) {
  const { t } = useTranslation('finance');
  const canCreate = usePermission('finance.create');
  const debts = useDetail<CounterpartyDebt[]>(PATH, { direction });
  const [openId, setOpenId] = useState<string | null>(null);
  const [settling, setSettling] = useState<CounterpartyDebt | null>(null);

  const rows = debts.data ?? [];
  const selected = rows.find((row) => row.counterpartyId === openId) ?? null;

  const columns: Column<CounterpartyDebt>[] = [
    { key: 'name', header: t('journal.fields.counterparty'), mobile: 'title', cell: (row) => row.counterpartyName },
    {
      key: 'next',
      header: t('debts.nextDue'),
      mobile: 'subtitle',
      cell: (row) => (row.nextDueDate ? formatDate(row.nextDueDate) : t('debts.noDueDate')),
    },
    { key: 'outstanding', header: t('debts.outstanding'), align: 'right', cell: (row) => <MoneyText value={row.outstanding} className="font-medium" /> },
    {
      key: 'overdue',
      header: t('debts.overdue'),
      align: 'right',
      cell: (row) =>
        row.overdue > 0 ? (
          <span className="inline-flex items-center gap-1 text-danger">
            <TriangleAlert className="size-4" aria-hidden />
            <MoneyText value={row.overdue} />
          </span>
        ) : (
          '—'
        ),
    },
    ...(['d1_30', 'd31_60', 'd61_90', 'd90Plus'] as const).map(
      (key): Column<CounterpartyDebt> => ({
        key,
        header: t(`debts.agingBucket.${key}`),
        align: 'right',
        mobile: 'hidden',
        cell: (row) => (row.aging[key] > 0 ? formatMoney(row.aging[key], { compact: true }) : '—'),
      }),
    ),
  ];

  return (
    <>
      <DataTableView<CounterpartyDebt>
        rows={rows}
        columns={columns}
        loading={debts.isLoading}
        error={debts.error}
        onRetry={() => void debts.refetch()}
        rowKey={(row) => row.counterpartyId}
        onRowClick={(row) => setOpenId(row.counterpartyId)}
        empty={{ icon: HandCoins, title: t(`debts.empty.${direction}`), description: t('debts.emptyBody') }}
        rowActions={(row) => [
          {
            label: direction === 'payable' ? t('debts.pay') : t('debts.receive'),
            icon: HandCoins,
            hidden: !canCreate || payable(row) <= 0 || row.isPayroll,
            onClick: () => setSettling(row),
          },
        ]}
      />
      <DebtSheet
        debt={selected}
        onClose={() => setOpenId(null)}
        onSettle={
          canCreate && selected
            ? () => {
                setSettling(selected);
                setOpenId(null);
              }
            : undefined
        }
      />
      <SettleDialog debt={settling} onClose={() => setSettling(null)} />
    </>
  );
}

export default function DebtsPage() {
  const { t } = useTranslation('finance');
  const summary = useDetail<DebtSummary>(`${PATH}/summary`);
  const s = summary.data;
  const unpaid = useList<UnpaidReceipt>(FINANCE_PATHS.unpaidReceipts, { pageSize: 1 }).data?.meta.total ?? 0;

  return (
    <>
      <PageHeader title={t('debts.title')} description={t('debts.description')} />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t('debts.weOwe')} value={formatMoney(s?.payable)} loading={summary.isLoading} />
        <StatCard label={t('debts.owedToUs')} value={formatMoney(s?.receivable)} loading={summary.isLoading} />
        <StatCard
          label={t('debts.overdueTotal')}
          value={formatMoney(s?.overdue)}
          tone={s && s.overdue > 0 ? 'danger' : 'neutral'}
          icon={s && s.overdue > 0 ? TriangleAlert : undefined}
          loading={summary.isLoading}
        />
        <StatCard label={t('debts.loans')} value={formatMoney(s?.loansOutstanding)} hint={t('debts.loansHint')} to="/finance/loans" loading={summary.isLoading} />
      </div>
      <UrlTabs
        tabs={[
          { value: 'payable', label: t('debts.direction.payable'), content: <DebtList direction="payable" /> },
          { value: 'receivable', label: t('debts.direction.receivable'), content: <DebtList direction="receivable" /> },
          {
            value: 'receipts',
            label: (
              <span className="inline-flex items-center gap-1.5">
                {/* First, because a phone cuts this tab off at the end of its label. */}
                {unpaid > 0 && <Badge variant="warning">{unpaid}</Badge>}
                {t('unpaidReceipts.tab')}
              </span>
            ),
            content: <UnpaidReceiptList />,
          },
        ]}
      />
    </>
  );
}
