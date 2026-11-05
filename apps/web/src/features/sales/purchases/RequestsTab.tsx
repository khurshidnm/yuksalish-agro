import { PURCHASE_REQUEST_STATUSES, todayIso } from '@yap/shared';
import { Banknote, CheckCircle2, ClipboardList, FileWarning, PackageCheck, Pencil, Plus, Trash2, XCircle } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { type UseFormReturn, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ComboboxField, type Column, DataTable, DateField, FormDialog, FormGrid, MoneyText, NumberField, SelectField, TextField, TextareaField, useConfirm, useUrlParam } from '@/components';
import { Alert, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan, useSession } from '@/lib/auth';
import { formatDate, formatMoney, formatQty } from '@/lib/format';
import { zDate, zEnum, zNonNegative, zOptionalDate, zOptionalRef, zOptionalText, zPositive, zRef } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { accountOptions, counterpartyOptions, FileField, type ItemLookup, itemOptions, PurchaseStatusBadge, ReasonDialog, warehouseOptions } from '../shared';
import { type PurchaseRow, SALE_PAYMENT_METHODS } from '../types';

const PATH = '/sales/purchases';
/** Paying and receiving change money and stock, so those screens refetch too. */
const AFFECTED = [PATH, '/inventory', '/finance'];

const requestSchema = z.object({
  itemId: zRef(),
  qty: zPositive(),
  expectedPrice: zNonNegative().nullish().transform((v) => v ?? null),
  counterpartyId: zOptionalRef(),
  neededBy: zOptionalDate(),
  notes: zOptionalText(1000),
});

function buildPaySchema(t: (key: string) => string) {
  return z
    .object({
      date: zDate(),
      amount: zPositive(),
      paymentMethod: zEnum(SALE_PAYMENT_METHODS),
      accountId: zOptionalRef(),
      counterpartyId: zOptionalRef(),
      dueDate: zOptionalDate(),
      fileId: zOptionalRef(),
    })
    .superRefine((v, ctx) => {
      if (v.paymentMethod !== 'debt' && !v.accountId) {
        ctx.addIssue({ code: 'custom', path: ['accountId'], message: t('purchases.pickAccount') });
      }
    });
}

type PaySchema = ReturnType<typeof buildPaySchema>;
type PayForm = UseFormReturn<z.input<PaySchema>, unknown, z.output<PaySchema>>;

const receiveSchema = z.object({
  date: zDate(),
  qty: zPositive(),
  warehouseId: zRef(),
  quality: zOptionalText(200),
  batchNo: zOptionalText(60),
  expiryDate: zOptionalDate(),
  notes: zOptionalText(1000),
});

type ReceiveForm = UseFormReturn<z.input<typeof receiveSchema>, unknown, z.output<typeof receiveSchema>>;

function PayDialog({ row, onClose }: { row: PurchaseRow; onClose: () => void }) {
  const { t } = useTranslation('sales');
  const schema = buildPaySchema(t);
  const pay = useApiMutation<z.output<typeof schema>>({
    mutationFn: (values) => api.postOnce(`${PATH}/${row.id}/pay`, values),
    invalidate: AFFECTED,
    silentError: true,
  });
  const estimate = row.expectedPrice === null ? null : row.qty * row.expectedPrice;
  return (
    <FormDialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('purchases.payTitle', { item: row.itemName })}
      description={formatQty(row.qty, t(`enums:unit.${row.unit}`))}
      schema={schema}
      defaultValues={
        {
          date: todayIso(),
          amount: estimate,
          paymentMethod: 'bank',
          accountId: null,
          counterpartyId: row.counterpartyId,
          dueDate: null,
          fileId: null,
        } as never
      }
      onSubmit={(values) => pay.mutateAsync(values)}
      successMessage="sales:purchases.paid"
    >
      {(form) => <PayFields form={form} row={row} estimate={estimate} />}
    </FormDialog>
  );
}

