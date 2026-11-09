import { todayIso } from '@yap/shared';
import { Plus, Scissors, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, ComboboxField, DataTable, DateField, FormDialog, FormGrid, NumberField, TextField, useConfirm } from '@/components';
import { Button, apiOptions } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatQty } from '@/lib/format';
import { zDate, zOptionalRef, zOptionalText, zPositive, zRef } from '@/lib/forms';
import { useApiMutation } from '@/lib/query';
import type { HerdLookup, LookupRow } from './shared';

const PATH = '/livestock/shearing';

interface ShearingRow {
  id: string;
  date: string;
  tag: string | null;
  herdName: string | null;
  woolKg: number;
  quality: string | null;
}

const schema = z.object({
  herdId: zOptionalRef(),
  date: zDate(),
  woolKg: zPositive(),
  quality: zOptionalText(60),
  itemId: zRef(),
  warehouseId: zRef(),
});
type Output = z.output<typeof schema>;

export function ShearingPanel() {
  const { t } = useTranslation('livestock');
  const canManage = usePermission('livestock.update');
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);

  const invalidate = [PATH, '/inventory'];
  const add = useApiMutation<Output>({ mutationFn: (values) => api.postOnce(PATH, values), invalidate, silentError: true });
  const remove = useApiMutation<string>({ mutationFn: (id) => api.delete(`${PATH}/${id}`), invalidate, successMessage: 'common:toast.deleted' });

  const columns: Column<ShearingRow>[] = [
    { key: 'date', header: t('fields.date'), cell: (row) => formatDate(row.date), sortable: true, mobile: 'title' },
    { key: 'herd', header: t('fields.herd'), cell: (row) => row.herdName ?? '—', mobile: 'subtitle' },
    { key: 'tag', header: t('fields.animal'), cell: (row) => row.tag ?? t('shearing.wholeHerd') },
    { key: 'woolKg', header: t('shearing.wool'), cell: (row) => formatQty(row.woolKg, 'kg', 1), sortable: true, align: 'right' },
    { key: 'quality', header: t('shearing.quality'), cell: (row) => row.quality ?? '—' },
  ];

  return (
    <div className="space-y-3">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            {t('shearing.add')}
          </Button>
        </div>
      )}
      <DataTable<ShearingRow>
        path={PATH}
        urlPrefix="s"
        columns={columns}
        defaultSort="-date"
        searchable={false}
        rowActions={(row) => [
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canManage,
            onClick: async () => {
              const ok = await confirm({ title: t('shearing.deleteTitle'), description: t('shearing.deleteBody'), destructive: true });
              if (ok) remove.mutate(row.id);
            },
          },
        ]}
        empty={{ icon: Scissors, title: t('shearing.emptyTitle'), description: t('shearing.emptyBody') }}
      />
      <FormDialog
        open={adding}
        onOpenChange={setAdding}
        title={t('shearing.add')}
        description={t('shearing.hint')}
        schema={schema}
        defaultValues={{ herdId: null, date: todayIso(), woolKg: undefined, quality: '', itemId: '', warehouseId: '' }}
        onSubmit={(values) => add.mutateAsync(values)}
        successMessage="common:toast.saved"
      >
        {(form) => (
          <>
            <ComboboxField
              form={form}
              name="herdId"
              label={t('fields.herd')}
              required
              loadOptions={apiOptions<HerdLookup>('/livestock/herds/lookup', (h) => ({ value: h.id, label: h.name, hint: t('head', { count: h.headCount }) }))}
            />
            <FormGrid>
              <DateField form={form} name="date" label={t('fields.date')} required max={todayIso()} />
              <NumberField form={form} name="woolKg" label={t('shearing.wool')} suffix={t('enums:unit.kg')} maxDigits={2} required />
              <TextField form={form} name="quality" label={t('shearing.quality')} />
              <ComboboxField
                form={form}
                name="itemId"
                label={t('shearing.item')}
                required
                loadOptions={apiOptions<LookupRow>('/inventory/items/lookup', (i) => ({ value: i.id, label: i.name }), { category: 'product' })}
              />
            </FormGrid>
            <ComboboxField
              form={form}
              name="warehouseId"
              label={t('exits.warehouse')}
              required
              loadOptions={apiOptions<LookupRow>('/inventory/warehouses/lookup', (w) => ({ value: w.id, label: w.name }), { type: 'finished_goods' })}
            />
          </>
        )}
      </FormDialog>
    </div>
  );
}
