import { round } from '@yap/shared';
import { SCENARIO_MONTHS, type ScenarioAssumptionKey, type ScenarioAssumptions, type ScenarioNumberKey, scenarioMonthAt } from '@yap/shared/formulas/scenario';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Label, NumberInput, Select } from '@/components/ui';
import { currencyLabel, formatMoney, formatMonth, formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { type Baseline, FIELDS, type FieldGroup, type FieldSpec, ONE_OFF_LIMIT, fieldProblem, sliderRange } from './scenarioPlan';

const CALENDAR_MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

/** Assumptions whose label alone does not say what is counted. */
const EXPLAINED = new Set<ScenarioAssumptionKey>([
  'openingReplacements',
  'openingLambs',
  'lambingShare',
  'lambSurvival',
  'replacementShare',
  'firstLambingAgeMonths',
  'eweDeathsPerYear',
  'eweCullsPerYear',
  'cullEwePrice',
  'feedAdultGrazingPerMonth',
  'feedLambPerMonth',
  'otherCostPerHeadPerMonth',
  'fixedCostPerMonth',
  'openingCash',
  'stallMonths',
]);

export function useCalendarMonthNames(): string[] {
  const { t } = useTranslation();
  return t('common:date.months', { returnObjects: true }) as unknown as string[];
}

/** One assumption as people read it: 92%, 45 kg, 6 months, March. */
export function useAssumptionText(): (spec: FieldSpec, value: number | null | undefined) => string {
  const { t } = useTranslation('finance');
  const months = useCalendarMonthNames();
  return (spec, value) => {
    if (value === null || value === undefined) return '—';
    switch (spec.kind) {
      case 'share':
        return formatPercent(round(value * 100, 4));
      case 'money':
        return formatMoney(value);
      case 'head':
        return t('scenarios.units.headCount', { value: formatNumber(value, 0) });
      case 'kg':
        return t('scenarios.units.kgCount', { value: formatNumber(value, 1) });
      case 'months':
        return t('scenarios.units.monthsCount', { value: formatNumber(value, 0) });
      case 'calendarMonth':
        return months[value - 1] ?? '—';
      default:
        return formatNumber(value, 2);
    }
  };
}

interface FieldProps {
  spec: FieldSpec;
  value: number | null;
  anchor: number | undefined;
  baseline: Baseline;
  /** `typed` is false for the slider, whose scale must not move under the thumb. */
  onChange: (value: number | null, typed: boolean) => void;
}

function Origin({ spec, value, baseline, onUse }: { spec: FieldSpec; value: number | null; baseline: Baseline; onUse: (value: number) => void }) {
  const { t } = useTranslation('finance');
  const text = useAssumptionText();
  const farm = baseline.assumptions[spec.key];
  const source = baseline.sources[spec.key];
  const suggested = baseline.suggestions[spec.key]?.value;

  // A figure of the farm's is never called missing, even if its source did not come with it.
  if (farm !== null && !source) return null;
  if (farm !== null && source) {
    return <p className="text-sm text-muted-foreground">{t('scenarios.origin.farm', { value: text(spec, farm), source: t(`scenarios.sources.${source.source}`) })}</p>;
  }
  if (typeof suggested === 'number') {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="min-w-0 text-sm text-muted-foreground">{t('scenarios.origin.suggested', { value: text(spec, suggested) })}</p>
        {value !== suggested && (
          <Button variant="outline" size="sm" onClick={() => onUse(suggested)}>
            {t('scenarios.origin.use')}
          </Button>
        )}
      </div>
    );
  }
  return <p className="text-sm text-muted-foreground">{t('scenarios.origin.none')}</p>;
}