function PayFields({ form, row, estimate }: { form: PayForm; row: PurchaseRow; estimate: number | null }) {
  const { t } = useTranslation('sales');
  const method = useWatch({ control: form.control, name: 'paymentMethod' });
  const amount = useWatch({ control: form.control, name: 'amount' });
  return (
    <>
      <FormGrid>
        <NumberField money form={form} name="amount" label={t('purchases.fields.amount')} required />
        <DateField form={form} name="date" label={t('purchases.fields.payDate')} required />
      </FormGrid>
      {estimate !== null && amount > estimate && <Alert tone="warning">{t('purchases.overEstimate', { estimate: formatMoney(estimate) })}</Alert>}
      <FormGrid>
        <SelectField form={form} name="paymentMethod" label={t('purchases.fields.paymentMethod')} required options={enumOptions('paymentMethod', SALE_PAYMENT_METHODS)} />
        {method === 'debt' ? (
          <DateField form={form} name="dueDate" label={t('purchases.fields.dueDate')} />
        ) : (
          <ComboboxField form={form} name="accountId" label={t('purchases.fields.account')} required loadOptions={accountOptions} />
        )}
      </FormGrid>
      <ComboboxField form={form} name="counterpartyId" label={t('purchases.fields.supplier')} loadOptions={counterpartyOptions} selectedLabel={row.counterpartyName} />
      <FileField form={form} name="fileId" label={t('purchases.fields.invoice')} />
    </>
  );
}

function ReceiveDialog({ row, onClose }: { row: PurchaseRow; onClose: () => void }) {
  const { t } = useTranslation('sales');
  const receive = useApiMutation<z.output<typeof receiveSchema>>({
    mutationFn: (values) => api.postOnce(`${PATH}/${row.id}/receive`, values),
    invalidate: AFFECTED,
    silentError: true,
  });
  return (
    <FormDialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('purchases.receiveTitle', { item: row.itemName })}
      schema={receiveSchema}
      defaultValues={{ date: todayIso(), qty: row.qty, warehouseId: row.warehouseId ?? '', quality: '', batchNo: '', expiryDate: null, notes: '' }}
      onSubmit={(values) => receive.mutateAsync(values)}
      successMessage="sales:purchases.received"
    >
      {(form) => (
        <>
          <FormGrid>
            <NumberField form={form} name="qty" label={t('purchases.fields.receivedQty')} required suffix={t(`enums:unit.${row.unit}`)} />
            <DateField form={form} name="date" label={t('purchases.fields.receivedOn')} required />
          </FormGrid>
          <ReceivedDifference form={form} row={row} />
          <ComboboxField form={form} name="warehouseId" label={t('purchases.fields.warehouse')} required loadOptions={warehouseOptions} />
          <FormGrid>
            <TextField form={form} name="quality" label={t('purchases.fields.quality')} />
            <TextField form={form} name="batchNo" label={t('purchases.fields.batchNo')} />
          </FormGrid>
          <DateField form={form} name="expiryDate" label={t('purchases.fields.expiryDate')} />
          <TextareaField form={form} name="notes" label={t('purchases.fields.notes')} rows={2} />
        </>
      )}
    </FormDialog>
  );
}

function ReceivedDifference({ form, row }: { form: ReceiveForm; row: PurchaseRow }) {
  const { t } = useTranslation('sales');
  const qty = useWatch({ control: form.control, name: 'qty' });
  if (typeof qty !== 'number' || qty === row.qty) return null;
  return (
    <Alert tone="warning">
      {t('purchases.differenceHint', { requested: formatQty(row.qty, t(`enums:unit.${row.unit}`)), received: formatQty(qty, t(`enums:unit.${row.unit}`)) })}
    </Alert>
  );
}

