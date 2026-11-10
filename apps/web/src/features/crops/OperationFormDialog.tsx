import { todayIso } from '@yap/shared';
import { LEACHING_SOURCE, leachingNorm } from '@yap/shared/formulas/salinity';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { type UseFormReturn, useFieldArray, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import {
  ComboboxField,
  DateField,
  FormDialog,
  FormField,
  FormGrid,
  NumberField,
  SelectField,
  SwitchField,
  TextField,
  TextareaField,
} from '@/components';
import { Alert, Button, Separator } from '@/components/ui';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { zDate, zOptionalEnum, zOptionalNumber, zOptionalRef, zOptionalText, zPositive, zRef } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';
import { GpsCapture, PhotoCapture } from './FieldCapture';
import {
  AFFECTED_BY_WORK,
  FIELD_LOOKUP,
  type FieldOption,
  type ItemOption,
  MATERIAL_CATEGORY,
  OPERATIONS,
  WORK_FIELDS,
  assetOptions,
  employeeOptions,
  fieldOptions,
  itemOptions,
  warehouseOptions,
} from './options';
import type { Operation } from './types';

const CONDITIONS = ['good', 'fair', 'poor'] as const;
const TILLAGE_METHODS = ['plowing', 'leveling', 'harrowing'] as const;

/** Detail keys each type stores, so switching forms never sends stale values. */
const DETAIL_KEYS: Record<string, string[]> = {
  tillage: ['method'],
  sowing: ['variety', 'seedRateKgHa'],
  irrigation: ['waterSource'],
  leaching: ['waterSource'],
  fertilizing: [],
  protection: ['target', 'dose', 'doseUnit', 'withdrawalDays'],
  observation: ['condition', 'pests', 'diseases'],
  harvest: [],
};

const schema = z.object({
  planned: z.boolean(),
  date: zDate(),
  fieldId: zRef(),
  assetId: zOptionalRef(),
  employeeId: zOptionalRef(),
  areaDoneHa: zOptionalNumber(),
  durationH: zOptionalNumber(),
  fuelL: zOptionalNumber(),
  waterM3: zOptionalNumber(),
  details: z.object({
    method: zOptionalEnum(TILLAGE_METHODS),
    variety: zOptionalText(120),
    seedRateKgHa: zOptionalNumber(),
    waterSource: zOptionalText(120),
    target: zOptionalText(120),
    dose: zOptionalNumber(),
    doseUnit: zOptionalText(20),
    withdrawalDays: zOptionalNumber(),
    condition: zOptionalEnum(CONDITIONS),
    pests: zOptionalText(500),
    diseases: zOptionalText(500),
  }),
  materials: z.array(
    z.object({
      itemId: zRef(),
      itemLabel: z.string().optional(),
      warehouseId: zRef(),
      warehouseLabel: z.string().optional(),
      qty: zPositive(),
      normPerHa: zOptionalNumber(),
    }),
  ),
  lat: zOptionalNumber(),
  lng: zOptionalNumber(),
  photos: z.array(z.object({ id: z.string(), url: z.string() })),
  notes: zOptionalText(1000),
});

type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;
type Form = UseFormReturn<Values, unknown, Output>;

export type OperationMode = 'create' | 'edit' | 'complete';

function toValues(type: string, op: Operation | null | undefined, mode: OperationMode): Values {
  const d = (op?.details ?? {}) as Record<string, never>;
  return {
    planned: false,
    date: mode === 'complete' || !op ? todayIso() : op.date,
    fieldId: op?.fieldId ?? '',
    assetId: op?.assetId ?? null,
    employeeId: op?.employeeId ?? null,
    areaDoneHa: op?.areaDoneHa ?? null,
    durationH: op?.durationH ?? null,
    fuelL: op?.fuelL ?? null,
    waterM3: op?.waterM3 ?? null,
    details: {
      method: d.method ?? null,
      variety: d.variety ?? null,
      seedRateKgHa: d.seedRateKgHa ?? null,
      waterSource: d.waterSource ?? null,
      target: d.target ?? null,
      dose: d.dose ?? null,
      doseUnit: d.doseUnit ?? null,
      withdrawalDays: d.withdrawalDays ?? null,
      condition: d.condition ?? null,
      pests: d.pests ?? null,
      diseases: d.diseases ?? null,
    },
    materials:
      op?.materials.map((m) => ({
        itemId: m.itemId,
        itemLabel: m.itemName,
        warehouseId: m.warehouseId,
        warehouseLabel: m.warehouseName,
        qty: m.qty,
        normPerHa: m.normPerHa,
      })) ?? [],
    lat: op?.lat ?? null,
    lng: op?.lng ?? null,
    photos: op?.photos ?? [],
    notes: op?.notes ?? '',
  };
}

function toPayload(type: string, v: Output, mode: OperationMode) {
  const details = Object.fromEntries(
    (DETAIL_KEYS[type] ?? [])
      .map((key) => [key, v.details[key as keyof typeof v.details]])
      .filter(([, value]) => value !== null && value !== undefined),
  );
  const fields = WORK_FIELDS[type] ?? {};
  return {
    ...(mode === 'create' ? { type, status: v.planned ? 'planned' : 'done' } : {}),
    date: v.date,
    ...(mode === 'complete' ? {} : { fieldId: v.fieldId }),
    assetId: fields.machine ? v.assetId : null,
    employeeId: v.employeeId,
    areaDoneHa: fields.area ? v.areaDoneHa : null,
    durationH: v.durationH,
    fuelL: fields.machine && v.assetId ? v.fuelL : null,
    waterM3: fields.water ? v.waterM3 : null,
    details,
    lat: v.lat,
    lng: v.lng,
    photoFileIds: v.photos.map((p) => p.id),
    notes: v.notes,
    materials: fields.materials
      ? v.materials.map((m) => ({ itemId: m.itemId, warehouseId: m.warehouseId, qty: m.qty, normPerHa: m.normPerHa }))
      : [],
  };
}

function MaterialsEditor({ form, type }: { form: Form; type: string }) {
  const { t } = useTranslation('crops');
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'materials' });
  const loadItems = useMemo(() => itemOptions(MATERIAL_CATEGORY[type]), [type]);
  const area = useWatch({ control: form.control, name: 'areaDoneHa' });
  const lines = useWatch({ control: form.control, name: 'materials' });

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">{t(`operations.materials.title.${type}`)}</legend>
      {fields.map((row, index) => {
        const qty = lines?.[index]?.qty;
        const perHa = qty && area ? qty / area : null;
        return (
          <div key={row.id} className="space-y-3 rounded-lg border border-border p-3">
            <ComboboxField
              form={form}
              name={`materials.${index}.itemId`}
              label={t('operations.materials.item')}
              required
              loadOptions={loadItems}
              selectedLabel={lines?.[index]?.itemLabel}
              onSelect={(_, option) => {
                const item = option?.raw as ItemOption | undefined;
                form.setValue(`materials.${index}.itemLabel`, option?.label);
                if (item?.defaultWarehouseId) {
                  form.setValue(`materials.${index}.warehouseId`, item.defaultWarehouseId, { shouldValidate: true });
                }
              }}
            />
            <ComboboxField
              form={form}
              name={`materials.${index}.warehouseId`}
              label={t('operations.materials.warehouse')}
              required
              loadOptions={warehouseOptions}
              selectedLabel={lines?.[index]?.warehouseLabel}
            />
            <FormGrid>
              <NumberField
                form={form}
                name={`materials.${index}.qty`}
                label={t('operations.materials.qty')}
                required
                hint={perHa === null ? undefined : t('operations.materials.perHa', { value: formatNumber(perHa, 1) })}
              />
              <NumberField form={form} name={`materials.${index}.normPerHa`} label={t('operations.materials.norm')} />
            </FormGrid>
            <Button type="button" variant="ghost" className="text-destructive" onClick={() => remove(index)}>
              <Trash2 aria-hidden />
              {t('operations.materials.remove')}
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="w-full"
        onClick={() => append({ itemId: '', warehouseId: '', qty: 0, normPerHa: null })}
      >
        <Plus aria-hidden />
        {t('operations.materials.add')}
      </Button>
    </fieldset>
  );
}

function TypeDetails({ form, type }: { form: Form; type: string }) {
  const { t } = useTranslation('crops');
  if (type === 'tillage') {
    return (
      <SelectField
        form={form}
        name="details.method"
        label={t('operations.fields.method')}
        placeholder={t('common:form.selectPlaceholder')}
        options={TILLAGE_METHODS.map((value) => ({ value, label: t(`operations.method.${value}`) }))}
      />
    );
  }
  if (type === 'sowing') {
    return (
      <FormGrid>
        <TextField form={form} name="details.variety" label={t('operations.fields.variety')} />
        <NumberField form={form} name="details.seedRateKgHa" label={t('operations.fields.seedRate')} suffix={t('unit.kgPerHa')} />
      </FormGrid>
    );
  }
  if (type === 'irrigation' || type === 'leaching') {
    return <TextField form={form} name="details.waterSource" label={t('operations.fields.waterSource')} />;
  }
  if (type === 'protection') {
    return (
      <>
        <TextField form={form} name="details.target" label={t('operations.fields.target')} hint={t('operations.fields.targetHint')} />
        <FormGrid>
          <NumberField form={form} name="details.dose" label={t('operations.fields.dose')} />
          <TextField form={form} name="details.doseUnit" label={t('operations.fields.doseUnit')} placeholder={t('operations.fields.doseUnitPlaceholder')} />
        </FormGrid>
        <NumberField
          form={form}
          name="details.withdrawalDays"
          label={t('operations.fields.withdrawalDays')}
          hint={t('operations.fields.withdrawalHint')}
          maxDigits={0}
          suffix={t('unit.days')}
        />
      </>
    );
  }
  if (type === 'observation') {
    return (
      <>
        <SelectField
          form={form}
          name="details.condition"
          label={t('operations.fields.condition')}
          placeholder={t('common:form.selectPlaceholder')}
          options={CONDITIONS.map((value) => ({ value, label: t(`operations.condition.${value}`) }))}
        />
        <TextField form={form} name="details.pests" label={t('operations.fields.pests')} />
        <TextField form={form} name="details.diseases" label={t('operations.fields.diseases')} />
      </>
    );
  }
  return null;
}

/**
 * A suggested leaching norm for the chosen field, from its salinity level and soil texture. It is
 * a published range, named beside it; what the farm actually gave is what gets recorded.
 */
function LeachingAdvice({ form }: { form: Form }) {
  const { t } = useTranslation('crops');
  const fieldId = useWatch({ control: form.control, name: 'fieldId' });
  const { data } = useDetail<FieldOption[]>(FIELD_LOOKUP, { landUse: 'arable' });
  const field = data?.find((f) => f.id === fieldId);
  if (!field) return null;
  const advice = leachingNorm(field.salinityLevel, field.soilTexture);
  if (!advice.norm) {
    return <Alert tone={advice.reason === 'capital_leaching' ? 'warning' : 'info'}>{t(`leaching.${advice.reason}`, { source: LEACHING_SOURCE })}</Alert>;
  }
  const { minM3Ha, maxM3Ha, group } = advice.norm;
  return (
    <Alert tone="info" title={t('leaching.norm', { min: formatNumber(minM3Ha, 0), max: formatNumber(maxM3Ha, 0) })}>
      <p>
        {t('leaching.forField', {
          min: formatNumber(minM3Ha * field.areaHa, 0),
          max: formatNumber(maxM3Ha * field.areaHa, 0),
          area: formatNumber(field.areaHa, 2),
        })}
      </p>
      <p>
        {t('leaching.basis', {
          salinity: t(`enums:salinityLevel.${field.salinityLevel}`),
          soil: group ? t(`leaching.group.${group}`) : t('leaching.noTexture'),
          source: LEACHING_SOURCE,
        })}
      </p>
    </Alert>
  );
}

function WorkFields({ form, type, operation }: { form: Form; type: string; operation?: Operation | null }) {
  const { t } = useTranslation('crops');
  const fields = WORK_FIELDS[type] ?? {};
  const assetId = useWatch({ control: form.control, name: 'assetId' });
  const planned = useWatch({ control: form.control, name: 'planned' });

  return (
    <>
      {fields.machine && (
        <ComboboxField
          form={form}
          name="assetId"
          label={t('operations.fields.machine')}
          loadOptions={assetOptions}
          selectedLabel={operation?.assetName}
          clearable
        />
      )}
      <ComboboxField
        form={form}
        name="employeeId"
        label={fields.machine ? t('operations.fields.operator') : t('operations.fields.responsible')}
        loadOptions={employeeOptions}
        selectedLabel={operation?.employeeName}
        clearable
      />
      <FormGrid>
        {fields.area && <NumberField form={form} name="areaDoneHa" label={t('operations.fields.area')} suffix={t('unit.ha')} />}
        {fields.water && (
          <NumberField form={form} name="waterM3" label={t('operations.fields.water')} suffix={t('unit.m3')} required={!planned} />
        )}
        <NumberField form={form} name="durationH" label={t('operations.fields.duration')} suffix={t('unit.hours')} />
        {fields.machine && assetId && (
          <NumberField form={form} name="fuelL" label={t('operations.fields.fuel')} suffix={t('unit.liters')} hint={t('operations.fields.fuelHint')} />
        )}
      </FormGrid>
    </>
  );
}

interface OperationFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: string;
  mode?: OperationMode;
  operation?: Operation | null;
  /** Prefill for a new record, e.g. opened from a field card. */
  fieldId?: string;
}

export function OperationFormDialog({ open, onOpenChange, type, mode = 'create', operation, fieldId }: OperationFormDialogProps) {
  const { t } = useTranslation('crops');

  const save = useApiMutation<ReturnType<typeof toPayload>>({
    mutationFn: (body) => {
      if (mode === 'edit') return api.patch(`${OPERATIONS}/${operation!.id}`, body);
      if (mode === 'complete') return api.postOnce(`${OPERATIONS}/${operation!.id}/complete`, body);
      return api.postOnce(OPERATIONS, body);
    },
    invalidate: AFFECTED_BY_WORK,
    silentError: true,
  });

  const title = {
    create: t('operations.newOf', { type: t(`enums:operationType.${type}`) }),
    edit: t('operations.edit'),
    complete: t('operations.complete'),
  }[mode];

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      schema={schema}
      defaultValues={{ ...toValues(type, operation, mode), fieldId: operation?.fieldId ?? fieldId ?? '' }}
      onSubmit={(values) => save.mutateAsync(toPayload(type, values, mode))}
      successMessage={mode === 'edit' ? 'common:toast.updated' : 'common:toast.created'}
      submitLabel={mode === 'complete' ? t('operations.markDone') : undefined}
      size="lg"
    >
      {(form) => (
        <>
          <FormGrid>
            <ComboboxField
              form={form}
              name="fieldId"
              label={t('operations.fields.field')}
              required
              loadOptions={fieldOptions}
              selectedLabel={operation ? `№${operation.fieldNumber}` : undefined}
              disabled={mode === 'complete'}
              onSelect={(_, option) => {
                const field = option?.raw as FieldOption | undefined;
                if (field && mode === 'create' && WORK_FIELDS[type]?.area) form.setValue('areaDoneHa', field.areaHa);
              }}
            />
            <DateField form={form} name="date" label={t('operations.fields.date')} required />
          </FormGrid>
          {mode === 'create' && (
            <SwitchField
              form={form}
              name="planned"
              label={t('operations.fields.planned')}
              hint={WORK_FIELDS[type]?.materials ? t('operations.fields.plannedHint') : undefined}
            />
          )}
          {type === 'leaching' && <LeachingAdvice form={form} />}
          <WorkFields form={form} type={type} operation={operation} />
          <TypeDetails form={form} type={type} />
          {WORK_FIELDS[type]?.materials && <MaterialsEditor form={form} type={type} />}
          <Separator />
          <FormField form={form} name="photos" label={t('operations.fields.photos')}>
            {(field) => <PhotoCapture value={(field.value as Values['photos']) ?? []} onChange={field.onChange} />}
          </FormField>
          <GpsField form={form} />
          <TextareaField form={form} name="notes" label={t('operations.fields.notes')} />
        </>
      )}
    </FormDialog>
  );
}

function GpsField({ form }: { form: Form }) {
  const { t } = useTranslation('crops');
  const lat = useWatch({ control: form.control, name: 'lat' });
  const lng = useWatch({ control: form.control, name: 'lng' });
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{t('operations.fields.location')}</p>
      <GpsCapture
        lat={lat ?? null}
        lng={lng ?? null}
        onChange={(point) => {
          form.setValue('lat', point?.lat ?? null);
          form.setValue('lng', point?.lng ?? null);
        }}
      />
    </div>
  );
}
