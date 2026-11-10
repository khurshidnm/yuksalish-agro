import { CROP_PLAN_STATUSES } from '@yap/shared';
import { useEffect, useMemo } from 'react';
import { type UseFormReturn, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ComboboxField, DateField, FormDialog, FormGrid, MoneyText, NumberField, SelectField, TextField, TextareaField } from '@/components';
import { Alert } from '@/components/ui';
import { useLocalName } from '@/features/farm/utils';
import { api } from '@/lib/api';
import { useSeesCost } from '@/lib/auth';
import { formatNumber } from '@/lib/format';
import { zEnum, zNonNegative, zOptionalDate, zOptionalNumber, zOptionalRef, zOptionalText, zPositive, zRef } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail, useList } from '@/lib/query';
import { CROPS, type FieldOption, PLANS, SUMMARY, TECH_CARDS, fieldOptions } from './options';
import type { CropPlan, CropRef, PlanEstimate, RotationCheck, Season, TechCard } from './types';

const schema = z.object({
  seasonId: zRef(),
  fieldId: zRef(),
  cropId: zRef(),
  techCardId: zOptionalRef(),
  variety: zOptionalText(120),
  areaHa: zPositive(),
  sowingDatePlan: zOptionalDate(),
  sowingDateFact: zOptionalDate(),
  expectedYieldTHa: zOptionalNumber(),
  plannedCost: zOptionalNumber(),
  ownUsePct: zNonNegative().max(100),
  status: zEnum(CROP_PLAN_STATUSES),
  notes: zOptionalText(1000),
});

type Values = z.input<typeof schema>;
type Form = UseFormReturn<Values, unknown, z.output<typeof schema>>;

function Estimate({ form, seesMoney }: { form: Form; seesMoney: boolean }) {
  const { t } = useTranslation('crops');
  const cropId = useWatch({ control: form.control, name: 'cropId' });
  const areaHa = useWatch({ control: form.control, name: 'areaHa' });
  const techCardId = useWatch({ control: form.control, name: 'techCardId' });
  const typedYield = useWatch({ control: form.control, name: 'expectedYieldTHa' });
  const { data } = useDetail<PlanEstimate>(cropId && areaHa > 0 ? `${PLANS}/estimate` : null, {
    cropId,
    areaHa,
    techCardId: techCardId || undefined,
  });
  if (!data) return null;
  const yieldTHa = typedYield ?? data.expectedYieldTHa;
  return (
    <Alert tone="info" title={data.techCardName ? t('plans.estimate.fromCard', { name: data.techCardName }) : t('plans.estimate.noCard')}>
      {yieldTHa !== null && (
        <p>{t('plans.estimate.harvest', { tons: formatNumber(areaHa * yieldTHa, 1), yield: formatNumber(yieldTHa, 2) })}</p>
      )}
      {seesMoney && data.plannedCost !== null && (
        <p>
          {t('plans.estimate.cost')}: <MoneyText value={data.plannedCost} />
        </p>
      )}
    </Alert>
  );
}

/**
 * What the rotation rules say about this crop on this field, shown before saving. The notes warn
 * and never block: the save button works the same with or without them.
 */
function RotationNotes({ form, planId }: { form: Form; planId?: string }) {
  const { t } = useTranslation('crops');
  const localName = useLocalName();
  const seasonId = useWatch({ control: form.control, name: 'seasonId' });
  const fieldId = useWatch({ control: form.control, name: 'fieldId' });
  const cropId = useWatch({ control: form.control, name: 'cropId' });
  const { data } = useDetail<RotationCheck>(seasonId && fieldId && cropId ? `${PLANS}/rotation-check` : null, { seasonId, fieldId, cropId, planId });
  if (!data || data.notes.length === 0) return null;
  const warns = data.notes.some((note) => note.level === 'warning');
  return (
    <div className="flex flex-col gap-2">
      {data.notes.map((note) => (
        <Alert key={note.rule} tone={note.level === 'warning' ? 'warning' : 'success'} title={t(`rotation.rule.${note.rule}.title`)}>
          <p>{t(`rotation.rule.${note.rule}.reason`)}</p>
          <p className="text-xs">{t('rotation.source', { source: note.source })}</p>
        </Alert>
      ))}
      <p className="text-sm text-muted-foreground">
        {t('rotation.history', { crops: data.history.map((h) => t('rotation.historyItem', { season: h.seasonName, crop: localName(h.name) })).join('; ') })}
        {warns && ` ${t('rotation.stillSave')}`}
      </p>
    </div>
  );
}

