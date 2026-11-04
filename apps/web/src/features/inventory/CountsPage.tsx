import { todayIso } from '@yap/shared';
import { ClipboardList, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, Badge, Button, DataTable, DateField, FormDialog, PageHeader, SelectField, TextareaField, useUrlParam } from '@/components';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber } from '@/lib/format';
import { zDate, zOptionalText, zRef } from '@/lib/forms';
import { useApiMutation } from '@/lib/query';
import { CountDialog } from './CountDialog';
import { useWarehouseOptions } from './shared';
import type { CountDetail, CountRow } from './types';

const PATH = '/inventory/counts';

const schema = z.object({ warehouseId: zRef(), date: zDate(), notes: zOptionalText(1000) });
type FormOut = z.output<typeof schema>;

export default function CountsPage() {
  const { t } = useTranslation('inventory');
  const canCreate = usePermission('inventory.create');
  const warehouses = useWarehouseOptions();
  const [countId, setCountId] = useUrlParam('count');
  const [creating, setCreating] = useState(false);

  const create = useApiMutation<FormOut, CountDetail>({
    mutationFn: (values) => api.post(PATH, values),
    invalidate: [PATH],
    silentError: true,
    onSuccess: (count) => setCountId(count.id),
  });

  const columns: Column<CountRow>[] = [
    { key: 'docNo', header: t('counts.document'), cell: (row) => row.docNo ?? '—', mobile: 'title' },
    { key: 'date', header: t('counts.date'), cell: (row) => formatDate(row.date), sortable: true, mobile: 'subtitle' },
    { key: 'warehouse', header: t('counts.warehouse'), cell: (row) => row.warehouseName },
    { key: 'lines', header: t('counts.lines'), align: 'right', cell: (row) => formatNumber(row.lines, 0) },
    {
      key: 'status',
      header: t('counts.status'),
      cell: (row) => <Badge variant={row.status === 'approved' ? 'success' : 'warning'}>{t(`counts.statuses.${row.status}`)}</Badge>,
    },
  ];

  const addButton = canCreate && (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('counts.add')}
    </Button>
  );

  return (
    <>
      <PageHeader title={t('counts.title')} description={t('counts.description')} actions={addButton} />

      <DataTable<CountRow>
        path={PATH}
        columns={columns}
        searchable={false}
        defaultSort="-date"
        onRowClick={(row) => setCountId(row.id)}
        empty={{ icon: ClipboardList, title: t('counts.emptyTitle'), description: t('counts.emptyBody'), action: addButton }}
      />

      <FormDialog
        open={creating}
        onOpenChange={setCreating}
        title={t('counts.add')}
        description={t('counts.addHint')}
        schema={schema}
        defaultValues={{ warehouseId: '', date: todayIso(), notes: '' }}
        onSubmit={(values) => create.mutateAsync(values)}
        submitLabel={t('counts.start')}
      >
        {(form) => (
          <>
            <SelectField form={form} name="warehouseId" label={t('counts.warehouse')} required options={warehouses} />
            <DateField form={form} name="date" label={t('counts.date')} required max={todayIso()} />
            <TextareaField form={form} name="notes" label={t('document.notes')} rows={2} />
          </>
        )}
      </FormDialog>

      {countId && <CountDialog id={countId} onClose={() => setCountId('')} />}
    </>
  );
}
