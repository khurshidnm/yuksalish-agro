import { todayIso } from '@yap/shared';
import { Fuel, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { type UseFormReturn, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, ComboboxField, DataTable, DateField, FormDialog, FormGrid, MoneyText, NumberField, SwitchField, TextField, TextareaField, useConfirm } from '@/components';
import { Badge } from '@/components/ui';
import { employeeOptions, fieldOptions } from '@/features/crops/options';
import { api } from '@/lib/api';
import { useCan, usePermission } from '@/lib/auth';
import { formatDate, formatNumber, formatPercent, formatQty } from '@/lib/format';
import { zDate, zOptionalNumber, zOptionalRef, zOptionalText } from '@/lib/forms';
import { useApiMutation } from '@/lib/query';
import type { AssetKind } from './assetKinds';
import type { AssetCard, UsageLog } from './types';

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

/** What a machine's log asks for. A recorded value always shows, so an edit never hides data. */
export function shiftInputs(kind: AssetKind, log?: UsageLog | null) {
  return {
    operator: !kind.stationary || Boolean(log?.operatorEmployeeId),
    fieldWork: kind.worksFields || Boolean(log?.fieldId) || log?.volumeHa != null,
    workType: !kind.stationary || Boolean(log?.workType),
    engine: kind.hasEngine || log?.motoHours != null || log?.fuelL != null,
  };
}

export function ShiftDialog({
  assetId,
  kind,
  open,
  onOpenChange,
  log,
}: {
  assetId: string;
  kind: AssetKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  log?: UsageLog | null;
}) {
  const { t } = useTranslation('assets');
  // A pump or generator runs for hours on fuel: no field, hectares or operator to ask for.
  const show = shiftInputs(kind, log);
  const save = useApiMutation<Output>({
    mutationFn: (values) =>
      log ? api.patch(`/assets/${assetId}/usage/${log.id}`, values) : api.postOnce(`/assets/${assetId}/usage`, values),
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
      title={log ? t('usage.edit') : kind.stationary ? t('usage.addHours') : t('usage.add')}
      schema={schema}
      defaultValues={defaults}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage={log ? 'common:toast.updated' : 'common:toast.created'}
    >
      {(form) => (
        <>
          <DateField form={form} name="date" label={t('usage.date')} required />
          {show.operator && (
            <ComboboxField form={form} name="operatorEmployeeId" label={t('usage.operator')} loadOptions={employeeOptions} selectedLabel={log?.operatorName} clearable />
          )}
          {show.fieldWork && (
            <ComboboxField form={form} name="fieldId" label={t('usage.field')} loadOptions={fieldOptions} selectedLabel={log?.fieldNumber ? `№${log.fieldNumber}` : undefined} clearable />
          )}
          {show.workType && <TextField form={form} name="workType" label={t('usage.workType')} />}
          <FormGrid>
            {show.engine && <NumberField form={form} name="motoHours" label={t('usage.hours')} suffix={t('unit.hours')} hint={t('usage.hoursHint')} />}
            {show.fieldWork && <NumberField form={form} name="volumeHa" label={t('usage.hectares')} suffix={t('unit.ha')} />}
            {show.engine && <NumberField form={form} name="fuelL" label={t('usage.fuel')} suffix={t('unit.liters')} />}
          </FormGrid>
          {show.engine && <FuelOrigin form={form} />}
          <TextareaField form={form} name="notes" label={t('fields.notes')} />
        </>
      )}
    </FormDialog>
  );
}

export function AssetUsageTab({ asset, kind }: { asset: AssetCard; kind: AssetKind }) {
  const { t } = useTranslation('assets');
  const assetId = asset.id;
  // Columns a machine of this kind never fills stay out, unless some shift has the figure.
  const showHectares = kind.worksFields || asset.usage.hectares > 0;
  const showEngine = kind.hasEngine || asset.usage.hours > 0 || asset.usage.fuelL > 0;
  const can = useCan();
  const seesMoney = usePermission('finance.view');
  const canEdit = can('assets.update') || can('crops.update');
  const canDelete = can('assets.delete') || can('crops.delete');
  const confirm = useConfirm();
  const [editing, setEditing] = useState<UsageLog | null>(null);

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`/assets/${assetId}/usage/${id}`),
    invalidate: [`/assets/${assetId}`, '/assets', '/inventory'],
    successMessage: 'common:toast.deleted',
  });

  const allColumns: (Column<UsageLog> | false)[] = [
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
    showEngine && { key: 'motoHours', header: t('usage.hours'), sortable: true, align: 'right', cell: (row) => (row.motoHours === null ? '—' : formatNumber(row.motoHours)) },
    showHectares && { key: 'hectares', header: t('usage.hectares'), align: 'right', cell: (row) => (row.volumeHa === null ? '—' : formatNumber(row.volumeHa)) },
    showEngine && {
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
    seesMoney && showEngine && { key: 'fuelCost', header: t('usage.fuelCost'), align: 'right', mobile: 'hidden', cell: (row) => <MoneyText value={row.fuelCost} /> },
  ];
  const columns = allColumns.filter((column): column is Column<UsageLog> => column !== false);

  return (
    <div className="space-y-3">
      <DataTable<UsageLog>
        path={`/assets/${assetId}/usage`}
        columns={columns}
        defaultSort="-date"
        searchable={false}
        urlPrefix="usage"
        // New shifts are logged from the page header, which stays above every tab: a second button here repeated it.
        empty={{ icon: Fuel, title: t('usage.emptyTitle'), description: kind.stationary ? t('usage.emptyBodyHours') : t('usage.emptyBody') }}
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
      <ShiftDialog assetId={assetId} kind={kind} open={editing !== null} log={editing} onOpenChange={(open) => !open && setEditing(null)} />
    </div>
  );
}
