import { CURRENCIES } from '@yap/shared';
import { ExternalLink, FileSignature, Pencil, Plus, Scale, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ComboboxField, type Column, DataTable, DateField, FormDialog, FormGrid, MoneyText, NumberField, SelectField, TextField, TextareaField, useConfirm, useUrlParam } from '@/components';
import { Badge, Button, Combobox, Select, Switch } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { zEnum, zOptionalDate, zOptionalNumber, zOptionalRef, zOptionalText, zRef, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { counterpartyOptions, FileField } from '../shared';
import { CONTRACT_STATUSES, type ContractRow } from '../types';
import { SettlementSheet } from './SettlementSheet';

const PATH = '/sales/contracts';

const schema = z.object({
  counterpartyId: zRef(),
  number: zText(60),
  title: zOptionalText(200),
  startDate: zOptionalDate(),
  endDate: zOptionalDate(),
  amount: zOptionalNumber(),
  currency: zEnum(CURRENCIES),
  terms: zOptionalText(2000),
  fileId: zOptionalRef(),
  status: zEnum(CONTRACT_STATUSES),
});

type Values = z.input<typeof schema>;

const EMPTY: Values = {
  counterpartyId: '',
  number: '',
  title: '',
  startDate: null,
  endDate: null,
  amount: null,
  currency: 'UZS',
  terms: '',
  fileId: null,
  status: 'active',
};

function toForm(row: ContractRow): Values {
  return {
    counterpartyId: row.counterpartyId,
    number: row.number,
    title: row.title,
    startDate: row.startDate,
    endDate: row.endDate,
    amount: row.amount,
    currency: row.currency as Values['currency'],
    terms: row.terms,
    fileId: row.fileId,
    status: row.status,
  };
}

function TermBadge({ row }: { row: ContractRow }) {
  const { t } = useTranslation('sales');
  if (row.expired) return <Badge variant="danger">{t('contracts.expired')}</Badge>;
  if (row.expiringSoon) return <Badge variant="warning">{t('contracts.daysLeft', { count: row.daysLeft ?? 0 })}</Badge>;
  return <Badge variant={row.status === 'active' ? 'success' : 'outline'}>{t(`contracts.status.${row.status}`)}</Badge>;
}

export function ContractsTab() {
  const { t } = useTranslation('sales');
  const can = useCan();
  const canCreate = can('sales.create') || can('finance.create');
  const canUpdate = can('sales.update') || can('finance.update');
  const canDelete = can('sales.delete') || can('finance.delete');
  const confirm = useConfirm();

  const [status, setStatus] = useUrlParam('contractStatus');
  const [expiring, setExpiring] = useUrlParam('expiring');
  const [counterpartyId, setCounterpartyId] = useUrlParam('counterparty');
  const [counterpartyLabel, setCounterpartyLabel] = useState<string | null>(null);
  const [settlementFor, setSettlementFor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ContractRow | null>(null);

  const save = useApiMutation<z.output<typeof schema>>({
    mutationFn: (values) => (editing ? api.patch(`${PATH}/${editing.id}`, values) : api.post(PATH, values)),
    invalidate: [PATH],
    silentError: true,
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: [PATH],
    successMessage: 'common:toast.deleted',
  });

  const columns: Column<ContractRow>[] = [
    {
      key: 'number',
      header: t('contracts.fields.number'),
      cell: (row) => (
        <>
          №{row.number}
          {row.title && <span className="block text-sm font-normal text-muted-foreground">{row.title}</span>}
        </>
      ),
      sortable: true,
      mobile: 'title',
    },
    { key: 'counterparty', header: t('contracts.fields.counterparty'), cell: (row) => row.counterpartyName, mobile: 'subtitle' },
    {
      key: 'endDate',
      header: t('contracts.fields.endDate'),
      cell: (row) => formatDate(row.endDate),
      sortable: true,
    },
    { key: 'status', header: t('contracts.fields.status'), cell: (row) => <TermBadge row={row} /> },
    { key: 'amount', header: t('contracts.fields.amount'), cell: (row) => <MoneyText value={row.amount} currency={row.currency} />, sortable: true, align: 'right' },
  ];

  const add = (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('contracts.add')}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {counterpartyId && (
          <Button variant="outline" onClick={() => setSettlementFor(counterpartyId)}>
            <Scale aria-hidden />
            {t('settlement.open')}
          </Button>
        )}
        {canCreate && add}
      </div>

      <DataTable<ContractRow>
        path={PATH}
        urlPrefix="contracts"
        params={{
          status: status || undefined,
          expiringWithin: expiring ? 30 : undefined,
          counterpartyId: counterpartyId || undefined,
        }}
        columns={columns}
        searchPlaceholder={t('contracts.searchPlaceholder')}
        filters={
          <>
            <Combobox
              value={counterpartyId || null}
              onChange={(value, option) => {
                setCounterpartyId(value ?? '');
                setCounterpartyLabel(option?.label ?? null);
              }}
              loadOptions={counterpartyOptions}
              selectedLabel={counterpartyLabel}
              placeholder={t('contracts.allCounterparties')}
              className="md:w-64"
            />
            <Select
              aria-label={t('contracts.fields.status')}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              options={CONTRACT_STATUSES.map((value) => ({ value, label: t(`contracts.status.${value}`) }))}
              placeholder={t('contracts.allStatuses')}
              className="md:w-48"
            />
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <Switch checked={Boolean(expiring)} onCheckedChange={(on) => setExpiring(on ? '1' : '')} />
              {t('contracts.expiringOnly')}
            </label>
          </>
        }
        empty={{ icon: FileSignature, title: t('contracts.emptyTitle'), description: t('contracts.emptyBody'), action: canCreate && add }}
        rowActions={(row) => [
          { label: t('settlement.open'), icon: Scale, onClick: () => setSettlementFor(row.counterpartyId) },
          {
            label: t('contracts.openFile'),
            icon: ExternalLink,
            hidden: !row.fileUrl,
            onClick: () => window.open(row.fileUrl ?? undefined, '_blank', 'noreferrer'),
          },
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(row) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({ title: t('contracts.deleteTitle', { number: row.number }), destructive: true });
              if (ok) remove.mutate(row.id);
            },
          },
        ]}
      />

      <FormDialog
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        title={editing ? t('contracts.edit') : t('contracts.add')}
        schema={schema}
        defaultValues={editing ? toForm(editing) : { ...EMPTY, counterpartyId }}
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
        size="lg"
      >
        {(form) => (
          <>
            <ComboboxField
              form={form}
              name="counterpartyId"
              label={t('contracts.fields.counterparty')}
              required
              loadOptions={counterpartyOptions}
              selectedLabel={editing?.counterpartyName ?? counterpartyLabel}
            />
            <FormGrid>
              <TextField form={form} name="number" label={t('contracts.fields.number')} required />
              <SelectField
                form={form}
                name="status"
                label={t('contracts.fields.status')}
                required
                options={CONTRACT_STATUSES.map((value) => ({ value, label: t(`contracts.status.${value}`) }))}
              />
            </FormGrid>
            <TextField form={form} name="title" label={t('contracts.fields.title')} />
            <FormGrid>
              <DateField form={form} name="startDate" label={t('contracts.fields.startDate')} />
              <DateField form={form} name="endDate" label={t('contracts.fields.endDate')} />
              <NumberField form={form} name="amount" label={t('contracts.fields.amount')} />
              <SelectField form={form} name="currency" label={t('contracts.fields.currency')} required options={enumOptions('currency', CURRENCIES)} />
            </FormGrid>
            <TextareaField form={form} name="terms" label={t('contracts.fields.terms')} rows={3} />
            <FileField form={form} name="fileId" label={t('contracts.fields.file')} currentUrl={editing?.fileUrl} />
          </>
        )}
      </FormDialog>

      {settlementFor && <SettlementSheet counterpartyId={settlementFor} onClose={() => setSettlementFor(null)} />}
    </div>
  );
}
