import { PackageCheck, Pencil, Plus, Scale, Trash2, Wheat } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, ComboboxField, DataTable, FormDialog, MoneyText, NumberField, PageHeader, StatCard, useConfirm } from '@/components';
import { Badge, Button } from '@/components/ui';
import { useLocalName } from '@/features/farm/utils';
import { api } from '@/lib/api';
import { useCan, usePermission, useSeesCost } from '@/lib/auth';
import { formatDate, formatNumber, formatQty } from '@/lib/format';
import { zOptionalNumber, zRef } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';
import { HarvestFormDialog } from './HarvestFormDialog';
import { AFFECTED_BY_WORK, HARVESTS, type ItemOption, SUMMARY, itemOptions, warehouseOptions } from './options';
import type { CropsSummary, Harvest } from './types';

const loadProducts = itemOptions();

const receiveSchema = z.object({ itemId: zRef(), warehouseId: zRef(), stockQty: zOptionalNumber() });

/** Ombor kirimi as its own step: the storekeeper receives what the field crew recorded. */
function ReceiveDialog({ harvest, onClose }: { harvest: Harvest | null; onClose: () => void }) {
  const { t } = useTranslation('crops');
  const [unit, setUnit] = useState<string | null>(null);
  const save = useApiMutation<z.output<typeof receiveSchema>>({
    mutationFn: (values) => api.postOnce(`${HARVESTS}/${harvest!.id}/receive`, values),
    invalidate: AFFECTED_BY_WORK,
    silentError: true,
  });
  return (
    <FormDialog
      open={harvest !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t('harvests.receive')}
      description={harvest ? t('harvests.receiveHint', { tons: formatQty(harvest.grossT, 't') }) : undefined}
      schema={receiveSchema}
      defaultValues={{ itemId: '', warehouseId: '', stockQty: null }}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage="common:toast.created"
    >
      {(form) => (
        <>
          <ComboboxField
            form={form}
            name="itemId"
            label={t('harvests.fields.item')}
            required
            loadOptions={loadProducts}
            onSelect={(_, option) => {
              const item = option?.raw as ItemOption | undefined;
              setUnit(item?.unit ?? null);
              if (item?.defaultWarehouseId) form.setValue('warehouseId', item.defaultWarehouseId, { shouldValidate: true });
            }}
          />
          <ComboboxField form={form} name="warehouseId" label={t('operations.materials.warehouse')} required loadOptions={warehouseOptions} />
          {unit !== null && unit !== 'kg' && unit !== 't' && <NumberField form={form} name="stockQty" label={t('harvests.fields.stockQty')} required />}
        </>
      )}
    </FormDialog>
  );
}

export default function HarvestsPage() {
  const { t } = useTranslation('crops');
  const localName = useLocalName();
  const can = useCan();
  const canCreate = usePermission('crops.create');
  const canUpdate = usePermission('crops.update');
  const canDelete = usePermission('crops.delete');
  const canReceive = can('crops.update') || can('inventory.create');
  const seesMoney = useSeesCost('crops.approve');
  const confirm = useConfirm();

  const [editing, setEditing] = useState<Harvest | null>(null);
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<Harvest | null>(null);
  const { data: summary, isLoading } = useDetail<CropsSummary>(SUMMARY);

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${HARVESTS}/${id}`),
    invalidate: AFFECTED_BY_WORK,
    successMessage: 'common:toast.deleted',
  });

  const addButton = canCreate && (
    <Button size="lg" onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('harvests.add')}
    </Button>
  );

  const columns: Column<Harvest>[] = [
    {
      key: 'field',
      header: t('operations.fields.field'),
      mobile: 'title',
      cell: (row) => (
        <>
          №{row.fieldNumber}
          {row.cropName ? ` · ${localName(row.cropName)}` : ''}
        </>
      ),
    },
    { key: 'date', header: t('operations.fields.date'), sortable: true, mobile: 'subtitle', cell: (row) => formatDate(row.date) },
    { key: 'grossT', header: t('harvests.fields.grossT'), sortable: true, align: 'right', cell: (row) => formatQty(row.grossT, 't') },
    {
      key: 'moisture',
      header: t('harvests.fields.moisture'),
      align: 'right',
      mobile: 'hidden',
      cell: (row) => (row.moisturePct === null ? '—' : `${formatNumber(row.moisturePct)}%`),
    },
    { key: 'quality', header: t('harvests.fields.quality'), mobile: 'hidden', cell: (row) => row.quality ?? '—' },
    {
      key: 'warehouse',
      header: t('operations.materials.warehouse'),
      cell: (row) => (row.batchId ? row.warehouseName : <Badge variant="warning">{t('harvests.notReceived')}</Badge>),
    },
    ...(seesMoney
      ? [{ key: 'value', header: t('harvests.fields.value'), align: 'right' as const, cell: (row: Harvest) => <MoneyText value={row.value} /> }]
      : []),
  ];

  return (
    <>
      <PageHeader title={t('harvests.title')} description={t('harvests.description')} actions={addButton} />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard icon={Wheat} label={t('harvests.stats.actual')} value={formatQty(summary?.harvest.actualT ?? null, 't')} loading={isLoading} />
        <StatCard icon={Scale} label={t('harvests.stats.planned')} value={formatQty(summary?.harvest.plannedT ?? null, 't')} loading={isLoading} />
        <StatCard
          label={t('harvests.stats.yield')}
          value={summary?.kpis.yieldTHa == null ? '—' : `${formatNumber(summary.kpis.yieldTHa, 2)} ${t('unit.tPerHa')}`}
          loading={isLoading}
        />
      </div>

      <DataTable<Harvest>
        path={HARVESTS}
        columns={columns}
        defaultSort="-date"
        searchable={false}
        empty={{ icon: Wheat, title: t('harvests.emptyTitle'), description: t('harvests.emptyBody'), action: addButton }}
        rowActions={(row) => [
          { label: t('harvests.receive'), icon: PackageCheck, hidden: Boolean(row.batchId) || !canReceive, onClick: () => setReceiving(row) },
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(row) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({
                title: t('harvests.deleteTitle'),
                description: t('harvests.deleteBody'),
                destructive: true,
              });
              if (ok) remove.mutate(row.id);
            },
          },
        ]}
      />

      <HarvestFormDialog
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        harvest={editing}
      />
      <ReceiveDialog harvest={receiving} onClose={() => setReceiving(null)} />
    </>
  );
}
