import { todayIso } from '@yap/shared';
import { Sprout, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, ComboboxField, DataTable, DateField, FormDialog, TextareaField } from '@/components';
import { Badge, Button, apiOptions } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber } from '@/lib/format';
import { zDate, zOptionalText, zRef } from '@/lib/forms';
import { useApiMutation } from '@/lib/query';
import type { HerdLookup } from './shared';

const PATH = '/livestock/pasture-moves';

interface PastureRow {
  id: string;
  herdName: string;
  fieldNumber: string;
  fieldName: string | null;
  areaHa: number;
  outDate: string;
  returnDate: string | null;
  headCount: number;
  stockingRate: number | null;
}

const schema = z.object({ herdId: zRef(), fieldId: zRef(), outDate: zDate(), notes: zOptionalText(500) });
type Output = z.output<typeof schema>;

export function PasturePanel() {
  const { t } = useTranslation('livestock');
  const canManage = usePermission('livestock.update');
  const [sending, setSending] = useState(false);

  const invalidate = [PATH, '/livestock/herds'];
  const send = useApiMutation<Output>({ mutationFn: (values) => api.post(PATH, values), invalidate, silentError: true });
  const bring = useApiMutation<string>({
    mutationFn: (id) => api.post(`${PATH}/${id}/return`, {}),
    invalidate,
    successMessage: 'livestock:pasture.returned',
  });

  const columns: Column<PastureRow>[] = [
    { key: 'herd', header: t('fields.herd'), cell: (row) => row.herdName, mobile: 'title' },
    { key: 'field', header: t('pasture.field'), cell: (row) => (row.fieldName ? `${row.fieldNumber} · ${row.fieldName}` : row.fieldNumber), mobile: 'subtitle' },
    { key: 'outDate', header: t('pasture.out'), cell: (row) => formatDate(row.outDate), sortable: true },
    {
      key: 'return',
      header: t('pasture.back'),
      cell: (row) => (row.returnDate ? formatDate(row.returnDate) : <Badge variant="success">{t('pasture.onPasture')}</Badge>),
    },
    { key: 'area', header: t('pasture.area'), cell: (row) => `${formatNumber(row.areaHa, 1)} ${t('pasture.ha')}`, align: 'right', mobile: 'hidden' },
    { key: 'rate', header: t('pasture.stockingRate'), cell: (row) => (row.stockingRate === null ? '—' : `${formatNumber(row.stockingRate, 2)} ${t('pasture.headPerHa')}`), align: 'right' },
  ];

  return (
    <div className="space-y-3">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setSending(true)}>
            <Sprout aria-hidden />
            {t('pasture.send')}
          </Button>
        </div>
      )}
      <DataTable<PastureRow>
        path={PATH}
        urlPrefix="p"
        columns={columns}
        defaultSort="-outDate"
        searchable={false}
        rowActions={(row) => [
          { label: t('pasture.bringBack'), icon: Undo2, hidden: !canManage || !!row.returnDate, onClick: () => bring.mutate(row.id) },
        ]}
        empty={{ icon: Sprout, title: t('pasture.emptyTitle'), description: t('pasture.emptyBody') }}
      />
      <FormDialog
        open={sending}
        onOpenChange={setSending}
        title={t('pasture.send')}
        schema={schema}
        defaultValues={{ herdId: '', fieldId: '', outDate: todayIso(), notes: '' }}
        onSubmit={(values) => send.mutateAsync(values)}
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
            <ComboboxField
              form={form}
              name="fieldId"
              label={t('pasture.field')}
              required
              loadOptions={apiOptions<{ id: string; number: string; name: string | null; areaHa: number }>(
                '/farm/fields/lookup',
                (f) => ({ value: f.id, label: f.name ? `${f.number} · ${f.name}` : f.number, hint: `${formatNumber(f.areaHa, 1)} ${t('pasture.ha')}` }),
                { landUse: 'pasture' },
              )}
            />
            <DateField form={form} name="outDate" label={t('pasture.out')} required max={todayIso()} />
            <TextareaField form={form} name="notes" label={t('fields.notes')} />
          </>
        )}
      </FormDialog>
    </div>
  );
}
