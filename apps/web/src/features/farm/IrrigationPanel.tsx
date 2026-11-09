import { IRRIGATION_NODE_TYPES } from '@yap/shared';
import { Droplets, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, DataTable, FormDialog, FormField, FormGrid, NumberField, SelectField, TextField, TextareaField, useConfirm, useUrlParam } from '@/components';
import { Badge, Button, Checkbox, Label, Meter, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatNumber, formatPercent } from '@/lib/format';
import { zEnum, zOptionalNumber, zOptionalText, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import type { IrrigationNode } from './types';

const PATH = '/farm/irrigation';

const schema = z.object({
  type: zEnum(IRRIGATION_NODE_TYPES),
  name: zText(120),
  capacityM3h: zOptionalNumber(),
  limitM3: zOptionalNumber(),
  fieldIds: z.array(z.string()),
  notes: zOptionalText(1000),
});

interface FieldOption {
  id: string;
  name: string;
}

function toForm(node: IrrigationNode | null): z.input<typeof schema> {
  return {
    type: node?.type ?? 'canal',
    name: node?.name ?? '',
    capacityM3h: node?.capacityM3h ?? null,
    limitM3: node?.limitM3 ?? null,
    fieldIds: node?.fieldIds ?? [],
    notes: node?.notes ?? '',
  };
}

const m3 = (value: number | null | undefined) => (value == null ? '—' : `${formatNumber(value, 0)} m³`);

export function IrrigationPanel() {
  const { t } = useTranslation('farm');
  const canCreate = usePermission('farm.create');
  const canUpdate = usePermission('farm.update');
  const canDelete = usePermission('farm.delete');
  const confirm = useConfirm();

  const thisYear = new Date().getFullYear();
  const [year, setYear] = useUrlParam('year', String(thisYear));
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<IrrigationNode | null>(null);
  const open = creating || editing !== null;

  const fields = useDetail<FieldOption[]>('/farm/fields/lookup', { landUse: 'arable' });
  const fieldNames = new Map((fields.data ?? []).map((f) => [f.id, f.name]));

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: [PATH],
    successMessage: 'common:toast.deleted',
  });

  const save = useApiMutation<z.output<typeof schema>>({
    mutationFn: (values) => (editing ? api.patch(`${PATH}/${editing.id}`, values) : api.post(PATH, values)),
    invalidate: [PATH],
    silentError: true,
  });

  const columns: Column<IrrigationNode>[] = [
    { key: 'name', header: t('irrigation.name'), cell: (row) => row.name, sortable: true, mobile: 'title' },
    { key: 'type', header: t('irrigation.type'), cell: (row) => <Badge>{t(`enums:irrigationNodeType.${row.type}`)}</Badge>, sortable: true, mobile: 'subtitle' },
    {
      key: 'fields',
      header: t('irrigation.fields'),
      cell: (row) => (row.fieldIds.length ? row.fieldIds.map((id) => fieldNames.get(id) ?? '—').join(', ') : '—'),
    },
    { key: 'capacity', header: t('irrigation.capacity'), cell: (row) => (row.capacityM3h == null ? '—' : `${formatNumber(row.capacityM3h)} m³/${t('unit.hourShort')}`), mobile: 'hidden' },
    {
      key: 'usage',
      header: t('irrigation.usage'),
      className: 'min-w-52',
      cell: (row) => (
        <div className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center justify-end gap-x-2 text-sm md:justify-start">
            {m3(row.actualM3)} / {m3(row.limitM3)}
            {row.usedPercent != null && <span className={row.overLimit ? 'font-medium text-danger' : 'text-muted-foreground'}>{formatPercent(row.usedPercent, 0)}</span>}
          </span>
          {row.usedPercent != null && (
            <Meter
              value={row.usedPercent}
              tone={row.overLimit ? 'danger' : row.usedPercent >= 85 ? 'warning' : 'primary'}
              label={t('irrigation.usage')}
            />
          )}
        </div>
      ),
    },
  ];

  const addButton = canCreate && (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('irrigation.add')}
    </Button>
  );

  return (
    <>
      <div className="mb-3 flex justify-end empty:hidden">{addButton}</div>
      <DataTable<IrrigationNode>
        path={PATH}
        urlPrefix="net"
        params={{ from: `${year}-01-01`, to: `${year}-12-31` }}
        columns={columns}
        searchPlaceholder={t('irrigation.searchPlaceholder')}
        filters={
          <Select
            aria-label={t('irrigation.yearFilter')}
            value={year}
            onChange={(e) => setYear(e.target.value)}
            options={[0, 1, 2].map((back) => ({ value: String(thisYear - back), label: String(thisYear - back) }))}
            className="md:w-32"
          />
        }
        empty={{ icon: Droplets, title: t('irrigation.emptyTitle'), description: t('irrigation.emptyBody') }}
        rowActions={(row) => [
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(row) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({
                title: t('irrigation.deleteTitle'),
                description: t('irrigation.deleteBody', { name: row.name }),
                destructive: true,
              });
              if (ok) remove.mutate(row.id);
            },
          },
        ]}
      />

      <FormDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            setCreating(false);
            setEditing(null);
          }
        }}
        title={editing ? t('irrigation.edit') : t('irrigation.add')}
        schema={schema}
        defaultValues={toForm(editing)}
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
        size="lg"
      >
        {(form) => (
          <>
            <FormGrid>
              <SelectField form={form} name="type" label={t('irrigation.type')} required options={enumOptions('irrigationNodeType', IRRIGATION_NODE_TYPES)} />
              <TextField form={form} name="name" label={t('irrigation.name')} required autoFocus />
              <NumberField form={form} name="capacityM3h" label={t('irrigation.capacity')} suffix={`m³/${t('unit.hourShort')}`} />
              <NumberField form={form} name="limitM3" label={t('irrigation.limit')} suffix="m³" hint={t('irrigation.limitHint')} />
            </FormGrid>
            <FormField form={form} name="fieldIds" label={t('irrigation.fields')}>
              {(field) => (
                <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-2">
                  {(fields.data ?? []).map((option) => {
                    const checked = (field.value as string[]).includes(option.id);
                    const id = `${field.id}-${option.id}`;
                    return (
                      <li key={option.id} className="flex min-h-11 items-center gap-2 md:min-h-8">
                        <Checkbox
                          id={id}
                          checked={checked}
                          onCheckedChange={(next) =>
                            field.onChange(next ? [...(field.value as string[]), option.id] : (field.value as string[]).filter((v) => v !== option.id))
                          }
                        />
                        <Label htmlFor={id} className="font-normal">
                          {option.name}
                        </Label>
                      </li>
                    );
                  })}
                  {fields.data?.length === 0 && <li className="p-1 text-sm text-muted-foreground">{t('irrigation.noFields')}</li>}
                </ul>
              )}
            </FormField>
            <TextareaField form={form} name="notes" label={t('notes')} rows={3} />
          </>
        )}
      </FormDialog>
    </>
  );
}
