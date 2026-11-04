import { LAND_USES } from '@yap/shared';
import type { Geometry } from 'geojson';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormDialog, FormGrid, NumberField, SelectField, TextField, TextareaField } from '@/components';
import { Alert } from '@/components/ui';
import { api } from '@/lib/api';
import { zEnum, zOptionalNumber, zOptionalText, zPositive, zText } from '@/lib/forms';
import i18n, { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import type { EditableField, LandUse } from './types';
import { formatHa } from './utils';

export const FIELD_PATHS = ['/farm/fields', '/farm/map', '/farm/passport'];

const SALINITY = ['none', 'low', 'medium', 'high'] as const;

function makeSchema(areaFromMap: boolean) {
  return z.object({
    number: zText(20),
    name: zOptionalText(120),
    landUse: zEnum(LAND_USES),
    // With an outline the server measures the area, so the form has nothing to require.
    areaHa: areaFromMap ? zOptionalNumber() : zPositive(),
    soilType: zOptionalText(80),
    salinityLevel: zOptionalText(40),
    irrigationSource: zOptionalText(120),
    notes: zOptionalText(1000),
  });
}

export interface SavedField {
  id: string;
  number: string;
  areaHa: number;
  /** Contours this one shares ground with; their area counts twice in the land balance. */
  overlaps: { number: string; overlapHa: number }[];
}

/** Warn after a save if the contour overlaps others. The save itself stands. */
export function warnAboutOverlaps(saved: Pick<SavedField, 'overlaps'>): void {
  for (const overlap of saved.overlaps) {
    toast.warning(i18n.t('farm:map.overlap', { number: overlap.number, area: formatHa(overlap.overlapHa) }));
  }
}

export interface FieldFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The contour being edited. Omit to create one. */
  field?: EditableField | null;
  /** Outline just drawn on the map. */
  boundary?: Geometry | null;
  /** Browser estimate of that outline, until the server measures it. */
  previewAreaHa?: number | null;
  defaultLandUse?: LandUse;
  onSaved?: (field: SavedField) => void;
}

export function FieldFormDialog({ open, onOpenChange, field, boundary, previewAreaHa, defaultLandUse = 'arable', onSaved }: FieldFormDialogProps) {
  const { t } = useTranslation('farm');
  const areaFromMap = Boolean(boundary ?? field?.hasBoundary);
  const schema = makeSchema(areaFromMap);

  const save = useApiMutation<z.output<typeof schema>, SavedField>({
    mutationFn: ({ areaHa, ...values }) => {
      const body = { ...values, ...(boundary ? { boundary } : {}), ...(areaFromMap ? {} : { areaHa }) };
      return field ? api.patch(`/farm/fields/${field.id}`, body) : api.post('/farm/fields', body);
    },
    invalidate: FIELD_PATHS,
    silentError: true,
    onSuccess: (saved) => {
      onSaved?.(saved);
      warnAboutOverlaps(saved);
    },
  });

  const defaults = {
    number: field?.number ?? '',
    name: field?.name ?? '',
    landUse: field?.landUse ?? defaultLandUse,
    areaHa: field?.areaHa ?? null,
    soilType: field?.soilType ?? '',
    salinityLevel: field?.salinityLevel ?? '',
    irrigationSource: field?.irrigationSource ?? '',
    notes: field?.notes ?? '',
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={field ? t('fields.edit') : t('fields.add')}
      schema={schema}
      defaultValues={defaults as never}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage={onSaved ? undefined : field ? 'common:toast.updated' : 'common:toast.created'}
      size="lg"
    >
      {(form) => (
        <>
          {boundary && previewAreaHa != null && <Alert tone="info">{t('map.previewArea', { area: formatHa(previewAreaHa) })}</Alert>}
          <FormGrid>
            <TextField form={form} name="number" label={t('fields.number')} required autoFocus />
            <TextField form={form} name="name" label={t('fields.name')} />
            <SelectField form={form} name="landUse" label={t('fields.landUse')} required options={enumOptions('landUse', LAND_USES)} />
            <NumberField
              form={form}
              name="areaHa"
              label={t('fields.areaHa')}
              required={!areaFromMap}
              suffix={t('unit.haShort')}
              maxDigits={4}
              disabled={areaFromMap}
              hint={areaFromMap ? t('fields.areaFromMapHint') : t('fields.areaManualHint')}
            />
            <TextField form={form} name="soilType" label={t('fields.soilType')} />
            <SelectField
              form={form}
              name="salinityLevel"
              label={t('fields.salinityLevel')}
              options={SALINITY.map((value) => ({ value, label: t(`salinity.${value}`) }))}
            />
          </FormGrid>
          <TextField form={form} name="irrigationSource" label={t('fields.irrigationSource')} />
          <TextareaField form={form} name="notes" label={t('notes')} rows={3} />
        </>
      )}
    </FormDialog>
  );
}
