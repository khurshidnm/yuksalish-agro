import { CROP_FAMILIES } from '@yap/shared';
import { FERTILISER_SOURCE } from '@yap/shared/formulas/fertiliser';
import { Pencil, Sprout } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, DataTableView, FormDialog, FormGrid, NumberField, SelectField } from '@/components';
import { Alert, Badge } from '@/components/ui';
import { useLocalName } from '@/features/farm/utils';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatNumber } from '@/lib/format';
import { zOptionalEnum } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useList } from '@/lib/query';
import { CROPS, PLANS } from './options';
import type { CropRef } from './types';

/** Chemical notation reads the same in every script, so it stays out of the dictionaries. */
const REMOVAL = [
  ['removalNKgT', 'n', 'N'],
  ['removalP2o5KgT', 'p2o5', 'P₂O₅'],
  ['removalK2oKgT', 'k2o', 'K₂O'],
] as const;

const zRemoval = () =>
  z
    .number()
    .min(0)
    .max(500)
    .nullish()
    .transform((v) => v ?? null);

const schema = z.object({
  family: zOptionalEnum(CROP_FAMILIES),
  removalNKgT: zRemoval(),
  removalP2o5KgT: zRemoval(),
  removalK2oKgT: zRemoval(),
});

/**
 * The farm's crops with what the agronomy rules read from them: the rotation family and the
 * nutrients a tonne of produce removes. Empty fields fall back to typical values, shown as such.
 */
export function CropsTab() {
  const { t } = useTranslation('crops');
  const localName = useLocalName();
  const canUpdate = usePermission('crops.update');
  const [editing, setEditing] = useState<CropRef | null>(null);
  const { data, isLoading, error, refetch } = useList<CropRef>(CROPS);

  const save = useApiMutation<z.output<typeof schema>>({
    mutationFn: (values) => api.patch(`${CROPS}/${editing!.id}`, values),
    // The field card's fertiliser rate and the plan form's rotation notes read these.
    invalidate: [CROPS, PLANS, '/farm/fields'],
    silentError: true,
  });

  const family = (crop: CropRef) => {
    const value = crop.family ?? crop.typical.family;
    if (!value) return '—';
    return (
      <span className="inline-flex flex-wrap items-center justify-end gap-1.5 md:justify-start">
        {t(`enums:cropFamily.${value}`)}
        {!crop.family && <Badge variant="outline">{t('cropRef.typical')}</Badge>}
      </span>
    );
  };
  const ownRemoval = (crop: CropRef) => REMOVAL.some(([field]) => crop[field] !== null);
  const removal = (crop: CropRef, field: (typeof REMOVAL)[number][0], key: (typeof REMOVAL)[number][1]) =>
    formatNumber(ownRemoval(crop) ? crop[field] : (crop.typical.removal?.[key] ?? null), 1);

  const columns: Column<CropRef>[] = [
    { key: 'name', header: t('cropRef.name'), cell: (crop) => localName(crop.name), mobile: 'title' },
    { key: 'family', header: t('cropRef.family'), cell: family },
    ...REMOVAL.map(
      ([field, key, formula]): Column<CropRef> => ({
        key: field,
        header: t('cropRef.removal', { formula }),
        align: 'right',
        cell: (crop) => removal(crop, field, key),
      }),
    ),
    {
      key: 'source',
      header: t('cropRef.source'),
      cell: (crop) =>
        ownRemoval(crop) ? t('cropRef.own') : crop.typical.removal ? <Badge variant="outline">{t('cropRef.typical')}</Badge> : '—',
    },
  ];

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('cropRef.hint')}</p>
      <DataTableView<CropRef>
        rows={data?.data ?? []}
        columns={columns}
        loading={isLoading}
        error={error ?? undefined}
        onRetry={() => void refetch()}
        empty={{ icon: Sprout, title: t('cropRef.emptyTitle'), description: t('cropRef.emptyBody') }}
        rowActions={(row) => [{ label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(row) }]}
      />
      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editing ? t('cropRef.edit', { name: localName(editing.name) }) : ''}
        schema={schema}
        defaultValues={{
          family: editing?.family ?? '',
          removalNKgT: editing?.removalNKgT ?? null,
          removalP2o5KgT: editing?.removalP2o5KgT ?? null,
          removalK2oKgT: editing?.removalK2oKgT ?? null,
        }}
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage="common:toast.updated"
      >
        {(form) => (
          <>
            <SelectField
              form={form}
              name="family"
              label={t('cropRef.family')}
              hint={t('cropRef.familyHint')}
              options={enumOptions('cropFamily', CROP_FAMILIES)}
              placeholder={
                editing?.typical.family ? t('cropRef.typicalValue', { value: t(`enums:cropFamily.${editing.typical.family}`) }) : t('cropRef.notSet')
              }
            />
            <FormGrid>
              {REMOVAL.map(([field, key, formula]) => {
                const typical = editing?.typical.removal?.[key];
                return (
                  <NumberField
                    key={field}
                    form={form}
                    name={field}
                    label={t('cropRef.removal', { formula })}
                    suffix={t('cropRef.kgT')}
                    maxDigits={1}
                    hint={typical === undefined ? t('cropRef.noTypical') : t('cropRef.typicalValue', { value: formatNumber(typical, 1) })}
                  />
                );
              })}
            </FormGrid>
            <Alert tone="info">{t('cropRef.removalHint', { source: FERTILISER_SOURCE })}</Alert>
          </>
        )}
      </FormDialog>
    </div>
  );
}
