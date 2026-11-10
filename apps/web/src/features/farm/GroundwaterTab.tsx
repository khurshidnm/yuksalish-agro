import { GROUNDWATER_CRITICAL_DEPTH_M, GROUNDWATER_SOURCE } from '@yap/shared/formulas/salinity';
import { Pencil, Plus, Trash2, Waves } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, DataTableView, DateField, FormDialog, FormGrid, NumberField, TextareaField, useConfirm } from '@/components';
import { ChartCard } from '@/components/ChartCard';
import { Alert, Badge, Button, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber } from '@/lib/format';
import { zDate, zNonNegative, zOptionalNumber, zOptionalText } from '@/lib/forms';
import { useApiMutation } from '@/lib/query';
import { FIELD_PATHS } from './FieldFormDialog';
import type { FieldCard, GroundwaterObservation } from './types';

const METRICS = ['depthM', 'mineralisationGl'] as const;
type Metric = (typeof METRICS)[number];
const METRIC_LABEL: Record<Metric, 'groundwater.depth' | 'groundwater.mineralisation'> = {
  depthM: 'groundwater.depth',
  mineralisationGl: 'groundwater.mineralisation',
};
const METRIC_UNIT: Record<Metric, 'groundwater.unit.m' | 'groundwater.unit.gl'> = { depthM: 'groundwater.unit.m', mineralisationGl: 'groundwater.unit.gl' };

const schema = z.object({
  date: zDate(),
  depthM: zNonNegative(),
  mineralisationGl: zOptionalNumber(),
  notes: zOptionalText(1000),
});

function formValues(row: GroundwaterObservation | null): z.input<typeof schema> {
  return {
    date: row?.date ?? '',
    depthM: row?.depthM ?? (undefined as unknown as number),
    mineralisationGl: row?.mineralisationGl ?? null,
    notes: row?.notes ?? '',
  };
}

/**
 * Groundwater under the field: how deep it stands and how salty it is, as observed. The depth is
 * set against one published range, named on the screen. Mineralisation is shown as measured.
 */
export function GroundwaterTab({ field, path }: { field: FieldCard; path: string }) {
  const { t } = useTranslation('farm');
  const canCreate = usePermission('farm.create');
  const canUpdate = usePermission('farm.update');
  const canDelete = usePermission('farm.delete');
  const confirm = useConfirm();
  const [metric, setMetric] = useState<Metric>('depthM');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<GroundwaterObservation | null>(null);

  // The field list shows the latest observation, so it refreshes with the card.
  const invalidate = [path, ...FIELD_PATHS];
  const save = useApiMutation<z.output<typeof schema>>({
    mutationFn: (values) => (editing ? api.patch(`/farm/groundwater/${editing.id}`, values) : api.post(`/farm/fields/${field.id}/groundwater`, values)),
    invalidate,
    silentError: true,
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`/farm/groundwater/${id}`),
    invalidate,
    successMessage: 'common:toast.deleted',
  });

  const history = field.groundwater;
  const latest = history.at(-1) ?? null;
  const range = { min: formatNumber(GROUNDWATER_CRITICAL_DEPTH_M.min, 1), max: formatNumber(GROUNDWATER_CRITICAL_DEPTH_M.max, 1), source: GROUNDWATER_SOURCE };
  const withUnit = (value: number | null, unit: Metric) => (value === null ? '—' : `${formatNumber(value, 2)} ${t(METRIC_UNIT[unit])}`);
  const metricLabel = (value: Metric) => t('soil.withUnit', { name: t(METRIC_LABEL[value]), unit: t(METRIC_UNIT[value]) });

  const columns: Column<GroundwaterObservation>[] = [
    { key: 'date', header: t('groundwater.date'), cell: (row) => formatDate(row.date), mobile: 'title' },
    {
      key: 'depth',
      header: t('groundwater.depth'),
      align: 'right',
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
          {withUnit(row.depthM, 'depthM')}
          {row.risk && <Badge variant={row.risk === 'shallow' ? 'warning' : 'outline'}>{t(`groundwater.risk.${row.risk}`)}</Badge>}
        </span>
      ),
    },
    { key: 'mineralisation', header: t('groundwater.mineralisation'), align: 'right', cell: (row) => withUnit(row.mineralisationGl, 'mineralisationGl') },
    { key: 'notes', header: t('notes'), cell: (row) => row.notes ?? '—', mobile: 'hidden' },
  ];

  const addButton = canCreate && (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('groundwater.add')}
    </Button>
  );
  const points = metric === 'depthM' ? history : history.filter((row) => row.mineralisationGl !== null);

  return (
    <div className="flex flex-col gap-4">
      {latest?.risk && (
        <Alert tone={latest.risk === 'shallow' ? 'warning' : 'info'} title={t(`groundwater.warning.${latest.risk}.title`, { depth: formatNumber(latest.depthM, 2) })}>
          {t(`groundwater.warning.${latest.risk}.body`, { ...range, date: formatDate(latest.date) })}
        </Alert>
      )}
      {history.length > 0 && (
        <ChartCard
          title={t('groundwater.trend')}
          description={t('groundwater.trendHint')}
          kind="line"
          data={points}
          xKey="date"
          series={[{ key: metric, label: metricLabel(metric), slot: metric === 'depthM' ? 1 : 2 }]}
          formatValue={(value) => formatNumber(value, 2)}
          formatX={(value) => formatDate(value)}
          height={240}
          emptyText={t('groundwater.noMineralisation')}
          action={
            <Select
              aria-label={t('soil.metric')}
              value={metric}
              onChange={(e) => setMetric(e.target.value as Metric)}
              options={METRICS.map((value) => ({ value, label: metricLabel(value) }))}
              className="w-52 sm:w-64"
            />
          }
        />
      )}
      {/* With no observations yet the empty state carries the button. */}
      {history.length > 0 && <div className="flex justify-end empty:hidden">{addButton}</div>}
      <DataTableView<GroundwaterObservation>
        rows={[...history].reverse()}
        columns={columns}
        empty={{ icon: Waves, title: t('groundwater.emptyTitle'), description: t('groundwater.emptyBody'), action: addButton }}
        rowActions={(row) => [
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(row) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({ title: t('groundwater.deleteTitle'), description: t('groundwater.deleteBody', { date: formatDate(row.date) }), destructive: true });
              if (ok) remove.mutate(row.id);
            },
          },
        ]}
      />
      {history.length > 0 && <p className="text-xs text-muted-foreground">{t('groundwater.note', range)}</p>}
      <FormDialog
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        title={editing ? t('groundwater.edit') : t('groundwater.add')}
        schema={schema}
        defaultValues={formValues(editing)}
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
      >
        {(form) => (
          <>
            <DateField form={form} name="date" label={t('groundwater.date')} required />
            <FormGrid>
              <NumberField form={form} name="depthM" label={t('groundwater.depth')} suffix={t('groundwater.unit.m')} hint={t('groundwater.depthHint')} required />
              <NumberField form={form} name="mineralisationGl" label={t('groundwater.mineralisation')} suffix={t('groundwater.unit.gl')} />
            </FormGrid>
            <TextareaField form={form} name="notes" label={t('notes')} rows={2} />
          </>
        )}
      </FormDialog>
    </div>
  );
}
