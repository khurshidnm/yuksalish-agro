import { todayIso } from '@yap/shared';
import { ArrowDownRight, ArrowUpRight, Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ComboboxField, type Column, DataTable, DataTableView, DateField, FormDialog, FormGrid, MoneyText, NumberField, SelectField, TextField, useConfirm, useUrlParam } from '@/components';
import { ChartCard } from '@/components/ChartCard';
import { Badge, Button, Combobox, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatMoney, formatPercent } from '@/lib/format';
import { zDate, zEnum, zNonNegative, zOptionalText, zRef } from '@/lib/forms';
import { useApiMutation, useDetail, useList } from '@/lib/query';
import { itemOptions } from '../shared';
import type { CurrentPrice, PriceRow } from '../types';

const PATH = '/sales/prices';
const KINDS = ['sale', 'market'] as const;

const schema = z.object({
  itemId: zRef(),
  date: zDate(),
  kind: zEnum(KINDS),
  price: zNonNegative(),
  source: zOptionalText(120),
});

interface PriceListRow {
  itemId: string;
  itemName: string;
  unit: string;
  sale: CurrentPrice | null;
  market: CurrentPrice | null;
}

function Change({ value }: { value: number | null }) {
  if (value === null || value === 0) return null;
  const Icon = value > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="ml-1.5 inline-flex items-center text-xs text-muted-foreground tabular-nums">
      <Icon className="size-3.5" aria-hidden />
      {formatPercent(Math.abs(value))}
    </span>
  );
}

function pivot(rows: CurrentPrice[]): PriceListRow[] {
  const byItem = new Map<string, PriceListRow>();
  for (const r of rows) {
    const row = byItem.get(r.itemId) ?? { itemId: r.itemId, itemName: r.itemName, unit: r.unit, sale: null, market: null };
    row[r.kind] = r;
    byItem.set(r.itemId, row);
  }
  return [...byItem.values()];
}

function PriceHistoryChart({ itemId, title }: { itemId: string; title: string }) {
  const { t } = useTranslation('sales');
  const { data, isLoading, error, refetch } = useList<PriceRow>(PATH, { itemId, pageSize: 200, sort: 'date' });
  const points = useMemo(() => {
    const byDate = new Map<string, { date: string; sale?: number; market?: number }>();
    for (const row of data?.data ?? []) {
      if (row.price === null) continue;
      const point = byDate.get(row.date) ?? { date: row.date };
      point[row.kind] = row.price;
      byDate.set(row.date, point);
    }
    return [...byDate.values()];
  }, [data]);

  return (
    <ChartCard
      title={title}
      description={t('prices.chartHint')}
      kind="line"
      data={points}
      xKey="date"
      series={[
        { key: 'sale', label: t('prices.kind.sale'), slot: 1 },
        { key: 'market', label: t('prices.kind.market'), slot: 2 },
      ]}
      formatValue={(v) => formatMoney(v)}
      formatX={(d) => formatDate(String(d))}
      loading={isLoading}
      error={error}
      onRetry={() => void refetch()}
      emptyText={t('prices.emptyTitle')}
    />
  );
}

