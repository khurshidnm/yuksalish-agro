import { zodResolver } from '@hookform/resolvers/zod';
import { PHYSIOLOGICAL_STATES } from '@yap/shared';
import { LEAST_COST_DEFAULTS, PREGNANCY_STAGES } from '@yap/shared/formulas/nutrition';
import { Calculator, Lock, Save } from 'lucide-react';
import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { z } from 'zod';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ComboboxField,
  EmptyState,
  ErrorCard,
  FormDialog,
  FormGrid,
  NumberField,
  PageHeader,
  SelectField,
  Skeleton,
  TextField,
  apiOptions,
} from '@/components';
import { api } from '@/lib/api';
import { usePermission, useSeesCost } from '@/lib/auth';
import { formatMoney, formatNumber, formatPercent } from '@/lib/format';
import { zEnum, zOptionalRef, zRef, zText } from '@/lib/forms';
import i18n, { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { LineCard, LinesSection, itemOptions } from '../inventory/shared';
import { BalanceLines, MissingData } from './NutrientBalance';
import type { LeastCostMix } from './types';

interface HerdOption {
  id: string;
  name: string;
  state: string;
  headCount: number;
}

const LITTERS = ['1', '2'] as const;

const optionalAmount = (max: number) =>
  z
    .number()
    .positive()
    .max(max)
    .nullish()
    .transform((v) => v ?? null);

const schema = z
  .object({
    herdId: zOptionalRef(),
    state: zEnum(PHYSIOLOGICAL_STATES),
    weightKg: optionalAmount(200),
    stage: zEnum(PREGNANCY_STAGES),
    litter: zEnum(LITTERS),
    gainG: optionalAmount(600),
    minRoughageSharePct: z.number().min(0).max(100),
    feeds: z
      .array(z.object({ itemId: zRef(), maxKgPerHeadDay: optionalAmount(100) }))
      .min(1)
      .max(20),
  })
  .superRefine((v, ctx) => {
    // Without a herd there is no recorded weight to fall back on.
    if (!v.herdId && v.weightKg === null) ctx.addIssue({ code: 'custom', path: ['weightKg'], message: i18n.t('feed:mix.weightRequired') });
  });

type FormIn = z.input<typeof schema>;
type FormOut = z.output<typeof schema>;

/** The amount stays blank until typed: an empty maximum means no limit on that feed. */
const EMPTY_FEED = { itemId: '' } as FormIn['feeds'][number];

const DEFAULTS: FormIn = {
  herdId: '',
  state: 'pregnant',
  weightKg: null,
  stage: 'late',
  litter: '1',
  gainG: null,
  minRoughageSharePct: LEAST_COST_DEFAULTS.minRoughageSharePct,
  feeds: [EMPTY_FEED],
};

function toBody(v: FormOut) {
  const late = v.state === 'pregnant' && v.stage === 'late';
  return {
    herdId: v.herdId ?? undefined,
    state: v.state,
    weightKg: v.weightKg ?? undefined,
    stage: v.state === 'pregnant' ? v.stage : undefined,
    litter: late || v.state === 'lactating' ? (v.litter === '2' ? 2 : 1) : undefined,
    gainG: v.state === 'lamb' || v.state === 'fattening' ? (v.gainG ?? undefined) : undefined,
    minRoughageSharePct: v.minRoughageSharePct,
    feeds: v.feeds.map((feed) => ({ itemId: feed.itemId, maxKgPerHeadDay: feed.maxKgPerHeadDay })),
  };
}

const saveSchema = z.object({ name: zText(120) });

function SaveAsRation({ mix, open, onOpenChange }: { mix: LeastCostMix; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('feed');
  const navigate = useNavigate();
  const save = useApiMutation<{ name: string }>({
    // The existing ration service takes it, as if it had been typed in by hand.
    mutationFn: ({ name }) =>
      api.post('/feed/rations', { name, state: mix.state, lines: mix.lines.map((line) => ({ itemId: line.itemId, kgPerHeadDay: line.kgPerHeadDay })) }),
    invalidate: ['/feed'],
    silentError: true,
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('mix.save')}
      description={t('mix.saveHint')}
      schema={saveSchema}
      defaultValues={{ name: t('mix.defaultName', { state: t(`enums:physiologicalState.${mix.state}`) }) }}
      onSubmit={async (values) => {
        await save.mutateAsync(values);
        void navigate('/feed/rations');
      }}
      successMessage="common:toast.created"
    >
      {(form) => <TextField form={form} name="name" label={t('rations.fields.name')} required autoFocus />}
    </FormDialog>
  );
}

function MixResult({ mix }: { mix: LeastCostMix }) {
  const { t } = useTranslation('feed');
  const canCreate = usePermission('feed.create');
  const [saving, setSaving] = useState(false);
  const unitOf = (nutrient: string) => t(`nutrients.unit.${nutrient}`);

  if (mix.status === 'no_requirement') {
    return (
      <Alert tone="warning" title={t('mix.noRequirementTitle')}>
        {mix.reason && <p>{t(`nutrients.reasons.${mix.reason}`)}</p>}
        {mix.reason === 'no_weight' && <p>{t('mix.enterWeight')}</p>}
      </Alert>
    );
  }
  if (mix.status === 'missing_data') {
    return (
      <MissingData missing={mix.missing} title={t('mix.missingTitle')}>
        <p className="mt-1">{t('mix.missingBody')}</p>
        <Button variant="outline" className="mt-2" asChild>
          <Link to="/inventory/items">{t('mix.openItems')}</Link>
        </Button>
      </MissingData>
    );
  }
  if (mix.status === 'infeasible') {
    return (
      <Alert tone="danger" title={t('mix.infeasibleTitle')}>
        <ul className="mt-1 flex flex-col gap-1">
          {mix.shortfalls.map((fall) => (
            <li key={fall.nutrient}>
              {t(fall.alone ? 'mix.shortAlone' : 'mix.shortTogether', {
                name: t(`nutrients.name.${fall.nutrient}`),
                best: formatNumber(fall.best, 1),
                required: formatNumber(fall.required, 1),
                unit: unitOf(fall.nutrient),
              })}
            </li>
          ))}
        </ul>
        <p className="mt-2">{t('mix.infeasibleTip')}</p>
      </Alert>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('mix.resultTitle')}</CardTitle>
        <CardDescription>
          {mix.herd && <span className="break-words">{mix.herd.herdName} · </span>}
          {t('mix.resultFor', { state: t(`enums:physiologicalState.${mix.state}`), weight: formatNumber(mix.weightKg, 1) })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col divide-y divide-border">
          {mix.lines.map((line) => (
            <li key={line.itemId} className="flex items-start justify-between gap-3 py-2 first:pt-0">
              <div className="min-w-0">
                <p className="font-medium break-words">{line.itemName}</p>
                <p className="text-xs text-muted-foreground">{t('mix.pricePerKg', { price: formatMoney(line.unitCostPerKg) })}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-medium tabular-nums">{t('rations.amount', { kg: formatNumber(line.kgPerHeadDay, 3) })}</p>
                <p className="text-xs text-muted-foreground tabular-nums">{formatMoney(line.costPerHeadDay)}</p>
              </div>
            </li>
          ))}
        </ul>

        <dl className="flex flex-col gap-1 border-t border-border pt-3 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t('mix.costPerDay')}</dt>
            <dd className="font-semibold tabular-nums">{formatMoney(mix.costPerHeadDay)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t('mix.costPerSeason', { days: mix.seasonDays })}</dt>
            <dd className="font-medium tabular-nums">{formatMoney(mix.costPerSeason)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t('nutrients.roughage')}</dt>
            <dd className="font-medium tabular-nums">{formatPercent(mix.roughageSharePct, 0)}</dd>
          </div>
        </dl>

        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <p className="text-sm font-semibold">{t('nutrients.title')}</p>
          <BalanceLines lines={mix.balance} />
          {mix.requirement?.weightClamped && (
            <p className="text-xs text-muted-foreground">{t('nutrients.clamped', { used: formatNumber(mix.requirement.weightUsedKg, 0) })}</p>
          )}
          <p className="text-xs text-muted-foreground">{t('nutrients.source')}</p>
        </div>

        {canCreate && (
          <>
            <Button onClick={() => setSaving(true)}>
              <Save aria-hidden />
              {t('mix.save')}
            </Button>
            <SaveAsRation mix={mix} open={saving} onOpenChange={setSaving} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MixForm() {
  const { t } = useTranslation('feed');
  const form = useForm<FormIn, unknown, FormOut>({ resolver: zodResolver(schema), defaultValues: DEFAULTS });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'feeds' });
  // An answer belongs to the figures it was worked out from: once the form changes, it is not shown.
  const calculate = useApiMutation<FormOut, { asked: string; mix: LeastCostMix }>({
    mutationFn: async (values) => {
      const asked = JSON.stringify(form.getValues());
      return { asked, mix: await api.post<LeastCostMix>('/feed/least-cost-mix', toBody(values)) };
    },
    silentError: true,
  });
  const current = JSON.stringify(form.watch());
  const mix = calculate.data?.asked === current ? calculate.data.mix : null;

  const [herdId, state, stage] = form.watch(['herdId', 'state', 'stage']);
  const asksLitter = state === 'lactating' || (state === 'pregnant' && stage === 'late');
  const asksGain = state === 'lamb' || state === 'fattening';
  const submit = form.handleSubmit((values) => calculate.mutate(values));

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <Card>
        <CardContent>
          <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
            <p className="text-sm font-semibold">{t('mix.forTitle')}</p>
            <FormGrid>
              <ComboboxField
                form={form}
                name="herdId"
                label={t('mix.herd')}
                hint={t('mix.herdHint')}
                clearable
                loadOptions={apiOptions<HerdOption>('/livestock/herds/lookup', (h) => ({ value: h.id, label: h.name, hint: t('livestock:head', { count: h.headCount }) }))}
                onSelect={(_value, option) => {
                  // A herd comes with its own state; the person may still choose another.
                  const herdState = (option?.raw as HerdOption | undefined)?.state;
                  const known = PHYSIOLOGICAL_STATES.find((s) => s === herdState);
                  if (known) form.setValue('state', known);
                }}
              />
              <SelectField form={form} name="state" label={t('mix.state')} required options={enumOptions('physiologicalState', PHYSIOLOGICAL_STATES)} />
              <NumberField
                form={form}
                name="weightKg"
                label={t('mix.weight')}
                hint={herdId ? t('mix.weightHint') : undefined}
                required={!herdId}
                suffix={t('mix.weightUnit')}
                maxDigits={1}
              />
              {state === 'pregnant' && (
                <SelectField
                  form={form}
                  name="stage"
                  label={t('nutrients.stage.label')}
                  options={PREGNANCY_STAGES.map((value) => ({ value, label: t(`nutrients.stage.${value}`) }))}
                />
              )}
              {asksLitter && (
                <SelectField form={form} name="litter" label={t('nutrients.litter.label')} options={LITTERS.map((value) => ({ value, label: t(`nutrients.litter.${value}`) }))} />
              )}
              {asksGain && <NumberField form={form} name="gainG" label={t('mix.gain')} hint={t('mix.gainHint')} suffix={t('mix.gainUnit')} maxDigits={0} />}
              <NumberField form={form} name="minRoughageSharePct" label={t('mix.minRoughage')} hint={t('mix.minRoughageHint')} required suffix="%" maxDigits={0} />
            </FormGrid>

            <p className="text-sm font-semibold">{t('mix.feedsTitle')}</p>
            <LinesSection
              addLabel={t('mix.addFeed')}
              onAdd={() => append(EMPTY_FEED)}
              rows={fields.map((field, index) => (
                <LineCard key={field.id} index={index} canRemove={fields.length > 1} onRemove={() => remove(index)}>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
                    <ComboboxField
                      form={form}
                      name={`feeds.${index}.itemId`}
                      label={t('mix.feed')}
                      required
                      clearable={false}
                      loadOptions={itemOptions({ category: 'feed' })}
                      emptyText={t('rations.noFeeds')}
                    />
                    <NumberField form={form} name={`feeds.${index}.maxKgPerHeadDay`} label={t('mix.max')} suffix={t('rations.perHeadDay')} maxDigits={3} />
                  </div>
                </LineCard>
              ))}
            />

            <Button type="submit" size="lg" loading={calculate.isPending}>
              <Calculator aria-hidden />
              {t('mix.calculate')}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        {calculate.isPending && <Skeleton className="h-64" />}
        {calculate.error !== null && !calculate.isPending && <ErrorCard error={calculate.error} onRetry={() => void submit()} />}
        {mix && !calculate.isPending && <MixResult mix={mix} />}
      </div>
    </div>
  );
}

export default function LeastCostPage() {
  const { t } = useTranslation('feed');
  // The mix is built on feed prices: the server refuses it to the same people, this only spares them the form.
  const canSeeCost = useSeesCost('feed.approve');

  return (
    <>
      <PageHeader title={t('mix.title')} description={t('mix.description')} back={{ to: '/feed/rations', label: t('mix.back') }} />
      {canSeeCost ? <MixForm /> : <EmptyState icon={Lock} title={t('common:pages.forbiddenTitle')} description={t('common:pages.forbiddenBody')} />}
    </>
  );
}
