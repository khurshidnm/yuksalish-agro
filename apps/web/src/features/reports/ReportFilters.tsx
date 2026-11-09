import { todayIso } from '@yap/shared';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox, DateInput, Label, Select, Switch, apiOptions } from '@/components/ui';
import { formatMonth } from '@/lib/format';
import { previousRange, recentMonths } from './format';
import type { Catalog, CatalogFilter, CatalogReport, ReportResult } from './types';

const FIELD = 'min-w-0 flex-1 basis-40 space-y-1.5';
const DAY_CHOICES = [7, 14, 30, 60, 90, 180, 365, 730];
const MONTH_CHOICES = [3, 6, 12, 18, 24];

interface LookupRow {
  id: string;
  name?: string | null;
  fullName?: string | null;
  number?: string | null;
}

const lookupOptions = (path: string, params?: Record<string, string>) =>
  apiOptions<LookupRow>(path, (row) => ({ value: row.id, label: row.name ?? row.fullName ?? row.number ?? row.id }), params);

export type SetParams = (changes: Record<string, string | null>) => void;

function monthOptions() {
  return recentMonths(todayIso().slice(0, 7), 36).map((month) => ({ value: month, label: formatMonth(month) }));
}

export function MonthSelect({ id, value, onChange }: { id?: string; value: string; onChange: (month: string) => void }) {
  const options = useMemo(monthOptions, []);
  return <Select id={id} value={value} options={options} onChange={(event) => onChange(event.target.value)} />;
}

function numberChoices(filter: Extract<CatalogFilter, { type: 'number' }>) {
  const choices = filter.key === 'months' ? MONTH_CHOICES : DAY_CHOICES;
  return [...new Set([...choices, filter.default])].filter((n) => n >= filter.min && n <= filter.max).sort((a, b) => a - b);
}

function PeriodField({
  filter,
  presets,
  params,
  result,
  setParams,
}: {
  filter: Extract<CatalogFilter, { type: 'period' }>;
  presets: string[];
  params: URLSearchParams;
  result: ReportResult | undefined;
  setParams: SetParams;
}) {
  const { t } = useTranslation('reports');
  const custom = params.has('from') || params.has('to');
  const preset = custom ? 'custom' : (params.get('preset') ?? filter.preset);
  const options = [...presets, 'custom'].map((value) => ({ value, label: t(`presets.${value}`) }));

  const choose = (value: string) => {
    if (value === 'custom') {
      const today = todayIso();
      setParams({ preset: null, from: result?.period?.from ?? today, to: result?.period?.to ?? today });
    } else {
      setParams({ preset: value, from: null, to: null });
    }
  };

  return (
    <>
      <div className={FIELD}>
        <Label htmlFor="report-period">{filter.label}</Label>
        <Select id="report-period" value={preset} options={options} onChange={(event) => choose(event.target.value)} />
      </div>
      {custom && (
        <>
          <div className={FIELD}>
            <Label htmlFor="report-from">{t('viewer.from')}</Label>
            <DateInput
              id="report-from"
              value={params.get('from') ?? ''}
              onChange={(event) => event.target.value && setParams({ from: event.target.value })}
            />
          </div>
          <div className={FIELD}>
            <Label htmlFor="report-to">{t('viewer.to')}</Label>
            <DateInput
              id="report-to"
              value={params.get('to') ?? ''}
              onChange={(event) => event.target.value && setParams({ to: event.target.value })}
            />
          </div>
        </>
      )}
    </>
  );
}