function AssumptionField({ spec, value, anchor, baseline, onChange }: FieldProps) {
  const { t } = useTranslation('finance');
  const id = useId();
  const months = useCalendarMonthNames();
  const label = t(`scenarios.fields.${spec.key}`);
  const problem = fieldProblem(spec, value);
  const percent = spec.kind === 'share';
  const range = sliderRange(spec, anchor);

  const suffix =
    spec.kind === 'share'
      ? '%'
      : spec.kind === 'money'
        ? currencyLabel()
        : spec.kind === 'head'
          ? t('enums:unit.head')
          : spec.kind === 'kg'
            ? t('enums:unit.kg')
            : spec.kind === 'months'
              ? t('scenarios.units.months')
              : undefined;
  const digits = spec.kind === 'head' || spec.kind === 'months' ? 0 : spec.kind === 'ratio' ? 2 : spec.kind === 'money' ? 2 : 1;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {EXPLAINED.has(spec.key) && <p className="text-sm text-muted-foreground">{t(`scenarios.help.${spec.key}`)}</p>}
      {spec.kind === 'calendarMonth' ? (
        <Select
          id={id}
          value={value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value), true)}
          options={CALENDAR_MONTHS.map((m) => ({ value: String(m), label: months[m - 1] }))}
          placeholder={t('scenarios.notSet')}
        />
      ) : (
        <div className="grid gap-x-3 gap-y-1 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-start">
          <NumberInput
            id={id}
            value={value === null ? null : percent ? round(value * 100, 4) : value}
            onChange={(n) => onChange(n === null ? null : percent ? round(n / 100, 6) : n, true)}
            suffix={suffix}
            maxDigits={digits}
            money={spec.kind === 'money'}
            allowNegative={spec.min < 0}
            placeholder="—"
            aria-invalid={problem ? true : undefined}
          />
          {range && (
            <input
              type="range"
              aria-label={label}
              min={range.min}
              max={range.max}
              step={range.step}
              value={value === null ? range.min : Math.min(range.max, Math.max(range.min, value))}
              onChange={(e) => onChange(Number(e.target.value), false)}
              className={cn('focus-ring h-11 w-full min-w-0 cursor-pointer rounded accent-primary', value === null && 'opacity-50')}
            />
          )}
        </div>
      )}
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem === 'whole'
            ? t('scenarios.wholeNumber')
            : t(problem === 'min' ? 'common:validation.min' : 'common:validation.max', {
                min: percent ? spec.min * 100 : spec.min,
                max: percent ? spec.max * 100 : spec.max,
              })}
        </p>
      ) : (
        <Origin spec={spec} value={value} baseline={baseline} onUse={(n) => onChange(n, true)} />
      )}
    </div>
  );
}

function Group({ title, empty, defaultOpen, children }: { title: string; empty: number; defaultOpen?: boolean; children: ReactNode }) {
  const { t } = useTranslation('finance');
  return (
    <details open={defaultOpen} className="group rounded-xl border border-border bg-card text-card-foreground shadow-card">
      <summary className="focus-ring flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-2 font-semibold text-heading [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">{title}</span>
        {empty > 0 && <Badge variant="warning">{t('scenarios.emptyCount', { n: empty })}</Badge>}
        <ChevronDown className="size-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="flex flex-col gap-5 border-t border-border p-4">{children}</div>
    </details>
  );
}

function StallMonths({ value, baseline, onChange }: { value: number[] | null; baseline: Baseline; onChange: (months: number[] | null) => void }) {
  const { t } = useTranslation('finance');
  const names = t('common:date.monthsShort', { returnObjects: true }) as unknown as string[];
  const full = useCalendarMonthNames();
  const suggested = baseline.suggestions.stallMonths?.value;
  const toggle = (month: number) => {
    const set = new Set(value ?? []);
    if (set.has(month)) set.delete(month);
    else set.add(month);
    onChange([...set].sort((a, b) => a - b));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium">{t('scenarios.fields.stallMonths')}</p>
      <p className="text-sm text-muted-foreground">{t('scenarios.help.stallMonths')}</p>
      <div role="group" aria-label={t('scenarios.fields.stallMonths')} className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
        {CALENDAR_MONTHS.map((month) => {
          const on = value?.includes(month) ?? false;
          return (
            <button
              key={month}
              type="button"
              aria-pressed={on}
              aria-label={full[month - 1]}
              onClick={() => toggle(month)}
              className={cn(
                'focus-ring min-h-11 rounded-lg border px-1 text-sm font-medium transition-colors',
                on ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-popover text-foreground hover:bg-muted',
              )}
            >
              {names[month - 1]}
            </button>
          );
        })}
      </div>
      {value === null && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="min-w-0 text-sm text-muted-foreground">
            {Array.isArray(suggested) ? t('scenarios.origin.suggested', { value: suggested.map((m) => names[m - 1]).join(', ') }) : t('scenarios.origin.none')}
          </p>
          {Array.isArray(suggested) && (
            <Button variant="outline" size="sm" onClick={() => onChange([...suggested])}>
              {t('scenarios.origin.use')}
            </Button>
          )}
        </div>
      )}
      {value !== null && value.length === 0 && <p className="text-sm text-muted-foreground">{t('scenarios.noStallMonths')}</p>}
    </div>
  );
}

