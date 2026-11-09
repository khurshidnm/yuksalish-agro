import { Gauge, PackageCheck, Pencil, Plus, Scale, Trash2, Wheat } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, ComboboxField, DataTable, FormDialog, MoneyText, NumberField, PageHeader, StatCard, useConfirm, useUrlParam } from '@/components';
import { Badge, Button, Select, Skeleton } from '@/components/ui';
import { useLocalName } from '@/features/farm/utils';
import { api } from '@/lib/api';
import { useCan, usePermission, useSeesCost } from '@/lib/auth';
import { formatDate, formatNumber, formatQty } from '@/lib/format';
import { zOptionalNumber, zRef } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';
import { HarvestFormDialog } from './HarvestFormDialog';
import { AFFECTED_BY_WORK, HARVESTS, type ItemOption, SEASONS, SUMMARY, itemOptions, warehouseOptions } from './options';
import type { CropsSummary, Harvest, Season } from './types';

/**
 * The season the page opens on: the one with the latest harvest, so the figures describe crops
 * already in, then the current season. The cards and the list always show the same season.
 */
function defaultSeason(seasons: Season[]): string {
  const harvested = seasons.filter((s) => s.lastHarvestDate).sort((a, b) => b.lastHarvestDate!.localeCompare(a.lastHarvestDate!));
  return (harvested[0] ?? seasons.find((s) => s.isCurrent) ?? seasons[0]).id;
}

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
  const [season, setSeason] = useUrlParam('season');
  const { data: seasons } = useDetail<Season[]>(SEASONS);
  // Wait for the season, or the list would flash every season's harvests first. A farm with no
  // seasons yet lists whatever it has.
  const ready = Boolean(season) || seasons?.length === 0;
  const { data: summary, isLoading } = useDetail<CropsSummary>(ready ? SUMMARY : null, { seasonId: season || undefined });

  useEffect(() => {
    if (!season && seasons?.length) setSeason(defaultSeason(seasons));
  }, [season, seasons, setSeason]);

  const yields = summary?.yields ?? [];

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${HARVESTS}/${id}`),
    invalidate: AFFECTED_BY_WORK,
    successMessage: 'common:toast.deleted',
  });

  const addButton = canCreate && (
    <Button onClick={() => setCreating(true)} className="w-full sm:w-auto">
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
      <PageHeader
        title={t('harvests.title')}
        description={t('harvests.description')}
        actions={
          <div className="grid w-full grid-cols-1 gap-2 min-[400px]:grid-cols-2 sm:flex sm:w-auto">
            <Select
              aria-label={t('plans.fields.season')}
              value={season}
              onChange={(e) => setSeason(e.target.value)}
              options={(seasons ?? []).map((s) => ({ value: s.id, label: s.name }))}
              placeholder={t('plans.chooseSeason')}
              className="w-full sm:w-52"
            />
            {addButton}
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard icon={Wheat} label={t('harvests.stats.actual')} value={formatQty(summary?.harvest.actualT ?? null, 't')} loading={isLoading || !ready} />
        <StatCard icon={Scale} label={t('harvests.stats.planned')} value={formatQty(summary?.harvest.plannedT ?? null, 't')} loading={isLoading || !ready} />
        <StatCard
          icon={Gauge}
          className="col-span-2 sm:col-span-1"
          label={t('harvests.stats.yield')}
          loading={isLoading || !ready}
          hint={yields.length === 1 ? localName(yields[0].cropName) : undefined}
          value={
            yields.length === 0 ? (
              '—'
            ) : yields.length === 1 ? (
              `${formatNumber(yields[0].yieldTHa, 2)} ${t('unit.tPerHa')}`
            ) : (
              // Hay, silage and grain each on a line of its own: their tons do not average.
              <span className="block space-y-0.5 text-base">
                {yields.map((c) => (
                  <span key={c.cropKey} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-normal text-muted-foreground">{localName(c.cropName)}</span>
                    <span className="shrink-0">
                      {formatNumber(c.yieldTHa, 1)} {t('unit.tPerHa')}
                    </span>
                  </span>
                ))}
              </span>
            )
          }
        />
      </div>

      {ready ? (
        <DataTable<Harvest>
          path={HARVESTS}
          params={{ seasonId: season || undefined }}
          columns={columns}
          defaultSort="-date"
          searchable={false}
          empty={{ icon: Wheat, title: t('harvests.emptyTitle'), description: t('harvests.emptyBody') }}
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
      ) : (
        <Skeleton className="h-64 w-full" />
      )}

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