function FilterField({
  filter,
  catalog,
  params,
  result,
  setParams,
}: {
  filter: CatalogFilter;
  catalog: Catalog;
  params: URLSearchParams;
  result: ReportResult | undefined;
  setParams: SetParams;
}) {
  const { t } = useTranslation('reports');
  const id = `report-${filter.key}`;
  const value = params.get(filter.key) ?? '';

  switch (filter.type) {
    case 'period':
      return <PeriodField filter={filter} presets={catalog.presets} params={params} result={result} setParams={setParams} />;
    case 'month': {
      const now = todayIso().slice(0, 7);
      const fallback = filter.default === 'previous' ? recentMonths(now, 2)[1] : now;
      return (
        <div className={FIELD}>
          <Label htmlFor={id}>{filter.label}</Label>
          <MonthSelect id={id} value={value || fallback} onChange={(month) => setParams({ month })} />
        </div>
      );
    }
    case 'number':
      return (
        <div className={FIELD}>
          <Label htmlFor={id}>{filter.label}</Label>
          <Select
            id={id}
            value={value || String(filter.default)}
            options={numberChoices(filter).map((n) => ({ value: String(n), label: String(n) }))}
            onChange={(event) => setParams({ [filter.key]: event.target.value })}
          />
        </div>
      );
    case 'select':
      return (
        <div className={FIELD}>
          <Label htmlFor={id}>{filter.label}</Label>
          <Select
            id={id}
            value={value}
            placeholder={t('viewer.all')}
            options={filter.options}
            onChange={(event) => setParams({ [filter.key]: event.target.value || null })}
          />
        </div>
      );
    case 'lookup': {
      // Left empty, a season filter is not "all": the report reads one season and names it.
      const filled = value ? undefined : result?.defaults?.[filter.key];
      return (
        <div className={FIELD}>
          <Label htmlFor={id}>{filter.label}</Label>
          <Combobox
            id={id}
            value={value || filled?.value || null}
            selectedLabel={value ? params.get(`${filter.key}Label`) : (filled?.label ?? null)}
            placeholder={filter.emptyLabel ?? t('viewer.all')}
            // The default season is not a choice to clear.
            clearable={Boolean(value)}
            loadOptions={lookupOptions(filter.path, filter.params)}
            // The label travels with the value so that export headers can name the choice.
            onChange={(next, option) => setParams({ [filter.key]: next, [`${filter.key}Label`]: option?.label ?? null })}
          />
        </div>
      );
    }
  }
}

function CompareFields({
  report,
  params,
  result,
  setParams,
}: {
  report: CatalogReport;
  params: URLSearchParams;
  result: ReportResult | undefined;
  setParams: SetParams;
}) {
  const { t } = useTranslation('reports');
  const mode = report.compare!.filter;
  const active = mode === 'period' ? params.has('compareFrom') : params.has('compareSeasonId') || params.has('compareOn');

  const toggle = (on: boolean) => {
    if (!on) {
      setParams({ compareFrom: null, compareTo: null, compareSeasonId: null, compareSeasonIdLabel: null, compareOn: null });
    } else if (mode === 'period' && result?.period) {
      const range = previousRange(result.period);
      setParams({ compareFrom: range.from, compareTo: range.to });
    } else {
      setParams({ compareOn: '1' });
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <Label htmlFor="report-compare">{t('viewer.compare')}</Label>
        <Switch id="report-compare" checked={active} onCheckedChange={toggle} disabled={params.has('groupBy')} />
      </div>
      {active && mode === 'period' && (
        <div className="flex flex-wrap gap-3">
          <div className={FIELD}>
            <Label htmlFor="report-compare-from">{t('viewer.compareFrom')}</Label>
            <DateInput
              id="report-compare-from"
              value={params.get('compareFrom') ?? ''}
              onChange={(event) => event.target.value && setParams({ compareFrom: event.target.value })}
            />
          </div>
          <div className={FIELD}>
            <Label htmlFor="report-compare-to">{t('viewer.compareTo')}</Label>
            <DateInput
              id="report-compare-to"
              value={params.get('compareTo') ?? ''}
              onChange={(event) => event.target.value && setParams({ compareTo: event.target.value })}
            />
          </div>
        </div>
      )}
      {active && mode === 'seasonId' && (
        <div className={FIELD}>
          <Label htmlFor="report-compare-season">{t('viewer.compareSeason')}</Label>
          <Combobox
            id="report-compare-season"
            value={params.get('compareSeasonId')}
            selectedLabel={params.get('compareSeasonIdLabel')}
            loadOptions={lookupOptions('/crops/seasons')}
            onChange={(next, option) =>
              setParams({ compareSeasonId: next, compareSeasonIdLabel: option?.label ?? null, compareOn: next ? null : '1' })
            }
          />
        </div>
      )}
      {active && <p className="text-sm text-muted-foreground">{t('viewer.compareHint')}</p>}
    </div>
  );
}

export function ReportFilters({
  report,
  catalog,
  params,
  result,
  setParams,
}: {
  report: CatalogReport;
  catalog: Catalog;
  params: URLSearchParams;
  result: ReportResult | undefined;
  setParams: SetParams;
}) {
  if (report.filters.length === 0 && !report.compare) return null;
  return (
    <div className="space-y-3">
      {report.filters.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {report.filters.map((filter) => (
            <FilterField key={filter.key} filter={filter} catalog={catalog} params={params} result={result} setParams={setParams} />
          ))}
        </div>
      )}
      {report.compare && <CompareFields report={report} params={params} result={result} setParams={setParams} />}
    </div>
  );
}
