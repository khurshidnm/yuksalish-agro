import { LOAN_METHODS, todayIso } from '@yap/shared';
import { Banknote, CalendarClock, Check, Landmark, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import {
  type Column,
  ComboboxField,
  DataTableView,
  DateField,
  ErrorCard,
  FormDialog,
  FormGrid,
  MoneyText,
  NumberField,
  PageHeader,
  SelectField,
  StatCard,
  SwitchField,
  TextField,
  TextareaField,
  useConfirm,
} from '@/components';
import { Alert, Badge, Button, Meter, Sheet, SheetContent, SheetDescription, SheetTitle, Skeleton, apiOptions } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatMoney, formatPercent } from '@/lib/format';
import { zDate, zEnum, zOptionalRef, zOptionalText, zPositive, zRef, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { FINANCE_PATHS, MONEY_QUERIES, accountLabel } from './lib';
import type { AccountOption, Instalment, Loan, LoanDetail, UpcomingInstalment } from './types';

const PATH = FINANCE_PATHS.loans;

const loanSchema = z.object({
  counterpartyId: zRef(),
  name: zText(160),
  principal: zPositive(),
  annualRate: z.number().min(0).max(100),
  termMonths: z.number().int().min(1).max(360),
  startDate: zDate(),
  method: zEnum(LOAN_METHODS),
  preferential: z.boolean(),
  terms: zOptionalText(1000),
  disburseToAccountId: zOptionalRef(),
});

const paySchema = z.object({ date: zDate(), accountId: zRef() });

function PayDialog({ loanId, instalment, onClose }: { loanId: string; instalment: Instalment | null; onClose: () => void }) {
  const { t } = useTranslation('finance');
  const accounts = useDetail<AccountOption[]>('/finance/accounts/lookup', undefined, { enabled: instalment !== null }).data ?? [];
  const pay = useApiMutation<z.output<typeof paySchema>>({
    mutationFn: (values) => api.postOnce(`${PATH}/${loanId}/instalments/${instalment?.id}/pay`, values),
    invalidate: MONEY_QUERIES,
    silentError: true,
  });
  return (
    <FormDialog
      open={instalment !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t('loans.payTitle', { period: instalment?.period })}
      description={
        instalment
          ? t('loans.payHint', { principal: formatMoney(instalment.principal), interest: formatMoney(instalment.interest) })
          : undefined
      }
      schema={paySchema}
      defaultValues={{ date: todayIso(), accountId: accounts.find((a) => a.type === 'bank')?.id ?? '' }}
      onSubmit={(values) => pay.mutateAsync(values)}
      submitLabel={instalment ? t('loans.payAmount', { amount: formatMoney(instalment.payment) }) : undefined}
      successMessage="finance:loans.paid"
    >
      {(form) => (
        <>
          <DateField form={form} name="date" label={t('journal.fields.date')} required />
          <SelectField
            form={form}
            name="accountId"
            label={t('journal.fields.account')}
            required
            options={accounts.map((a) => ({ value: a.id, label: accountLabel(a) }))}
            placeholder={t('journal.chooseAccount')}
          />
        </>
      )}
    </FormDialog>
  );
}

function LoanSheet({ loanId, onClose }: { loanId: string | null; onClose: () => void }) {
  const { t } = useTranslation('finance');
  const canPay = usePermission('finance.approve');
  const loan = useDetail<LoanDetail>(loanId ? `${PATH}/${loanId}` : null);
  const [paying, setPaying] = useState<Instalment | null>(null);
  const today = todayIso();
  const data = loan.data;
  const nextUnpaid = data?.instalments.find((row) => !row.paidDate);
  const repaid = data ? (data.paidPrincipal / data.principal) * 100 : 0;

  return (
    <Sheet open={loanId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full max-w-xl overflow-y-auto p-5">
        <SheetTitle className="text-lg font-semibold">{data?.name ?? t('loans.title')}</SheetTitle>
        <SheetDescription className="text-sm text-muted-foreground">{data?.counterpartyName ?? ' '}</SheetDescription>
        {loan.error && <ErrorCard error={loan.error} onRetry={() => void loan.refetch()} className="mt-4" />}
        {loan.isLoading && <Skeleton className="mt-4 h-64 w-full" />}
        {data && (
          <div className="mt-4 flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">{t('loans.fields.principal')}</dt>
                <dd className="font-medium tabular-nums">{formatMoney(data.principal)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('loans.outstanding')}</dt>
                <dd className="font-medium tabular-nums">{formatMoney(data.outstanding)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('loans.fields.annualRate')}</dt>
                <dd className="font-medium tabular-nums">{formatPercent(data.annualRate)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('loans.interestPaid')}</dt>
                <dd className="font-medium tabular-nums">{formatMoney(data.paidInterest)}</dd>
              </div>
            </dl>
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('loans.repaid')}</span>
                <span className="tabular-nums">{formatPercent(repaid)}</span>
              </div>
              <Meter value={repaid} label={t('loans.repaid')} />
            </div>
            {data.terms && <p className="text-sm text-muted-foreground">{data.terms}</p>}

            <h3 className="text-sm font-medium">{t('loans.schedule')}</h3>
            <ul className="divide-y divide-border">
              {data.instalments.map((row) => {
                const late = !row.paidDate && row.dueDate < today;
                return (
                  <li key={row.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="block font-medium">
                        {row.period}. {formatDate(row.dueDate)}
                      </span>
                      <span className="block text-muted-foreground">
                        {t('loans.split', { principal: formatMoney(row.principal, { compact: true }), interest: formatMoney(row.interest, { compact: true }) })}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <MoneyText value={row.payment} className="font-medium" />
                      {row.paidDate ? (
                        <Badge variant="success">
                          <Check className="size-3" aria-hidden />
                          {t('loans.paidOn', { date: formatDate(row.paidDate) })}
                        </Badge>
                      ) : late ? (
                        <Badge variant="danger">{t('loans.late')}</Badge>
                      ) : null}
                      {canPay && nextUnpaid?.id === row.id && (
                        <Button size="sm" onClick={() => setPaying(row)}>
                          {t('loans.pay')}
                        </Button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
            <PayDialog loanId={data.id} instalment={paying} onClose={() => setPaying(null)} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default function LoansPage() {
  const { t } = useTranslation('finance');
  const canCreate = usePermission('finance.create');
  const canDelete = usePermission('finance.delete');
  const confirm = useConfirm();
  const loans = useDetail<Loan[]>(PATH);
  const upcoming = useDetail<UpcomingInstalment[]>(`${PATH}/upcoming`, { days: 30 });
  const accounts = useDetail<AccountOption[]>('/finance/accounts/lookup').data ?? [];
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const save = useApiMutation<z.output<typeof loanSchema>>({
    mutationFn: (values) => api.postOnce(PATH, values),
    invalidate: MONEY_QUERIES,
    silentError: true,
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: MONEY_QUERIES,
    successMessage: 'common:toast.deleted',
  });

  const rows = loans.data ?? [];
  const active = rows.filter((row) => row.status === 'active');
  const outstanding = active.reduce((sum, row) => sum + row.outstanding, 0);
  const next = upcoming.data?.[0];
  const dueSoon = (upcoming.data ?? []).reduce((sum, row) => sum + row.payment, 0);

  const columns: Column<Loan>[] = [
    { key: 'name', header: t('loans.fields.name'), mobile: 'title', cell: (row) => row.name },
    {
      key: 'lender',
      header: t('loans.fields.counterparty'),
      mobile: 'subtitle',
      cell: (row) => row.counterpartyName ?? '—',
    },
    { key: 'rate', header: t('loans.fields.annualRate'), align: 'right', cell: (row) => formatPercent(row.annualRate) },
    { key: 'principal', header: t('loans.fields.principal'), align: 'right', mobile: 'hidden', cell: (row) => formatMoney(row.principal) },
    { key: 'outstanding', header: t('loans.outstanding'), align: 'right', cell: (row) => <MoneyText value={row.outstanding} className="font-medium" /> },
    {
      key: 'next',
      header: t('loans.nextPayment'),
      cell: (row) =>
        row.status === 'closed' ? (
          <Badge variant="success">{t('enums:loanStatus.closed')}</Badge>
        ) : (
          <span className="flex flex-col">
            <span className="tabular-nums">{formatMoney(row.nextPayment)}</span>
            <span className={row.overdue ? 'text-sm text-danger' : 'text-sm text-muted-foreground'}>
              {formatDate(row.nextDueDate)}
              {row.overdue && ` · ${t('loans.late')}`}
            </span>
          </span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('loans.title')}
        description={t('loans.description')}
        actions={
          canCreate && (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('loans.add')}
            </Button>
          )
        }
      />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={t('loans.outstandingTotal')} value={formatMoney(outstanding)} icon={Landmark} loading={loans.isLoading} />
        <StatCard
          label={t('loans.dueSoon')}
          value={formatMoney(dueSoon)}
          hint={next ? t('loans.nextDue', { date: formatDate(next.dueDate) }) : undefined}
          icon={CalendarClock}
          loading={upcoming.isLoading}
        />
        <StatCard label={t('loans.activeCount')} value={active.length} icon={Banknote} loading={loans.isLoading} />
      </div>
      {rows.some((row) => row.overdue) && (
        <Alert tone="danger" title={t('loans.overdueTitle')} className="mb-4">
          {t('loans.overdueBody')}
        </Alert>
      )}
      <DataTableView<Loan>
        rows={rows}
        columns={columns}
        loading={loans.isLoading}
        error={loans.error}
        onRetry={() => void loans.refetch()}
        onRowClick={(row) => setOpenId(row.id)}
        empty={{ icon: Landmark, title: t('loans.emptyTitle'), description: t('loans.emptyBody') }}
        rowActions={(row) => [
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete || row.paidPrincipal > 0,
            onClick: async () => {
              const ok = await confirm({
                title: t('loans.deleteTitle'),
                description: t('loans.deleteBody', { name: row.name }),
                destructive: true,
              });
              if (ok) remove.mutate(row.id);
            },
          },
        ]}
      />
      <LoanSheet loanId={openId} onClose={() => setOpenId(null)} />
      <FormDialog
        open={creating}
        onOpenChange={setCreating}
        title={t('loans.add')}
        description={t('loans.addHint')}
        schema={loanSchema}
        defaultValues={{ name: '', method: 'annuity', preferential: false, startDate: todayIso(), counterpartyId: '' }}
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage="common:toast.created"
        size="lg"
      >
        {(form) => (
          <>
            <TextField form={form} name="name" label={t('loans.fields.name')} required />
            <ComboboxField
              form={form}
              name="counterpartyId"
              label={t('loans.fields.counterparty')}
              required
              loadOptions={apiOptions<{ id: string; name: string }>('/finance/counterparties/lookup', (c) => ({ value: c.id, label: c.name }))}
              placeholder={t('journal.chooseCounterparty')}
            />
            <FormGrid>
              <NumberField money form={form} name="principal" label={t('loans.fields.principal')} required />
              <NumberField form={form} name="annualRate" label={t('loans.fields.annualRate')} required suffix="%" />
              <NumberField form={form} name="termMonths" label={t('loans.fields.termMonths')} required maxDigits={0} />
              <DateField form={form} name="startDate" label={t('loans.fields.startDate')} required />
              <SelectField form={form} name="method" label={t('loans.fields.method')} options={enumOptions('loanMethod', LOAN_METHODS)} />
              <SelectField
                form={form}
                name="disburseToAccountId"
                label={t('loans.fields.disburseTo')}
                hint={t('loans.fields.disburseHint')}
                options={accounts.map((a) => ({ value: a.id, label: accountLabel(a) }))}
                placeholder={t('loans.fields.noDisburse')}
              />
            </FormGrid>
            <SwitchField form={form} name="preferential" label={t('loans.fields.preferential')} />
            <TextareaField form={form} name="terms" label={t('loans.fields.terms')} />
          </>
        )}
      </FormDialog>
    </>
  );
}
