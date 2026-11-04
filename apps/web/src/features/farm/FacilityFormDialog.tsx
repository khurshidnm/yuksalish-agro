import { FACILITY_TYPES } from '@yap/shared';
import type { Geometry } from 'geojson';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { FormDialog, FormGrid, NumberField, SelectField, TextField, TextareaField } from '@/components';
import { api } from '@/lib/api';
import { zEnum, zOptionalNumber, zOptionalRef, zOptionalText, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import type { Facility, FacilityType } from './types';

export const FACILITY_PATHS = ['/farm/facilities', '/farm/map'];

const schema = z.object({
  type: zEnum(FACILITY_TYPES),
  name: zText(120),
  capacity: zOptionalNumber(),
  capacityUnit: zOptionalText(20),
  parentId: zOptionalRef(),
  lat: zOptionalNumber(),
  lng: zOptionalNumber(),
  notes: zOptionalText(1000),
});

type LookupFacility = { id: string; name: string; type: FacilityType; parentId: string | null };

export interface FacilityFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facility?: Facility | null;
  /** Outline just drawn on the map. */
  boundary?: Geometry | null;
  /** Point just placed on the map. */
  point?: { lat: number; lng: number } | null;
  onSaved?: () => void;
}

export function FacilityFormDialog({ open, onOpenChange, facility, boundary, point, onSaved }: FacilityFormDialogProps) {
  const { t } = useTranslation('farm');
  const barns = useDetail<LookupFacility[]>(open ? '/farm/facilities/lookup' : null, { type: 'barn' });
  // A section sits directly under a barn, and a barn cannot be its own section.
  const parents = (barns.data ?? []).filter((b) => !b.parentId && b.id !== facility?.id);

  const save = useApiMutation<z.output<typeof schema>>({
    mutationFn: (values) => {
      const body = { ...values, ...(boundary ? { boundary } : {}) };
      return facility ? api.patch(`/farm/facilities/${facility.id}`, body) : api.post('/farm/facilities', body);
    },
    invalidate: FACILITY_PATHS,
    silentError: true,
    onSuccess: () => onSaved?.(),
  });

  const defaults: z.input<typeof schema> = {
    type: facility?.type ?? 'barn',
    name: facility?.name ?? '',
    capacity: facility?.capacity ?? null,
    capacityUnit: facility?.capacityUnit ?? '',
    parentId: facility?.parentId ?? '',
    lat: point?.lat ?? facility?.lat ?? null,
    lng: point?.lng ?? facility?.lng ?? null,
    notes: facility?.notes ?? '',
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={facility ? t('facilities.edit') : t('facilities.add')}
      schema={schema}
      defaultValues={defaults}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage={facility ? 'common:toast.updated' : 'common:toast.created'}
      size="lg"
    >
      {(form) => (
        <>
          <FormGrid>
            <SelectField form={form} name="type" label={t('facilities.type')} required options={enumOptions('facilityType', FACILITY_TYPES)} />
            <TextField form={form} name="name" label={t('facilities.name')} required autoFocus />
            <NumberField form={form} name="capacity" label={t('facilities.capacity')} maxDigits={0} />
            <TextField form={form} name="capacityUnit" label={t('facilities.capacityUnit')} placeholder={t('facilities.capacityUnitHint')} />
          </FormGrid>
          {form.watch('type') === 'barn' && (
            <SelectField
              form={form}
              name="parentId"
              label={t('facilities.parent')}
              hint={t('facilities.parentHint')}
              placeholder={t('facilities.noParent')}
              options={parents.map((b) => ({ value: b.id, label: b.name }))}
            />
          )}
          {!boundary && (
            <FormGrid>
              <NumberField form={form} name="lat" label={t('facilities.lat')} maxDigits={7} />
              <NumberField form={form} name="lng" label={t('facilities.lng')} maxDigits={7} />
            </FormGrid>
          )}
          <TextareaField form={form} name="notes" label={t('notes')} rows={3} />
        </>
      )}
    </FormDialog>
  );
}
