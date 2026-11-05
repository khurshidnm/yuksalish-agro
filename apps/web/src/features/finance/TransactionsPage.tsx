import { TRANSACTION_STATUSES, TRANSACTION_TYPES } from '@yap/shared';
import { Ban, Check, Download, FileCheck2, Paperclip, Pencil, Plus, ReceiptText, Trash2, X } from 'lucide-react';
import { type ComponentProps, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  type Column,
  DataTable,
  EmptyState,
  ErrorCard,
  FormDialog,
  MoneyText,
  PageHeader,
  StatCard,
  TextareaField,
  UrlTabs,
  useConfirm,
  useUrlParam,
} from '@/components';
import {
  Badge,
  Button,
  Card,
  CardContent,
  DateInput,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Label,
  Select,
  Skeleton,
} from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission, useSession } from '@/lib/auth';
import { formatDate, formatMoney } from '@/lib/format';
import { zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail, useList } from '@/lib/query';
import { FINANCE_PATHS, MONEY_QUERIES, canDeleteEntry, canEditEntry, canVoidEntry, useCenterName, useLocalName } from './lib';
import { TransactionFormDialog } from './TransactionForm';
import type { Totals, Transaction } from './types';

const PATH = FINANCE_PATHS.transactions;

const STATUS_VARIANT: Record<Transaction['status'], ComponentProps<typeof Badge>['variant']> = {
  draft: 'neutral',
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
};

export function StatusBadge({ status }: { status: Transaction['status'] }) {
  const { t } = useTranslation('finance');
  return <Badge variant={STATUS_VARIANT[status]}>{t(`enums:transactionStatus.${status}`)}</Badge>;
}

/** Money in has a plus, money out a minus. A transfer is neither. */
function signedAmount(row: Transaction): number {
  if (row.type === 'income' || row.type === 'debt_receipt') return row.amountBase;
  if (row.type === 'transfer') return 0;
  return -row.amountBase;
}

function AmountCell({ row }: { row: Transaction }) {
  return row.type === 'transfer' ? <MoneyText value={row.amountBase} /> : <MoneyText value={signedAmount(row)} signed />;
}

function useTitle() {
  const { t } = useTranslation('finance');
  const localName = useLocalName();
  return (row: Transaction) => {
    if (row.type === 'transfer') return `${row.accountName ?? '—'} → ${row.toAccountName ?? '—'}`;
    return row.categoryName ? localName(row.categoryName) : t(`enums:transactionType.${row.type}`);
  };
}

async function openAttachment(fileId: string) {
  const file = await api.get<{ url: string }>(`/files/${fileId}`);
  window.open(file.url, '_blank', 'noopener');
}

const reasonSchema = z.object({ reason: zText(300) });

/** Reject and void share one form: both need a reason, which stays on the record. */
function ReasonDialog({
  row,
  mode,
  onClose,
}: {
  row: Transaction | null;
  mode: 'reject' | 'void';
  onClose: () => void;
}) {
  const { t } = useTranslation('finance');
  const act = useApiMutation<string>({
    mutationFn: (reason) => api.post(`${PATH}/${row?.id}/${mode}`, mode === 'reject' ? { reason, baseUpdatedAt: row?.updatedAt } : { reason }),
    invalidate: MONEY_QUERIES,
    silentError: true,
  });
  return (
    <FormDialog
      open={row !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t(`approval.${mode}Title`)}
      description={row ? `${formatMoney(row.amountBase)}, ${formatDate(row.date)}` : undefined}
      schema={reasonSchema}
      defaultValues={{ reason: '' }}
      onSubmit={(values) => act.mutateAsync(values.reason)}
      submitLabel={t(`approval.${mode}`)}
      successMessage={`finance:approval.${mode}Done`}
    >
      {(form) => <TextareaField form={form} name="reason" label={t('approval.reason')} required />}
    </FormDialog>
  );
}

