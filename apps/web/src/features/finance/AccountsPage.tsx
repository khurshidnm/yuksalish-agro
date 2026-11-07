import { ACCOUNT_TYPES, CURRENCIES, todayIso } from '@yap/shared';
import { ArrowLeftRight, Banknote, Landmark, Pencil, Plus, ScrollText, Trash2, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import {
  type Column,
  DataTableView,
  DateField,
  EmptyState,
  ErrorCard,
  FormDialog,
  FormGrid,
  MoneyText,
  NumberField,
  PageHeader,
  SelectField,
  StatCard,
  TextField,
  UrlTabs,
  useConfirm,
} from '@/components';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DateInput,
  Label,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Skeleton,
} from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission, useSession } from '@/lib/auth';
import { formatDate, formatMoney, formatNumber } from '@/lib/format';
import { zDate, zEnum, zOptionalDate, zOptionalNumber, zOptionalText, zPositive, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { FINANCE_PATHS, MONEY_QUERIES } from './lib';
import { TransactionFormDialog } from './TransactionForm';
import type { AccountBalance, FxRate } from './types';

const PATH = FINANCE_PATHS.accounts;
const FX_PATH = FINANCE_PATHS.fx;

const ICONS = { cash: Banknote, bank: Landmark, card: Wallet } as const;

const accountSchema = z.object({
  name: zText(120),
  type: zEnum(ACCOUNT_TYPES),
  currency: zEnum(CURRENCIES),
  openingBalance: zOptionalNumber(),
  openingDate: zOptionalDate(),
  bankName: zOptionalText(120),
  accountNumber: zOptionalText(40),
});

function AccountCard({
  account,
  onEdit,
  onStatement,
  onClose,
}: {
  account: AccountBalance;
  onEdit?: () => void;
  onStatement: () => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation('finance');
  const session = useSession();
  const Icon = ICONS[account.type as keyof typeof ICONS] ?? Wallet;
  const foreign = account.currency !== (session.tenant?.currency ?? 'UZS');
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle className="truncate">{account.name}</CardTitle>
          <p className="truncate text-sm text-muted-foreground">
            {[account.bankName, account.accountNumber].filter(Boolean).join(' · ') || t(`enums:accountType.${account.type}`)}
          </p>
        </div>
        <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div>
          <p className="text-2xl font-semibold">
            <MoneyText value={account.balance} currency={account.currency} className={account.balance < 0 ? 'text-danger' : undefined} />
          </p>
          {foreign && <p className="text-sm text-muted-foreground">{formatMoney(account.balanceBase)}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onStatement}>
            <ScrollText aria-hidden />
            {t('accounts.statement')}
          </Button>
          {onEdit && (
            <Button variant="ghost" size="icon-sm" aria-label={t('common:actions.edit')} onClick={onEdit}>
              <Pencil aria-hidden />
            </Button>
          )}
          {onClose && (
            <Button variant="ghost" size="icon-sm" aria-label={t('accounts.close')} onClick={onClose}>
              <Trash2 aria-hidden />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface Statement {
  currency: string;
  opening: number;
  closing: number;
  days: { date: string; inflow: number; outflow: number; closing: number }[];
}

function StatementSheet({ account, onClose }: { account: AccountBalance | null; onClose: () => void }) {
  const { t } = useTranslation('finance');
  const today = todayIso();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const statement = useDetail<Statement>(account ? `${PATH}/${account.id}/daily` : null, { from, to });

  const money = (value: number) => formatMoney(value, { currency: account?.currency });

  return (
    <Sheet open={account !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full max-w-lg overflow-y-auto p-5">
        <SheetTitle className="text-lg font-semibold">{account?.name}</SheetTitle>
        <SheetDescription className="text-sm text-muted-foreground">{t('accounts.statementHint')}</SheetDescription>
        <div className="my-4 grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="st-from">{t('journal.from')}</Label>
            <DateInput id="st-from" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="st-to">{t('journal.to')}</Label>
            <DateInput id="st-to" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        {statement.error ? (
          <ErrorCard error={statement.error} onRetry={() => void statement.refetch()} />
        ) : statement.isLoading || !statement.data ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{t('accounts.opening')}</span>
              <span className="font-medium tabular-nums">{money(statement.data.opening)}</span>
            </div>
            {statement.data.days.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('accounts.noMovement')}</p>
            ) : (
              <ul className="divide-y divide-border">
                {statement.data.days.map((day) => (
                  <li key={day.date} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span>{formatDate(day.date)}</span>
                    <span className="flex flex-col items-end tabular-nums">
                      {day.inflow > 0 && <span className="text-success">+{money(day.inflow)}</span>}
                      {day.outflow > 0 && <span className="text-danger">−{money(day.outflow)}</span>}
                      <span className="text-muted-foreground">{money(day.closing)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-between border-t border-border pt-3 font-medium">
              <span>{t('accounts.closing')}</span>
              <span className="tabular-nums">{money(statement.data.closing)}</span>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function AccountsTab() {
  const { t } = useTranslation('finance');
  const session = useSession();
  const canCreate = usePermission('finance.create');
  const canUpdate = usePermission('finance.update');
  const canDelete = usePermission('finance.delete');
  const confirm = useConfirm();

  const accounts = useDetail<AccountBalance[]>(PATH);
  const [editing, setEditing] = useState<AccountBalance | null>(null);
  const [creating, setCreating] = useState(false);
  const [statementFor, setStatementFor] = useState<AccountBalance | null>(null);
  const [transfer, setTransfer] = useState(false);

  const close = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: MONEY_QUERIES,
    successMessage: 'common:toast.deleted',
  });
  const save = useApiMutation<z.output<typeof accountSchema>>({
    mutationFn: (form) => {
      const values = { ...form, openingBalance: form.openingBalance ?? 0 };
      return editing ? api.patch(`${PATH}/${editing.id}`, values) : api.postOnce(PATH, values);
    },
    invalidate: MONEY_QUERIES,
    silentError: true,
  });

  if (accounts.error) return <ErrorCard error={accounts.error} onRetry={() => void accounts.refetch()} />;

  const rows = accounts.data ?? [];
  const total = rows.reduce((sum, row) => sum + row.balanceBase, 0);
  const cash = rows.filter((row) => row.type === 'cash').reduce((sum, row) => sum + row.balanceBase, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={t('accounts.total')} value={formatMoney(total)} loading={accounts.isLoading} />
        <StatCard label={t('accounts.inCash')} value={formatMoney(cash)} loading={accounts.isLoading} />
        <StatCard label={t('accounts.inBank')} value={formatMoney(total - cash)} loading={accounts.isLoading} />
      </div>
      {(canCreate || canUpdate) && (
        <div className="flex flex-wrap justify-end gap-2">
          {canCreate && rows.length > 1 && (
            <Button variant="outline" onClick={() => setTransfer(true)}>
              <ArrowLeftRight aria-hidden />
              {t('accounts.transfer')}
            </Button>
          )}
          {canCreate && (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('accounts.add')}
            </Button>
          )}
        </div>
      )}
      {accounts.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={Landmark} title={t('accounts.emptyTitle')} description={t('accounts.emptyBody')} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              onStatement={() => setStatementFor(account)}
              onEdit={canUpdate ? () => setEditing(account) : undefined}
              onClose={
                canDelete
                  ? async () => {
                      const ok = await confirm({
                        title: t('accounts.closeTitle'),
                        description: t('accounts.closeBody', { name: account.name }),
                        destructive: true,
                      });
                      if (ok) close.mutate(account.id);
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}

      <FormDialog
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        title={editing ? t('accounts.edit') : t('accounts.add')}
        schema={accountSchema}
        defaultValues={
          editing
            ? { ...editing, type: editing.type as 'cash', currency: editing.currency as 'UZS' }
            : { name: '', type: 'bank', currency: (session.tenant?.currency ?? 'UZS') as 'UZS', openingBalance: 0, openingDate: todayIso() }
        }
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
      >
        {(form) => (
          <>
            <TextField form={form} name="name" label={t('accounts.fields.name')} required />
            <FormGrid>
              <SelectField form={form} name="type" label={t('accounts.fields.type')} required options={enumOptions('accountType', ACCOUNT_TYPES)} />
              <SelectField form={form} name="currency" label={t('accounts.fields.currency')} required options={enumOptions('currency', CURRENCIES)} />
              <NumberField money form={form} name="openingBalance" label={t('accounts.fields.openingBalance')} allowNegative />
              <DateField form={form} name="openingDate" label={t('accounts.fields.openingDate')} hint={t('accounts.fields.openingHint')} />
            </FormGrid>
            <TextField form={form} name="bankName" label={t('accounts.fields.bankName')} />
            <TextField form={form} name="accountNumber" label={t('accounts.fields.accountNumber')} inputMode="numeric" />
          </>
        )}
      </FormDialog>

      <StatementSheet account={statementFor} onClose={() => setStatementFor(null)} />
      <TransactionFormDialog open={transfer} onOpenChange={setTransfer} defaultType="transfer" />
    </div>
  );
}

const fxSchema = z.object({
  date: zDate(),
  currency: zEnum(['USD', 'RUB', 'EUR'] as const),
  rate: zPositive(),
});

function RatesTab() {
  const { t } = useTranslation('finance');
  const canUpdate = usePermission('finance.update');
  const canDelete = usePermission('finance.delete');
  const confirm = useConfirm();
  const rates = useDetail<FxRate[]>(FX_PATH);
  const [adding, setAdding] = useState(false);

  const save = useApiMutation<z.output<typeof fxSchema>>({
    mutationFn: (values) => api.put(FX_PATH, values),
    invalidate: [FX_PATH],
    silentError: true,
  });
  const remove = useApiMutation<FxRate>({
    mutationFn: (rate) => api.delete(`${FX_PATH}/${rate.date}/${rate.currency}`),
    invalidate: [FX_PATH],
    successMessage: 'common:toast.deleted',
  });

  const columns: Column<FxRate>[] = [
    { key: 'date', header: t('fx.date'), mobile: 'title', cell: (row) => formatDate(row.date) },
    { key: 'currency', header: t('fx.currency'), mobile: 'subtitle', cell: (row) => <Badge>{row.currency}</Badge> },
    { key: 'rate', header: t('fx.rate'), align: 'right', cell: (row) => formatNumber(row.rate, 4) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t('fx.description')}</p>
      {canUpdate && (
        <div className="flex justify-end">
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            {t('fx.add')}
          </Button>
        </div>
      )}
      <DataTableView<FxRate>
        rows={rates.data ?? []}
        columns={columns}
        loading={rates.isLoading}
        error={rates.error}
        onRetry={() => void rates.refetch()}
        rowKey={(row) => `${row.date}:${row.currency}`}
        empty={{ title: t('fx.emptyTitle'), description: t('fx.emptyBody') }}
        rowActions={(row) => [
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({ title: t('fx.deleteTitle'), destructive: true });
              if (ok) remove.mutate(row);
            },
          },
        ]}
      />
      <FormDialog
        open={adding}
        onOpenChange={setAdding}
        title={t('fx.add')}
        description={t('fx.addHint')}
        schema={fxSchema}
        defaultValues={{ date: todayIso(), currency: 'USD' }}
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage="common:toast.created"
      >
        {(form) => (
          <FormGrid>
            <DateField form={form} name="date" label={t('fx.date')} required />
            <SelectField form={form} name="currency" label={t('fx.currency')} required options={enumOptions('currency', ['USD', 'RUB', 'EUR'])} />
            <NumberField money form={form} name="rate" label={t('fx.rate')} required maxDigits={4} />
          </FormGrid>
        )}
      </FormDialog>
    </div>
  );
}

export default function AccountsPage() {
  const { t } = useTranslation('finance');
  return (
    <>
      <PageHeader title={t('accounts.title')} description={t('accounts.description')} />
      <UrlTabs
        tabs={[
          { value: 'accounts', label: t('accounts.tab'), content: <AccountsTab /> },
          { value: 'fx', label: t('fx.tab'), content: <RatesTab /> },
        ]}
      />
    </>
  );
}
