import { CalendarRange, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, DataTableView, DateField, FormDialog, FormGrid, SelectField, SwitchField, TextField, useConfirm } from '@/components';
import { Badge, Button } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { zDate, zEnum, zText } from '@/lib/forms';
import i18n from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { SEASONS } from './options';
import type { Season } from './types';

const KINDS = ['autumn', 'spring', 'summer'] as const;

const schema = z
  .object({
    name: zText(120),
    kind: zEnum(KINDS),
    startDate: zDate(),
    endDate: zDate(),
    isCurrent: z.boolean(),
  })
  // A function, so the message follows the language at validation time, not at load.
  .refine((v) => v.endDate >= v.startDate, { path: ['endDate'], error: () => i18n.t('crops:errors.INVALID_PERIOD') });

export function SeasonsTab() {
  const { t } = useTranslation('crops');
  const canCreate = usePermission('crops.create');
  const canUpdate = usePermission('crops.update');
  const canDelete = usePermission('crops.delete');
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Season | null>(null);
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error, refetch } = useDetail<Season[]>(SEASONS);

  const save = useApiMutation<z.output<typeof schema>>({
    mutationFn: (values) => (editing ? api.patch(`${SEASONS}/${editing.id}`, values) : api.post(SEASONS, values)),
    invalidate: [SEASONS],
    silentError: true,
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${SEASONS}/${id}`),
    invalidate: [SEASONS],
    successMessage: 'common:toast.deleted',
  });

  const columns: Column<Season>[] = [
    { key: 'name', header: t('seasons.fields.name'), mobile: 'title', cell: (s) => s.name },
    { key: 'kind', header: t('seasons.fields.kind'), mobile: 'subtitle', cell: (s) => t(`seasons.kind.${s.kind}`) },
    { key: 'period', header: t('seasons.fields.period'), cell: (s) => `${formatDate(s.startDate)} — ${formatDate(s.endDate)}` },
    { key: 'current', header: '', cell: (s) => (s.isCurrent ? <Badge variant="success">{t('seasons.current')}</Badge> : null) },
  ];

  const addButton = canCreate && (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('seasons.add')}
    </Button>
  );

  return (
    <div className="space-y-3">
      {(data?.length ?? 0) > 0 && <div className="flex justify-end">{addButton}</div>}
      <DataTableView<Season>
        rows={data ?? []}
        columns={columns}
        loading={isLoading}
        error={error ?? undefined}
        onRetry={() => void refetch()}
        empty={{ icon: CalendarRange, title: t('seasons.emptyTitle'), description: t('seasons.emptyBody'), action: addButton }}
        rowActions={(row) => [
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(row) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({ title: t('seasons.deleteTitle'), description: row.name, destructive: true });
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
        title={editing ? t('seasons.edit') : t('seasons.add')}
        schema={schema}
        defaultValues={
          editing
            ? { name: editing.name, kind: editing.kind, startDate: editing.startDate, endDate: editing.endDate, isCurrent: editing.isCurrent }
            : { name: '', kind: 'autumn', startDate: '', endDate: '', isCurrent: false }
        }
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
      >
        {(form) => (
          <>
            <TextField form={form} name="name" label={t('seasons.fields.name')} required autoFocus />
            <SelectField form={form} name="kind" label={t('seasons.fields.kind')} required options={KINDS.map((value) => ({ value, label: t(`seasons.kind.${value}`) }))} />
            <FormGrid>
              <DateField form={form} name="startDate" label={t('seasons.fields.start')} required />
              <DateField form={form} name="endDate" label={t('seasons.fields.end')} required />
            </FormGrid>
            <SwitchField form={form} name="isCurrent" label={t('seasons.fields.isCurrent')} hint={t('seasons.fields.isCurrentHint')} />
          </>
        )}
      </FormDialog>
    </div>
  );
}