function OneOffs({ value, startMonth, onChange }: { value: ScenarioAssumptions['oneOffs']; startMonth: string; onChange: (list: ScenarioAssumptions['oneOffs']) => void }) {
  const { t } = useTranslation('finance');
  const monthOptions = Array.from({ length: SCENARIO_MONTHS }, (_, i) => ({ value: String(i), label: formatMonth(scenarioMonthAt(startMonth, i)) }));
  const patch = (index: number, change: Partial<ScenarioAssumptions['oneOffs'][number]>) => onChange(value.map((row, i) => (i === index ? { ...row, ...change } : row)));

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">{t('scenarios.oneOffs.title')}</p>
      <p className="text-sm text-muted-foreground">{t('scenarios.oneOffs.help')}</p>
      {value.map((row, index) => (
        // Rows have no identity of their own, and are only ever edited in place or removed.
        <div key={index} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <Select
            aria-label={t('scenarios.oneOffs.month')}
            value={String(row.month)}
            onChange={(e) => patch(index, { month: Number(e.target.value) })}
            options={monthOptions}
            className="max-sm:col-span-2"
          />
          <NumberInput aria-label={t('scenarios.oneOffs.amount')} value={row.amount} onChange={(n) => patch(index, { amount: n ?? 0 })} money suffix={currencyLabel()} />
          <Button variant="ghost" size="icon" aria-label={t('scenarios.oneOffs.remove')} onClick={() => onChange(value.filter((_, i) => i !== index))}>
            <Trash2 aria-hidden />
          </Button>
        </div>
      ))}
      {value.length < ONE_OFF_LIMIT && (
        <Button variant="outline" className="self-start" onClick={() => onChange([...value, { month: 0, amount: 0 }])}>
          <Plus aria-hidden />
          {t('scenarios.oneOffs.add')}
        </Button>
      )}
    </div>
  );
}

export interface ScenarioInputsProps {
  value: ScenarioAssumptions;
  baseline: Baseline;
  anchors: Partial<Record<ScenarioNumberKey, number>>;
  onNumber: (key: ScenarioNumberKey, value: number | null, typed: boolean) => void;
  onChange: (patch: Partial<ScenarioAssumptions>) => void;
}

/** The assumptions, group by group. Each group says how many of its figures are still empty. */
export function ScenarioInputs({ value, baseline, anchors, onNumber, onChange }: ScenarioInputsProps) {
  const { t } = useTranslation('finance');
  const fieldsOf = (group: FieldGroup) => FIELDS.filter((f) => f.group === group);
  const emptyIn = (group: FieldGroup) => fieldsOf(group).filter((f) => value[f.key] === null).length + (group === 'costs' && value.stallMonths === null ? 1 : 0);
  const fields = (group: FieldGroup) =>
    fieldsOf(group).map((spec) => (
      <AssumptionField key={spec.key} spec={spec} value={value[spec.key]} anchor={anchors[spec.key]} baseline={baseline} onChange={(n, typed) => onNumber(spec.key, n, typed)} />
    ));

  // A plan may start before today's month or well after it; a loaded plan keeps its own month.
  const starts = Array.from({ length: 37 }, (_, i) => scenarioMonthAt(baseline.startMonth, i - 12));
  if (!starts.includes(value.startMonth)) starts.unshift(value.startMonth);

  return (
    <div className="flex flex-col gap-3">
      <Group title={t('scenarios.groups.herd')} empty={emptyIn('herd')} defaultOpen>
        {fields('herd')}
      </Group>
      <Group title={t('scenarios.groups.lambing')} empty={emptyIn('lambing')}>
        {fields('lambing')}
      </Group>
      <Group title={t('scenarios.groups.sales')} empty={emptyIn('sales')}>
        {fields('sales')}
      </Group>
      <Group title={t('scenarios.groups.costs')} empty={emptyIn('costs')}>
        <StallMonths value={value.stallMonths} baseline={baseline} onChange={(stallMonths) => onChange({ stallMonths })} />
        {fields('costs')}
        <OneOffs value={value.oneOffs} startMonth={value.startMonth} onChange={(oneOffs) => onChange({ oneOffs })} />
      </Group>
      <Group title={t('scenarios.groups.cash')} empty={emptyIn('cash')}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="scenario-start">{t('scenarios.fields.startMonth')}</Label>
          <Select
            id="scenario-start"
            value={value.startMonth}
            onChange={(e) => onChange({ startMonth: e.target.value })}
            options={starts.map((month) => ({ value: month, label: formatMonth(month) }))}
          />
        </div>
        {fields('cash')}
      </Group>
    </div>
  );
}