/** Difference act (farq akti): what was requested, what arrived, and what the gap is worth. */
function ActDialog({ row, onClose }: { row: PurchaseRow; onClose: () => void }) {
  const { t } = useTranslation('sales');
  const unit = t(`enums:unit.${row.unit}`);
  const rows: [string, ReactNode][] = [
    [t('purchases.act.requested'), formatQty(row.qty, unit)],
    [t('purchases.act.received'), formatQty(row.receivedQty, unit)],
    [t('purchases.act.difference'), formatQty(row.diffQty, unit)],
    [t('purchases.act.differenceValue'), <MoneyText key="value" value={row.diffAmount} signed />],
    [t('purchases.act.supplier'), row.counterpartyName ?? '—'],
    [t('purchases.act.date'), formatDate(row.receivedOn)],
    [t('purchases.act.warehouse'), row.warehouseName ?? '—'],
    [t('purchases.act.quality'), row.quality ?? '—'],
    [t('purchases.act.notes'), row.notes ?? '—'],
  ];
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('purchases.act.title', { item: row.itemName })}</DialogTitle>
          <DialogDescription className="sr-only">{t('purchases.act.title', { item: row.itemName })}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <dl className="flex flex-col gap-1">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 text-sm">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

type Action = { kind: 'pay' | 'receive' | 'reject' | 'act'; row: PurchaseRow } | null;

