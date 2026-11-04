import { todayIso } from '@yap/shared';
import { Fuel, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { type UseFormReturn, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, ComboboxField, DataTable, DateField, FormDialog, FormGrid, MoneyText, NumberField, SwitchField, TextField, TextareaField, useConfirm } from '@/components';
import { Badge, Button } from '@/components/ui';
import { employeeOptions, fieldOptions } from '@/features/crops/options';
import { api } from '@/lib/api';
import { useCan, usePermission } from '@/lib/auth';
import { formatDate, formatNumber, formatPercent, formatQty } from '@/lib/format';
import { zDate, zOptionalNumber, zOptionalRef, zOptionalText } from '@/lib/forms';
import { useApiMutation } from '@/lib/query';
import type { UsageLog } from './types';

const schema = z.object({
  date: zDate(),
  fieldId: zOptionalRef(),
  operatorEmployeeId: zOptionalRef(),
  workType: zOptionalText(120),
  motoHours: zOptionalNumber(),
  volumeHa: zOptionalNumber(),
  fuelL: zOptionalNumber(),
  skipFuelIssue: z.boolean(),
  notes: zOptionalText(1000),
});

type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;

function FuelOrigin({ form }: { form: UseFormReturn<Values, unknown, Output> }) {
  const { t } = useTranslation('assets');
  const fuel = useWatch({ control: form.control, name: 'fuelL' });
  if (!fuel) return null;
  return <SwitchField form={form} name="skipFuelIssue" label={t('usage.skipFuel')} hint={t('usage.skipFuelHint')} />;
}

export function ShiftDialog({
  assetId,
  open,
  onOpenChange,
  log,
}: {
  assetId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  log?: UsageLog | null;
}) {
  const { t } = useTranslation('assets');
  const save = useApiMutation<Output>({
    mutationFn: (values) =>
      log ? api.patch(`/assets/${assetId}/usage/${log.id}`, values) : api.post(`/assets/${assetId}/usage`, values),
    invalidate: [`/assets/${assetId}`, '/assets', '/inventory'],
    silentError: true,
  });
  const defaults: Values = {
    date: log?.date ?? todayIso(),
    fieldId: log?.fieldId ?? null,
    operatorEmployeeId: log?.operatorEmployeeId ?? null,
    workType: log?.workType ?? '',
    motoHours: log?.motoHours ?? null,
    volumeHa: log?.volumeHa ?? null,
    fuelL: log?.fuelL ?? null,
    // Keep how this shift was fuelled, or an edit would start drawing on the warehouse.
    skipFuelIssue: Boolean(log?.fuelL) && !log?.fuelItemId,
    notes: log?.notes ?? '',
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={log ? t('usage.edit') : t('usage.add')}
      schema={schema}
      defaultValues={defaults}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage={log ? 'common:toast.updated' : 'common:toast.created'}
    >
      {(form) => (
        <>
          <DateField form={form} name="date" label={t('usage.date')} required />
          <ComboboxField form={form} name="operatorEmployeeId" label={t('usage.operator')} loadOptions={employeeOptions} selectedLabel={log?.operatorName} clearable />
          <ComboboxField form={form} name="fieldId" label={t('usage.field')} loadOptions={fieldOptions} selectedLabel={log?.fieldNumber ? `№${log.fieldNumber}` : undefined} clearable />
          <TextField form={form} name="workType" label={t('usage.workType')} />
          <FormGrid>
            <NumberField form={form} name="motoHours" label={t('usage.hours')} suffix={t('unit.hours')} hint={t('usage.hoursHint')} />
            <NumberField form={form} name="volumeHa" label={t('usage.hectares')} suffix={t('unit.ha')} />
            <NumberField form={form} name="fuelL" label={t('usage.fuel')} suffix={t('unit.liters')} />
          </FormGrid>
          <FuelOrigin form={form} />
          <TextareaField form={form} name="notes" label={t('fields.notes')} />
        </>
      )}
    </FormDialog>
  );
}

export function AssetUsageTab({ assetId }: { assetId: string }) {
  const { t } = useTranslation('assets');
  const can = useCan();
  const seesMoney = usePermission('finance.view');
  const canAdd = can('assets.create') || can('crops.create');
  const canEdit = can('assets.update') || can('crops.update');
  const canDelete = can('assets.delete') || can('crops.delete');
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<UsageLog | null>(null);

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`/assets/${assetId}/usage/${id}`),
    invalidate: [`/assets/${assetId}`, '/assets', '/inventory'],
    successMessage: 'common:toast.deleted',
  });

  const addButton = canAdd && (
    <Button size="lg" onClick={() => setAdding(true)}>
      <Plus aria-hidden />
      {t('usage.add')}
    </Button>
  );

  const columns: Column<UsageLog>[] = [
    { key: 'date', header: t('usage.date'), sortable: true, mobile: 'title', cell: (row) => formatDate(row.date) },
    {
      key: 'work',
      header: t('usage.workType'),
      mobile: 'subtitle',
      cell: (row) => {
        const type = row.workType ? t(`enums:operationType.${row.workType}`, { defaultValue: row.workType }) : '—';
        return row.fieldNumber ? `№${row.fieldNumber} · ${type}` : type;
      },
    },
    { key: 'operator', header: t('usage.operator'), mobile: 'hidden', cell: (row) => row.operatorName ?? '—' },
    { key: 'motoHours', header: t('usage.hours'), sortable: true, align: 'right', cell: (row) => (row.motoHours === null ? '—' : formatNumber(row.motoHours)) },
    { key: 'hectares', header: t('usage.hectares'), align: 'right', cell: (row) => (row.volumeHa === null ? '—' : formatNumber(row.volumeHa)) },
    {
      key: 'fuelL',
      header: t('usage.fuel'),
      sortable: true,
      align: 'right',
      cell: (row) => (
        <span className="inline-flex items-center justify-end gap-2">
          {formatQty(row.fuelL, 'l')}
          {row.fuelDeviationPercent !== null && row.fuelDeviationPercent > 15 && (
            <Badge variant="warning">+{formatPercent(row.fuelDeviationPercent, 0)}</Badge>
          )}
        </span>
      ),
    },
    ...(seesMoney
      ? [{ key: 'fuelCost', header: t('usage.fuelCost'), align: 'right' as const, mobile: 'hidden' as const, cell: (row: UsageLog) => <MoneyText value={row.fuelCost} /> }]
      : []),
  ];

  return (
    <div className="space-y-3">
      <div className="flex justify-end">{addButton}</div>
      <DataTable<UsageLog>
        path={`/assets/${assetId}/usage`}
        columns={columns}
        defaultSort="-date"
        searchable={false}
        urlPrefix="usage"
        empty={{ icon: Fuel, title: t('usage.emptyTitle'), description: t('usage.emptyBody') }}
        rowActions={(row) => {
          // A shift made by a field operation changes there, and a billed one is closed.
          const locked = row.operationId !== null || row.billedTransactionId !== null;
          return [
            { label: t('common:actions.edit'), icon: Pencil, hidden: !canEdit || locked, onClick: () => setEditing(row) },
            {
              label: t('common:actions.delete'),
              icon: Trash2,
              destructive: true,
              hidden: !canDelete || locked,
              onClick: async () => {
                const ok = await confirm({ title: t('usage.deleteTitle'), description: t('usage.deleteBody'), destructive: true });
                if (ok) remove.mutate(row.id);
              },
            },
          ];
        }}
      />
      <ShiftDialog
        assetId={assetId}
        open={adding || editing !== null}
        log={editing}
        onOpenChange={(open) => {
          if (!open) {
            setAdding(false);
            setEditing(null);
          }
        }}
      />
    </div>
  );
}