export function PricesTab() {
  const { t } = useTranslation('sales');
  const canCreate = usePermission('sales.create');
  const canUpdate = usePermission('sales.update');
  const canDelete = usePermission('sales.delete') || canUpdate;
  const confirm = useConfirm();

  const [kind, setKind] = useUrlParam('kind');
  const [itemId, setItemId] = useUrlParam('item');
  const [itemLabel, setItemLabel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PriceRow | null>(null);

  const current = useDetail<CurrentPrice[]>(`${PATH}/current`);
  const priceList = useMemo(() => pivot(current.data ?? []), [current.data]);

  const save = useApiMutation<z.output<typeof schema>>({
    mutationFn: ({ itemId: item, ...values }) =>
      editing ? api.patch(`${PATH}/${editing.id}`, values) : api.post(PATH, { itemId: item, ...values }),
    invalidate: [PATH],
    silentError: true,
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: [PATH],
    successMessage: 'common:toast.deleted',
  });

  const priceCell = (p: CurrentPrice | null) =>
    p ? (
      <span className="whitespace-nowrap">
        <MoneyText value={p.price} />
        <Change value={p.changePercent} />
      </span>
    ) : (
      '—'
    );

  const listColumns: Column<PriceListRow>[] = [
    { key: 'item', header: t('prices.fields.item'), cell: (row) => row.itemName, mobile: 'title' },
    { key: 'unit', header: t('prices.fields.unit'), cell: (row) => t(`enums:unit.${row.unit}`), mobile: 'subtitle' },
    { key: 'sale', header: t('prices.kind.sale'), cell: (row) => priceCell(row.sale), align: 'right' },
    { key: 'market', header: t('prices.kind.market'), cell: (row) => priceCell(row.market), align: 'right' },
    { key: 'date', header: t('prices.fields.updated'), cell: (row) => formatDate(row.sale?.date ?? row.market?.date), mobile: 'hidden' },
  ];

  const historyColumns: Column<PriceRow>[] = [
    { key: 'date', header: t('prices.fields.date'), cell: (row) => formatDate(row.date), sortable: true, mobile: 'title' },
    { key: 'itemName', header: t('prices.fields.item'), cell: (row) => row.itemName, sortable: true, mobile: 'subtitle' },
    { key: 'kind', header: t('prices.fields.kind'), cell: (row) => <Badge>{t(`prices.kind.${row.kind}`)}</Badge> },
    {
      key: 'price',
      header: t('prices.fields.price'),
      // A price is per unit: 68 000 for a lamb's live weight is per kg, not per lamb.
      cell: (row) => (
        <span className="whitespace-nowrap">
          <MoneyText value={row.price} />
          {row.price !== null && row.unit && <span className="text-muted-foreground">{t('prices.perUnit', { unit: t(`enums:unit.${row.unit}`) })}</span>}
        </span>
      ),
      sortable: true,
      align: 'right',
    },
    { key: 'source', header: t('prices.fields.source'), cell: (row) => row.source ?? '—', mobile: 'hidden' },
  ];

  const add = (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('prices.add')}
    </Button>
  );

  return (
    <div className="flex flex-col gap-6">
      {canCreate && <div className="flex justify-end">{add}</div>}

      <section className="flex flex-col gap-2" aria-label={t('prices.currentTitle')}>
        <h2 className="text-base font-semibold">{t('prices.currentTitle')}</h2>
        <DataTableView<PriceListRow>
          rows={priceList}
          columns={listColumns}
          rowKey={(row) => row.itemId}
          loading={current.isLoading}
          error={current.error}
          onRetry={() => void current.refetch()}
          onRowClick={(row) => {
            setItemId(row.itemId);
            setItemLabel(row.itemName);
          }}
          empty={{ icon: Tag, title: t('prices.emptyTitle'), description: t('prices.emptyBody'), action: canCreate && add }}
        />
      </section>

      {itemId && <PriceHistoryChart itemId={itemId} title={t('prices.chartTitle', { item: itemLabel ?? priceList.find((p) => p.itemId === itemId)?.itemName ?? '' })} />}

      <section className="flex flex-col gap-2" aria-label={t('prices.historyTitle')}>
        <h2 className="text-base font-semibold">{t('prices.historyTitle')}</h2>
        <DataTable<PriceRow>
          path={PATH}
          urlPrefix="prices"
          params={{ kind: kind || undefined, itemId: itemId || undefined }}
          columns={historyColumns}
          defaultSort="-date"
          searchPlaceholder={t('prices.searchPlaceholder')}
          filters={
            <>
              <Select
                aria-label={t('prices.fields.kind')}
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                options={KINDS.map((value) => ({ value, label: t(`prices.kind.${value}`) }))}
                placeholder={t('prices.allKinds')}
                className="md:w-48"
              />
              <Combobox
                value={itemId || null}
                onChange={(value, option) => {
                  setItemId(value ?? '');
                  setItemLabel(option?.label ?? null);
                }}
                loadOptions={itemOptions}
                selectedLabel={itemLabel}
                placeholder={t('prices.allItems')}
                className="md:w-64"
              />
            </>
          }
          empty={{ icon: Tag, title: t('prices.emptyTitle') }}
          rowActions={(row) => [
            { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(row) },
            {
              label: t('common:actions.delete'),
              icon: Trash2,
              destructive: true,
              hidden: !canDelete,
              onClick: async () => {
                const ok = await confirm({ title: t('prices.deleteTitle'), destructive: true });
                if (ok) remove.mutate(row.id);
              },
            },
          ]}
        />
      </section>

      <FormDialog
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        title={editing ? t('prices.edit') : t('prices.add')}
        schema={schema}
        defaultValues={
          editing
            ? { itemId: editing.itemId, date: editing.date, kind: editing.kind, price: editing.price ?? 0, source: editing.source }
            : ({ itemId: itemId, date: todayIso(), kind: 'sale', price: null, source: '' } as never)
        }
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
      >
        {(form) => (
          <>
            <ComboboxField
              form={form}
              name="itemId"
              label={t('prices.fields.item')}
              required
              loadOptions={itemOptions}
              selectedLabel={editing?.itemName ?? itemLabel}
              disabled={editing !== null}
            />
            <FormGrid>
              <DateField form={form} name="date" label={t('prices.fields.date')} required />
              <SelectField
                form={form}
                name="kind"
                label={t('prices.fields.kind')}
                required
                options={KINDS.map((value) => ({ value, label: t(`prices.kind.${value}`) }))}
              />
            </FormGrid>
            <NumberField money form={form} name="price" label={t('prices.fields.price')} required />
            <TextField form={form} name="source" label={t('prices.fields.source')} hint={t('prices.fields.sourceHint')} />
          </>
        )}
      </FormDialog>
    </div>
  );
}