function ApprovalQueue() {
  const { t } = useTranslation('finance');
  const centerName = useCenterName();
  const title = useTitle();
  const session = useSession();
  const canApprove = usePermission('finance.approve');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useList<Transaction>(PATH, { status: 'pending', pageSize: 100, sort: 'date' });

  const approve = useApiMutation<Transaction>({
    mutationFn: (row) => api.post(`${PATH}/${row.id}/approve`, { baseUpdatedAt: row.updatedAt }),
    invalidate: MONEY_QUERIES,
    successMessage: 'finance:approval.approveDone',
  });

  if (error) return <ErrorCard error={error} onRetry={() => void refetch()} />;
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  const rows = data?.data ?? [];
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState icon={FileCheck2} title={t('approval.emptyTitle')} description={t('approval.emptyBody')} />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => {
        const own = row.createdBy === session.user.id;
        return (
          <Card key={row.id}>
            <CardContent className="flex flex-col gap-3 pt-4 md:flex-row md:items-center">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{title(row)}</p>
                <p className="text-sm text-muted-foreground">
                  {[formatDate(row.date), row.counterpartyName, centerName(row.costCenterName, row.costCenterType)].filter(Boolean).join(' · ')}
                </p>
                {row.description && <p className="mt-1 text-sm">{row.description}</p>}
                <p className="mt-1 text-sm text-muted-foreground">{t('approval.enteredBy', { name: row.createdByName ?? '—' })}</p>
                {row.fileId && (
                  <Button variant="link" className="h-auto p-0" onClick={() => void openAttachment(row.fileId!)}>
                    <Paperclip aria-hidden />
                    {t('journal.openFile')}
                  </Button>
                )}
              </div>
              <p className="text-lg font-semibold tabular-nums md:text-right">
                <AmountCell row={row} />
              </p>
              {canApprove && (
                <div className="flex flex-col gap-2 sm:flex-row md:w-64">
                  <Button className="flex-1" disabled={own} loading={approve.isPending && approve.variables.id === row.id} onClick={() => approve.mutate(row)}>
                    <Check aria-hidden />
                    {t('approval.approve')}
                  </Button>
                  <Button className="flex-1" variant="outline" disabled={own} onClick={() => setRejectingId(row.id)}>
                    <X aria-hidden />
                    {t('approval.reject')}
                  </Button>
                </div>
              )}
            </CardContent>
            {own && canApprove && <p className="px-6 pb-4 text-sm text-muted-foreground">{t('approval.ownEntry')}</p>}
          </Card>
        );
      })}
      {/* Read from the list, so a refusal that refreshed the entry shows its new figures here too. */}
      <ReasonDialog row={rows.find((row) => row.id === rejectingId) ?? null} mode="reject" onClose={() => setRejectingId(null)} />
    </div>
  );
}