export function RequestsTab() {
  const { t } = useTranslation('sales');
  const session = useSession();
  const can = useCan();
  const canCreate = can('sales.create') || can('inventory.create');
  const canApprove = can('sales.approve');
  const canPay = can('finance.create');
  const canReceive = can('inventory.create');
  const canSeeMoney = can('finance.view');
  const confirm = useConfirm();

  const [status, setStatus] = useUrlParam('status');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PurchaseRow | null>(null);
  const [action, setAction] = useState<Action>(null);

  const save = useApiMutation<z.output<typeof requestSchema>>({
    mutationFn: (values) => (editing ? api.patch(`${PATH}/${editing.id}`, values) : api.post(PATH, values)),
    invalidate: [PATH],
    silentError: true,
  });
  const approve = useApiMutation<string>({
    mutationFn: (id) => api.post(`${PATH}/${id}/approve`),
    invalidate: [PATH],
    successMessage: 'sales:purchases.approved',
  });
  const reject = useApiMutation<{ id: string; reason: string }>({
    mutationFn: ({ id, reason }) => api.post(`${PATH}/${id}/reject`, { reason }),
    invalidate: [PATH],
    silentError: true,
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: [PATH],
    successMessage: 'common:toast.deleted',
  });

  const columns: Column<PurchaseRow>[] = [
    { key: 'item', header: t('purchases.fields.item'), cell: (row) => row.itemName, mobile: 'title' },
    { key: 'qty', header: t('purchases.fields.qty'), cell: (row) => formatQty(row.qty, t(`enums:unit.${row.unit}`)), align: 'right', mobile: 'subtitle' },
    { key: 'supplier', header: t('purchases.fields.supplier'), cell: (row) => row.counterpartyName ?? '—' },
    { key: 'status', header: t('purchases.fields.status'), cell: (row) => <PurchaseStatusBadge status={row.status} />, sortable: true },
    { key: 'neededBy', header: t('purchases.fields.neededBy'), cell: (row) => formatDate(row.neededBy), sortable: true, mobile: 'hidden' },
  ];
  if (canSeeMoney) {
    columns.push({
      key: 'estimate',
      header: t('purchases.fields.estimate'),
      cell: (row) => <MoneyText value={row.paidAmount ?? (row.expectedPrice === null ? null : row.qty * row.expectedPrice)} />,
      align: 'right',
    });
  }

  const add = (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('purchases.add')}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      {canCreate && <div className="flex justify-end">{add}</div>}

      <DataTable<PurchaseRow>
        path={PATH}
        urlPrefix="purchases"
        params={{ status: status || undefined }}
        columns={columns}
        searchPlaceholder={t('purchases.searchPlaceholder')}
        filters={
          <Select
            aria-label={t('purchases.fields.status')}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={enumOptions('purchaseRequestStatus', PURCHASE_REQUEST_STATUSES)}
            placeholder={t('purchases.allStatuses')}
            className="md:w-56"
          />
        }
        empty={{ icon: ClipboardList, title: t('purchases.emptyTitle'), description: t('purchases.emptyBody'), action: canCreate && add }}
        rowActions={(row) => {
          const own = row.createdBy === session.user.id;
          const requested = row.status === 'requested';
          return [
            {
              label: t('purchases.approve'),
              icon: CheckCircle2,
              hidden: !(canApprove && requested),
              disabled: own,
              onClick: async () => {
                const ok = await confirm({ title: t('purchases.approveTitle', { item: row.itemName }) });
                if (ok) approve.mutate(row.id);
              },
            },
            { label: t('purchases.reject'), icon: XCircle, hidden: !(canApprove && requested), disabled: own, onClick: () => setAction({ kind: 'reject', row }) },
            { label: t('purchases.pay'), icon: Banknote, hidden: !(canPay && row.status === 'approved'), onClick: () => setAction({ kind: 'pay', row }) },
            { label: t('purchases.receive'), icon: PackageCheck, hidden: !(canReceive && row.status === 'paid'), onClick: () => setAction({ kind: 'receive', row }) },
            { label: t('purchases.act.open'), icon: FileWarning, hidden: row.status !== 'received', onClick: () => setAction({ kind: 'act', row }) },
            { label: t('common:actions.edit'), icon: Pencil, hidden: !(canCreate && requested), onClick: () => setEditing(row) },
            {
              label: t('common:actions.delete'),
              icon: Trash2,
              destructive: true,
              hidden: !(canCreate && requested),
              onClick: async () => {
                const ok = await confirm({ title: t('purchases.deleteTitle', { item: row.itemName }), destructive: true });
                if (ok) remove.mutate(row.id);
              },
            },
          ];
        }}
      />

      <FormDialog
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        title={editing ? t('purchases.edit') : t('purchases.add')}
        description={t('purchases.formHint')}
        schema={requestSchema}
        defaultValues={
          (editing
            ? { itemId: editing.itemId, qty: editing.qty, expectedPrice: editing.expectedPrice, counterpartyId: editing.counterpartyId, neededBy: editing.neededBy, notes: editing.notes }
            : { itemId: '', qty: null, expectedPrice: null, counterpartyId: null, neededBy: null, notes: '' }) as never
        }
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
      >
        {(form) => (
          <>
            <ComboboxField
              form={form}
              name="itemId"
              label={t('purchases.fields.item')}
              required
              loadOptions={async (search) => {
                const options = await itemOptions(search);
                return options.map((o) => ({ ...o, hint: (o.raw as ItemLookup).unit }));
              }}
              selectedLabel={editing?.itemName}
            />
            <FormGrid>
              <NumberField form={form} name="qty" label={t('purchases.fields.qty')} required />
              <NumberField money form={form} name="expectedPrice" label={t('purchases.fields.expectedPrice')} hint={t('purchases.fields.expectedPriceHint')} />
            </FormGrid>
            <FormGrid>
              <ComboboxField form={form} name="counterpartyId" label={t('purchases.fields.supplier')} loadOptions={counterpartyOptions} selectedLabel={editing?.counterpartyName} />
              <DateField form={form} name="neededBy" label={t('purchases.fields.neededBy')} />
            </FormGrid>
            <TextareaField form={form} name="notes" label={t('purchases.fields.notes')} rows={2} />
          </>
        )}
      </FormDialog>

      {action?.kind === 'pay' && <PayDialog row={action.row} onClose={() => setAction(null)} />}
      {action?.kind === 'receive' && <ReceiveDialog row={action.row} onClose={() => setAction(null)} />}
      {action?.kind === 'act' && <ActDialog row={action.row} onClose={() => setAction(null)} />}
      <ReasonDialog
        open={action?.kind === 'reject'}
        onOpenChange={(next) => !next && setAction(null)}
        title={t('purchases.rejectTitle')}
        submitLabel={t('purchases.reject')}
        onSubmit={(reason) => reject.mutateAsync({ id: action!.row.id, reason })}
      />
    </div>
  );
}
