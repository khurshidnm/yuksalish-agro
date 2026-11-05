import { todayIso } from '@yap/shared';
import { PackageCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { type Column, ComboboxField, DataTable, DateField, FormDialog, MoneyText, SelectField } from '@/components';
import { Alert, Button } from '@/components/ui';
import { needsCategory } from '@/features/inventory/receiptForm';
import { api } from '@/lib/api';
import { usePermission, useSession } from '@/lib/auth';
import { formatDate, formatMoney, formatQty } from '@/lib/format';
import { useApiMutation, useDetail } from '@/lib/query';
import { FINANCE_PATHS, MONEY_QUERIES, useLocalName } from './lib';
import type { AccountOption, CategoryOption, UnpaidReceipt } from './types';
import { type RecordFormOut, type RecordKind, accountsFor, recordDate, recordPayload, recordSchema } from './recordReceipt';

const PATH = FINANCE_PATHS.unpaidReceipts;

interface Recording {
  receipt: UnpaidReceipt;
  kind: RecordKind;
}

interface RecordResult {
  docNo: string;
  transactions: { id: string; status: string }[];
}

function RecordDialog({ recording, accounts, onClose }: { recording: Recording | null; accounts: AccountOption[]; onClose: () => void }) {
  const { t } = useTranslation('finance');
  const localName = useLocalName();
  const receipt = recording?.receipt;
  const kind = recording?.kind ?? 'payment';
  const askCategory = receipt ? needsCategory(receipt.lines) : false;
  const categories = useDetail<CategoryOption[]>('/finance/categories', { kind: 'expense' }, { enabled: askCategory }).data ?? [];
  const save = useApiMutation<RecordFormOut, RecordResult>({
    mutationFn: (values) => api.postOnce(`${PATH}/${receipt?.id}/record`, recordPayload(kind, values, accounts)),
    invalidate: MONEY_QUERIES,
    silentError: true,
    onSuccess: (result) => {
      const pending = result.transactions.some((row) => row.status === 'pending');
      toast.success(t('unpaidReceipts.saved', { docNo: result.docNo }), { description: pending ? t('unpaidReceipts.pendingApproval') : undefined });
    },
  });

  return (
    <FormDialog
      open={recording !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t(`unpaidReceipts.title.${kind}`)}
      description={receipt && t('unpaidReceipts.recordHint', { docNo: receipt.docNo, supplier: receipt.supplier, amount: formatMoney(receipt.value) })}
      schema={recordSchema(kind, askCategory)}
      defaultValues={{
        date: receipt ? recordDate(kind, receipt.date, todayIso()) : todayIso(),
        accountId: accounts[0]?.id ?? null,
        dueDate: null,
        categoryId: null,
      }}
      onSubmit={(values) => save.mutateAsync(values)}
    >
      {(form) => (
        <>
          {receipt?.paidRequest && <Alert tone="warning">{t('unpaidReceipts.paidRequest')}</Alert>}
          <DateField form={form} name="date" label={t('journal.fields.date')} required max={todayIso()} />
          {kind === 'payment' ? (
            <SelectField
              form={form}
              name="accountId"
              label={t('journal.fields.account')}
              required
              options={accounts.map((a) => ({ value: a.id, label: a.name }))}
              placeholder={t('journal.chooseAccount')}
            />
          ) : (
            <DateField form={form} name="dueDate" label={t('journal.fields.dueDate')} />
          )}
          {askCategory && (
            <ComboboxField
              form={form}
              name="categoryId"
              label={t('journal.fields.category')}
              hint={t('unpaidReceipts.categoryHint')}
              required
              options={categories.map((c) => ({ value: c.id, label: localName(c.name), hint: t(`enums:expenseGroup.${c.group}`) }))}
            />
          )}
        </>
      )}
    </FormDialog>
  );
}

export function UnpaidReceiptList() {
  const { t } = useTranslation('finance');
  const canCreate = usePermission('finance.create');
  const baseCurrency = useSession().tenant?.currency ?? 'UZS';
  // Loaded with the list, so the account is already chosen when a row's button is pressed.
  const accounts = useDetail<AccountOption[]>('/finance/accounts/lookup', undefined, { enabled: canCreate }).data ?? [];
  const [recording, setRecording] = useState<Recording | null>(null);

  const columns: Column<UnpaidReceipt>[] = [
    { key: 'supplier', sortable: true, header: t('journal.fields.counterparty'), mobile: 'title', cell: (row) => row.supplier },
    {
      key: 'date',
      sortable: true,
      header: t('unpaidReceipts.document'),
      mobile: 'subtitle',
      cell: (row) => t(row.invoiceNo ? 'unpaidReceipts.documentInvoice' : 'unpaidReceipts.documentOn', { docNo: row.docNo, date: formatDate(row.date), invoiceNo: row.invoiceNo }),
    },
    {
      key: 'goods',
      header: t('unpaidReceipts.goods'),
      cell: (row) => (
        <ul>
          {row.lines.map((line, index) => (
            <li key={index}>{t('unpaidReceipts.goodsLine', { item: line.itemName, qty: formatQty(line.qty, line.unit) })}</li>
          ))}
        </ul>
      ),
    },
    { key: 'value', sortable: true, header: t('unpaidReceipts.value'), align: 'right', cell: (row) => <MoneyText value={row.value} className="font-medium" /> },
    ...(canCreate
      ? [
          {
            key: 'record',
            header: t('unpaidReceipts.recordAs'),
            align: 'right',
            cell: (row) => (
              <div className="flex flex-wrap justify-end gap-2 md:flex-nowrap">
                <Button size="sm" onClick={() => setRecording({ receipt: row, kind: 'payment' })}>
                  {t('unpaidReceipts.asPayment')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setRecording({ receipt: row, kind: 'debt' })}>
                  {t('unpaidReceipts.asDebt')}
                </Button>
              </div>
            ),
          } satisfies Column<UnpaidReceipt>,
        ]
      : []),
  ];

  return (
    <>
      <p className="mb-3 text-sm text-muted-foreground">{t('unpaidReceipts.hint')}</p>
      <DataTable<UnpaidReceipt>
        path={PATH}
        columns={columns}
        urlPrefix="receipts"
        empty={{ icon: PackageCheck, title: t('unpaidReceipts.empty'), description: t('unpaidReceipts.emptyBody') }}
      />
      <RecordDialog recording={recording} accounts={accountsFor(accounts, baseCurrency)} onClose={() => setRecording(null)} />
    </>
  );
}