function Journal({ onEdit }: { onEdit: (row: Transaction) => void }) {
  const { t } = useTranslation('finance');
  const centerName = useCenterName();
  const title = useTitle();
  const canUpdate = usePermission('finance.update');
  const canDelete = usePermission('finance.delete');
  const canApprove = usePermission('finance.approve');
  const session = useSession();
  const twoPeople = (session.settings.finance as { makerChecker?: boolean } | undefined)?.makerChecker !== false;
  const confirm = useConfirm();

  const [from, setFrom] = useUrlParam('from');
  const [to, setTo] = useUrlParam('to');
  const [type, setType] = useUrlParam('type');
  const [status, setStatus] = useUrlParam('status');
  // DataTable owns this box and keeps it in the URL. The totals read it from there.
  const [search] = useUrlParam('q');
  const [voiding, setVoiding] = useState<Transaction | null>(null);

  const params = { from: from || undefined, to: to || undefined, type: type || undefined, status: status || undefined };
  const totals = useDetail<Totals>(`${PATH}/totals`, { ...params, search: search || undefined });

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: MONEY_QUERIES,
    successMessage: 'common:toast.deleted',
  });

  const exportFile = (format: 'csv' | 'xlsx') =>
    api.download(`${PATH}/export.${format}`, `operatsiyalar.${format}`, { from: from || undefined, to: to || undefined });

  const columns: Column<Transaction>[] = [
    {
      key: 'description',
      header: t('journal.fields.operation'),
      mobile: 'title',
      cell: (row) => (
        <span className="flex flex-col">
          <span className="font-medium">{title(row)}</span>
          {row.description && <span className="line-clamp-1 text-sm font-normal text-muted-foreground">{row.description}</span>}
        </span>
      ),
    },
    { key: 'date', header: t('journal.fields.date'), sortable: true, mobile: 'subtitle', cell: (row) => formatDate(row.date) },
    { key: 'amountBase', header: t('journal.fields.amount'), sortable: true, align: 'right', cell: (row) => <AmountCell row={row} /> },
    { key: 'account', header: t('journal.fields.account'), cell: (row) => row.accountName ?? t(`enums:paymentMethod.${row.paymentMethod}`) },
    { key: 'counterparty', header: t('journal.fields.counterparty'), mobile: 'hidden', cell: (row) => row.counterpartyName ?? '—' },
    { key: 'costCenter', header: t('journal.fields.costCenter'), mobile: 'hidden', cell: (row) => centerName(row.costCenterName, row.costCenterType) },
    { key: 'status', header: t('journal.fields.status'), sortable: true, cell: (row) => <StatusBadge status={row.status} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={t('journal.totalIncome')} value={formatMoney(totals.data?.income)} loading={totals.isLoading} />
        <StatCard label={t('journal.totalExpense')} value={formatMoney(totals.data?.expense)} loading={totals.isLoading} />
        <StatCard label={t('journal.totalNet')} value={formatMoney(totals.data?.net)} loading={totals.isLoading} hint={t('journal.totalsHint')} />
      </div>
      <DataTable<Transaction>
        path={PATH}
        params={params}
        columns={columns}
        defaultSort="-date"
        searchPlaceholder={t('journal.searchPlaceholder')}
        filters={
          <div className="grid grid-cols-2 gap-2 md:flex md:items-end">
            <div className="flex flex-col gap-1">
              <Label htmlFor="tx-from" className="text-xs text-muted-foreground">
                {t('journal.from')}
              </Label>
              <DateInput id="tx-from" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="tx-to" className="text-xs text-muted-foreground">
                {t('journal.to')}
              </Label>
              <DateInput id="tx-to" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <Select
              aria-label={t('journal.typeFilter')}
              value={type}
              onChange={(e) => setType(e.target.value)}
              options={enumOptions('transactionType', TRANSACTION_TYPES)}
              placeholder={t('journal.allTypes')}
            />
            <Select
              aria-label={t('journal.statusFilter')}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              options={enumOptions('transactionStatus', TRANSACTION_STATUSES)}
              placeholder={t('journal.allStatuses')}
            />
          </div>
        }
        empty={{ icon: ReceiptText, title: t('journal.emptyTitle'), description: t('journal.emptyBody') }}
        rowActions={(row) => [
          { label: t('journal.openFile'), icon: Paperclip, hidden: !row.fileId, onClick: () => void openAttachment(row.fileId!) },
          {
            label: t('common:actions.edit'),
            icon: Pencil,
            hidden: !canUpdate || !canEditEntry(row),
            onClick: () => onEdit(row),
          },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete || !canDeleteEntry(row),
            onClick: async () => {
              const ok = await confirm({ title: t('journal.deleteTitle'), description: t('journal.deleteBody'), destructive: true });
              if (ok) remove.mutate(row.id);
            },
          },
          {
            label: t('approval.void'),
            icon: Ban,
            destructive: true,
            hidden: !canApprove || !canVoidEntry(row),
            onClick: () => (twoPeople && row.createdBy === session.user.id ? toast.info(t('approval.ownVoid')) : setVoiding(row)),
          },
        ]}
      />
      {/* On the left on phones: the assistant button floats in the right corner. */}
      <div className="flex justify-start sm:justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              <Download aria-hidden />
              {t('journal.export')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => void exportFile('csv')}>{t('journal.exportCsv')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void exportFile('xlsx')}>{t('journal.exportXlsx')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ReasonDialog row={voiding} mode="void" onClose={() => setVoiding(null)} />
    </div>
  );
}

export default function TransactionsPage() {
  const { t } = useTranslation('finance');
  const canCreate = usePermission('finance.create');
  const pending = useDetail<{ count: number }>(`${PATH}/pending-count`);
  const [form, setForm] = useState<{ open: boolean; editing: Transaction | null }>({ open: false, editing: null });

  const count = pending.data?.count ?? 0;

  return (
    <>
      <PageHeader
        title={t('journal.title')}
        description={t('journal.description')}
        actions={
          canCreate && (
            <Button onClick={() => setForm({ open: true, editing: null })}>
              <Plus aria-hidden />
              {t('journal.add')}
            </Button>
          )
        }
      />
      <UrlTabs
        tabs={[
          {
            value: 'journal',
            label: t('journal.tab'),
            content: <Journal onEdit={(row) => setForm({ open: true, editing: row })} />,
          },
          {
            value: 'approval',
            label: count > 0 ? `${t('approval.tab')} (${count})` : t('approval.tab'),
            content: <ApprovalQueue />,
          },
        ]}
      />
      <TransactionFormDialog
        open={form.open}
        editing={form.editing}
        onOpenChange={(open) => setForm((current) => ({ open, editing: open ? current.editing : null }))}
      />
    </>
  );
}
