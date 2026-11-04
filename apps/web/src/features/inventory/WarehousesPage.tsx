import { WAREHOUSE_TYPES } from '@yap/shared';
import { Pencil, Plus, Trash2, Warehouse } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, Badge, Button, DataTable, FormDialog, PageHeader, SelectField, TextField, TextareaField, useConfirm } from '@/components';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatMoney, formatNumber } from '@/lib/format';
import { zEnum, zOptionalRef, zOptionalText, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { STOCK_PATHS } from './shared';
import type { WarehouseRow } from './types';

const PATH = '/inventory/warehouses';

const schema = z.object({
  name: zText(120),
  type: zEnum(WAREHOUSE_TYPES),
  facilityId: zOptionalRef(),
  notes: zOptionalText(1000),
});

type FormIn = z.input<typeof schema>;
type FormOut = z.output<typeof schema>;

const EMPTY: FormIn = { name: '', type: 'feed', facilityId: null, notes: '' };

export default function WarehousesPage() {
  const { t } = useTranslation('inventory');
  const canSave = usePermission('inventory.update');
  const canDelete = usePermission('inventory.delete');
  const canSeeMoney = usePermission('finance.view');
  const confirm = useConfirm();
  const facilities = useDetail<{ id: string; name: string }[]>('/farm/facilities/lookup');

  const [editing, setEditing] = useState<WarehouseRow | null>(null);
  const [creating, setCreating] = useState(false);

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: STOCK_PATHS,
    successMessage: 'common:toast.deleted',
  });
  const save = useApiMutation<FormOut>({
    mutationFn: (values) => (editing ? api.patch(`${PATH}/${editing.id}`, values) : api.post(PATH, values)),
    invalidate: STOCK_PATHS,
    silentError: true,
  });

  const columns: Column<WarehouseRow>[] = [
    { key: 'name', header: t('warehouses.fields.name'), cell: (row) => row.name, sortable: true, mobile: 'title' },
    { key: 'type', header: t('warehouses.fields.type'), cell: (row) => <Badge>{t(`enums:warehouseType.${row.type}`)}</Badge>, sortable: true, mobile: 'subtitle' },
    { key: 'positions', header: t('warehouses.positions'), align: 'right', cell: (row) => formatNumber(row.positions, 0) },
    ...(canSeeMoney ? [{ key: 'value', header: t('warehouses.value'), align: 'right' as const, cell: (row: WarehouseRow) => formatMoney(row.value) }] : []),
  ];

  const addButton = canSave && (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('warehouses.add')}
    </Button>
  );

  return (
    <>
      <PageHeader title={t('warehouses.title')} description={t('warehouses.description')} actions={addButton} />

      <DataTable<WarehouseRow>
        path={PATH}
        columns={columns}
        defaultSort="name"
        searchPlaceholder={t('warehouses.searchPlaceholder')}
        empty={{ icon: Warehouse, title: t('warehouses.emptyTitle'), description: t('warehouses.emptyBody'), action: addButton }}
        rowActions={(row) => [
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canSave, onClick: () => setEditing(row) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({ title: t('warehouses.deleteTitle'), description: t('warehouses.deleteBody', { name: row.name }), destructive: true });
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
        title={editing ? t('warehouses.edit') : t('warehouses.add')}
        schema={schema}
        defaultValues={editing ? { ...EMPTY, ...editing, type: editing.type as FormIn['type'] } : EMPTY}
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
      >
        {(form) => (
          <>
            <TextField form={form} name="name" label={t('warehouses.fields.name')} required autoFocus />
            <SelectField form={form} name="type" label={t('warehouses.fields.type')} required options={enumOptions('warehouseType', WAREHOUSE_TYPES)} />
            <SelectField
              form={form}
              name="facilityId"
              label={t('warehouses.fields.facility')}
              options={(facilities.data ?? []).map((f) => ({ value: f.id, label: f.name }))}
            />
            <TextareaField form={form} name="notes" label={t('warehouses.fields.notes')} rows={2} />
          </>
        )}
      </FormDialog>
    </>
  );
}