function CardSelect({ form }: { form: Form }) {
  const { t } = useTranslation('crops');
  const cropId = useWatch({ control: form.control, name: 'cropId' });
  const { data } = useDetail<TechCard[]>(cropId ? TECH_CARDS : null, { cropId });
  const options = useMemo(() => (data ?? []).map((c) => ({ value: c.id, label: c.name })), [data]);
  useEffect(() => {
    if (data?.length === 1 && !form.getValues('techCardId')) form.setValue('techCardId', data[0].id);
  }, [data, form]);
  if (!options.length) return null;
  return <SelectField form={form} name="techCardId" label={t('plans.fields.techCard')} placeholder={t('plans.noCard')} options={options} />;
}

interface PlanFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan?: CropPlan | null;
  seasonId?: string;
}

export function PlanFormDialog({ open, onOpenChange, plan, seasonId }: PlanFormDialogProps) {
  const { t } = useTranslation('crops');
  const localName = useLocalName();
  const seesMoney = useSeesCost('crops.approve');
  const { data: seasons } = useList<Season>('/crops/seasons');
  const { data: crops } = useList<CropRef>(CROPS);

  const save = useApiMutation<z.output<typeof schema>>({
    mutationFn: ({ plannedCost, ...values }) => {
      // Without cost access the field is hidden and null: sending it would erase the estimate.
      const body = seesMoney ? { ...values, plannedCost } : values;
      return plan ? api.patch(`${PLANS}/${plan.id}`, body) : api.post(PLANS, body);
    },
    invalidate: [PLANS, SUMMARY, '/crops/plan-fact'],
    silentError: true,
  });

  const defaults: Values = {
    seasonId: plan?.seasonId ?? seasonId ?? '',
    fieldId: plan?.fieldId ?? '',
    cropId: plan?.cropId ?? '',
    techCardId: plan?.techCardId ?? null,
    variety: plan?.variety ?? '',
    areaHa: plan?.areaHa ?? (undefined as unknown as number),
    sowingDatePlan: plan?.sowingDatePlan ?? '',
    sowingDateFact: plan?.sowingDateFact ?? '',
    expectedYieldTHa: plan?.expectedYieldTHa ?? null,
    plannedCost: plan?.plannedCost ?? null,
    ownUsePct: plan?.ownUsePct ?? 0,
    status: plan?.status ?? 'planned',
    notes: plan?.notes ?? '',
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={plan ? t('plans.edit') : t('plans.add')}
      schema={schema}
      defaultValues={defaults}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage={plan ? 'common:toast.updated' : 'common:toast.created'}
      size="lg"
    >
      {(form) => (
        <>
          <FormGrid>
            <SelectField
              form={form}
              name="seasonId"
              label={t('plans.fields.season')}
              required
              placeholder={t('common:form.selectPlaceholder')}
              options={(seasons?.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
            <ComboboxField
              form={form}
              name="fieldId"
              label={t('operations.fields.field')}
              required
              loadOptions={fieldOptions}
              selectedLabel={plan ? `№${plan.fieldNumber}` : undefined}
              onSelect={(_, option) => {
                const field = option?.raw as FieldOption | undefined;
                if (field && !form.getValues('areaHa')) form.setValue('areaHa', field.areaHa, { shouldValidate: true });
              }}
            />
            <SelectField
              form={form}
              name="cropId"
              label={t('plans.fields.crop')}
              required
              placeholder={t('common:form.selectPlaceholder')}
              options={(crops?.data ?? []).map((c) => ({ value: c.id, label: localName(c.name) }))}
            />
            <TextField form={form} name="variety" label={t('plans.fields.variety')} />
            <NumberField form={form} name="areaHa" label={t('plans.fields.area')} suffix={t('unit.ha')} required />
            <DateField form={form} name="sowingDatePlan" label={t('plans.fields.sowingPlan')} />
          </FormGrid>
          <RotationNotes form={form} planId={plan?.id} />
          <CardSelect form={form} />
          <FormGrid>
            <NumberField form={form} name="expectedYieldTHa" label={t('plans.fields.yield')} suffix={t('unit.tPerHa')} hint={t('plans.fields.yieldHint')} />
            <NumberField form={form} name="ownUsePct" label={t('plans.fields.ownUse')} suffix="%" hint={t('plans.fields.ownUseHint')} />
            {seesMoney && <NumberField money form={form} name="plannedCost" label={t('plans.fields.plannedCost')} hint={t('plans.fields.plannedCostHint')} />}
            {plan && <SelectField form={form} name="status" label={t('plans.fields.status')} options={enumOptions('cropPlanStatus', CROP_PLAN_STATUSES)} />}
            {plan && <DateField form={form} name="sowingDateFact" label={t('plans.fields.sowingFact')} hint={t('plans.fields.sowingFactHint')} />}
          </FormGrid>
          <Estimate form={form} seesMoney={seesMoney} />
          <TextareaField form={form} name="notes" label={t('operations.fields.notes')} />
        </>
      )}
    </FormDialog>
  );
}
