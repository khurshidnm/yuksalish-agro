import { todayIso } from '@yap/shared';
import { Download, Pencil, Save, WalletCards, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorCard, PageHeader, StatCard, useUrlParam } from '@/components';
import { ChartCard } from '@/components/ChartCard';
import {
  Button,
  Card,
  Combobox,
  type ComboboxOption,
  Label,
  Meter,
  NumberInput,
  Select,
  Skeleton,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
  apiOptions,
} from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatCompact, formatMoney, formatMonth, formatMonthShort, formatPercent } from '@/lib/format';
import { useApiMutation, useDetail } from '@/lib/query';
import { cn } from '@/lib/utils';
import { FINANCE_PATHS, budgetYear, budgetYearLabel, budgetYearRange, useCenterName, useLocalName } from './lib';
import type { BudgetCell, BudgetGrid, BudgetRow, CategoryOption, CostCenterOption } from './types';

const PATH = FINANCE_PATHS.budget;
const VIEWS = ['plan', 'fact', 'diff'] as const;
type View = (typeof VIEWS)[number];

const EMPTY_CELL: BudgetCell = { planned: 0, actual: 0 };
const editKey = (categoryId: string, month: string) => `${categoryId}|${month}`;

/** Spending over plan is bad, income under plan is bad. The sign shows the direction in both. */
function deviationClass(kind: BudgetRow['kind'], deviation: number): string | undefined {
  if (deviation === 0) return undefined;
  const bad = kind === 'expense' ? deviation > 0 : deviation < 0;
  return bad ? 'text-danger' : 'text-success';
}

function signed(value: number): string {
  if (value === 0) return '—';
  return `${value > 0 ? '+' : ''}${formatCompact(value)}`;
}

function executionTone(percent: number | null) {
  if (percent === null || percent <= 90) return 'primary' as const;
  return percent <= 100 ? ('warning' as const) : ('danger' as const);
}

function cellText(view: View, cell: BudgetCell): string {
  const value = view === 'plan' ? cell.planned : view === 'fact' ? cell.actual : cell.actual - cell.planned;
  if (view === 'diff') return signed(value);
  return value === 0 ? '—' : formatCompact(value);
}

interface GridProps {
  grid: BudgetGrid;
  kind: BudgetRow['kind'];
  rows: BudgetRow[];
  view: View;
  editing: boolean;
  edits: Record<string, number | null>;
  onEdit: (key: string, value: number | null) => void;
}

const stickyHead = 'sticky left-0 z-10 bg-card min-w-44 max-w-56';
const amountCell = 'text-right tabular-nums whitespace-nowrap';

/** Year totals come first: with twelve months beside them, they would otherwise sit off-screen. */
function TotalCells({ kind, total }: { kind: BudgetRow['kind']; total: Pick<BudgetRow, 'planned' | 'actual' | 'deviation' | 'percent'> }) {
  return (
    <>
      <Td className={amountCell}>{formatCompact(total.planned)}</Td>
      <Td className={amountCell}>{formatCompact(total.actual)}</Td>
      <Td className={cn(amountCell, deviationClass(kind, total.deviation))}>{signed(total.deviation)}</Td>
      <Td className={amountCell}>{formatPercent(total.percent, 0)}</Td>
    </>
  );
}

function Section({ grid, kind, rows, view, editing, edits, onEdit }: GridProps) {
  const { t } = useTranslation('finance');
  const localName = useLocalName();
  const total = kind === 'expense' ? grid.totals.expense : grid.totals.income;

  return (
    <>
      <Tr>
        <Td colSpan={grid.months.length + 5} className="bg-muted/50 font-medium">
          {t(`budget.section.${kind}`)}
        </Td>
      </Tr>
      {rows.map((row) => (
        <Tr key={row.categoryId}>
          <Td className={cn(stickyHead, 'truncate')}>{localName(row.name)}</Td>
          <TotalCells kind={kind} total={row} />
          {grid.months.map((month) => {
            const cell = row.cells[month] ?? EMPTY_CELL;
            const key = editKey(row.categoryId, month);
            return (
              <Td key={month} className={cn(amountCell, view === 'diff' && deviationClass(kind, cell.actual - cell.planned))}>
                {editing ? (
                  <NumberInput
                    value={key in edits ? edits[key] : cell.planned || null}
                    onChange={(value) => onEdit(key, value)}
                    // Tab into a cell and type over it, as in a spreadsheet. The field reformats its
                    // text on focus, which would drop a selection made any earlier than this.
                    onFocus={(e) => {
                      const input = e.currentTarget;
                      requestAnimationFrame(() => input.select());
                    }}
                    aria-label={`${localName(row.name)}, ${formatMonth(month)}`}
                    className="min-w-28 text-right"
                    maxDigits={0}
                  />
                ) : (
                  cellText(view, cell)
                )}
              </Td>
            );
          })}
        </Tr>
      ))}
      <Tr className="font-semibold">
        <Td className={stickyHead}>{t(`budget.total.${kind}`)}</Td>
        <TotalCells kind={kind} total={total} />
        {grid.months.map((month) => {
          const cell = total.byMonth[month] ?? EMPTY_CELL;
          return (
            <Td key={month} className={cn(amountCell, view === 'diff' && deviationClass(kind, cell.actual - cell.planned))}>
              {cellText(view, cell)}
            </Td>
          );
        })}
      </Tr>
    </>
  );
}

function emptyRow(category: CategoryOption): BudgetRow {
  return {
    categoryId: category.id,
    key: category.key,
    kind: category.kind,
    group: category.group,
    name: category.name,
    cells: {},
    planned: 0,
    actual: 0,
    deviation: 0,
    percent: null,
  };
}

export default function BudgetPage() {
  const { t } = useTranslation('finance');
  const localName = useLocalName();
  const centerName = useCenterName();
  const canUpdate = usePermission('finance.update');
  const thisYear = budgetYear(todayIso());

  const [yearParam, setYear] = useUrlParam('year', String(thisYear));
  const [viewParam, setView] = useUrlParam('view', 'fact');
  const view = (VIEWS as readonly string[]).includes(viewParam) ? (viewParam as View) : 'fact';
  const year = Number(yearParam) || thisYear;
  const { from, to } = budgetYearRange(year);

  const [center, setCenter] = useState<{ id: string; name: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, number | null>>({});
  const [added, setAdded] = useState<CategoryOption[]>([]);

  const params = { from, to, costCenterId: center?.id };
  const budget = useDetail<BudgetGrid>(PATH, params);
  const categories = useDetail<CategoryOption[]>('/finance/categories', undefined, { enabled: editing });

  const save = useApiMutation<void, unknown>({
    mutationFn: () =>
      api.put(PATH, {
        entries: Object.entries(edits).map(([key, amount]) => {
          const [categoryId, month] = key.split('|');
          return { month, categoryId, costCenterId: center?.id ?? null, amount: amount ?? 0 };
        }),
      }),
    invalidate: [PATH, FINANCE_PATHS.cashflow],
    successMessage: 'common:toast.saved',
    onSuccess: () => {
      setEditing(false);
      setEdits({});
      setAdded([]);
    },
  });

  const stopEditing = () => {
    setEditing(false);
    setEdits({});
    setAdded([]);
  };

  const data = budget.data;
  const rows = useMemo(() => {
    const existing = data?.rows ?? [];
    const extra = added.filter((c) => !existing.some((row) => row.categoryId === c.id)).map(emptyRow);
    return [...existing, ...extra];
  }, [data, added]);

  const addOptions: ComboboxOption[] = (categories.data ?? [])
    .filter((c) => !rows.some((row) => row.categoryId === c.id))
    .map((c) => ({
      value: c.id,
      label: localName(c.name),
      hint: t(`budget.section.${c.kind}`),
      raw: c,
    }));

  const chartData = useMemo(
    () =>
      (data?.months ?? []).map((month) => ({
        month,
        planned: data?.totals.expense.byMonth[month]?.planned ?? 0,
        actual: data?.totals.expense.byMonth[month]?.actual ?? 0,
      })),
    [data],
  );

  const expense = data?.totals.expense;
  const income = data?.totals.income;
  const changed = Object.keys(edits).length;

  return (
    <>
      <PageHeader
        title={t('budget.title')}
        description={t('budget.description')}
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => void api.download(`${PATH}/export.xlsx`, `byudjet-${budgetYearLabel(year).replace('/', '-')}.xlsx`, params)}
            >
              <Download aria-hidden />
              {t('budget.export')}
            </Button>
            {canUpdate && !editing && (
              <Button onClick={() => setEditing(true)}>
                <Pencil aria-hidden />
                {t('budget.edit')}
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t('budget.plannedExpense')} value={formatMoney(expense?.planned)} loading={budget.isLoading} />
        <StatCard label={t('budget.actualExpense')} value={formatMoney(expense?.actual)} loading={budget.isLoading} />
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 shadow-card">
          <p className="text-sm text-muted-foreground">{t('budget.execution')}</p>
          {budget.isLoading ? (
            <Skeleton className="h-8 w-2/3" />
          ) : (
            <p className="text-2xl leading-tight font-semibold tracking-tight">{formatPercent(expense?.percent ?? null)}</p>
          )}
          <Meter value={expense?.percent} tone={executionTone(expense?.percent ?? null)} label={t('budget.execution')} />
        </div>
        <StatCard
          label={t('budget.plannedIncome')}
          value={formatMoney(income?.planned)}
          hint={t('budget.actualIncome', { amount: formatMoney(income?.actual) })}
          loading={budget.isLoading}
        />
      </div>

      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="budget-year">{t('budget.year')}</Label>
          <Select
            id="budget-year"
            value={String(year)}
            onChange={(e) => {
              stopEditing();
              setYear(e.target.value);
            }}
            options={[thisYear - 1, thisYear, thisYear + 1].map((y) => ({ value: String(y), label: budgetYearLabel(y) }))}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="budget-view">{t('budget.view')}</Label>
          <Select
            id="budget-view"
            disabled={editing}
            value={editing ? 'plan' : view}
            onChange={(e) => setView(e.target.value)}
            options={VIEWS.map((v) => ({ value: v, label: t(`budget.views.${v}`) }))}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="budget-center">{t('journal.fields.costCenter')}</Label>
          <Combobox
            id="budget-center"
            value={center?.id ?? null}
            selectedLabel={center?.name}
            onChange={(value, option) => {
              stopEditing();
              setCenter(value && option ? { id: value, name: option.label } : null);
            }}
            loadOptions={apiOptions<CostCenterOption>('/finance/cost-centers/lookup', (c) => ({
              value: c.id,
              label: centerName(c.name, c.type),
              hint: t(`enums:costCenterType.${c.type}`),
            }))}
            placeholder={t('budget.allCenters')}
          />
        </div>
      </div>

      {editing && (
        <div className="mb-3 flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="budget-add">{t('budget.addCategory')}</Label>
            <Combobox
              id="budget-add"
              value={null}
              options={addOptions}
              onChange={(_, option) => {
                if (option) setAdded((list) => [...list, option.raw as CategoryOption]);
              }}
              placeholder={t('journal.chooseCategory')}
            />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={stopEditing}>
              <X aria-hidden />
              {t('common:actions.cancel')}
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={changed === 0}>
              <Save aria-hidden />
              {changed > 0 ? t('budget.saveCount', { n: changed }) : t('common:actions.save')}
            </Button>
          </div>
        </div>
      )}

      {budget.error ? (
        <ErrorCard error={budget.error} onRetry={() => void budget.refetch()} />
      ) : budget.isLoading || !data ? (
        <Skeleton className="h-96 w-full" />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={WalletCards}
            title={t('budget.emptyTitle')}
            description={t('budget.emptyBody')}
            action={
              canUpdate && !editing ? (
                <Button onClick={() => setEditing(true)}>
                  <Pencil aria-hidden />
                  {t('budget.edit')}
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <THead>
              <Tr>
                <Th className={cn(stickyHead, 'z-20')}>{t('budget.category')}</Th>
                <Th className="text-right">{t('budget.views.plan')}</Th>
                <Th className="text-right">{t('budget.views.fact')}</Th>
                <Th className="text-right">{t('budget.views.diff')}</Th>
                <Th className="text-right">{t('budget.percent')}</Th>
                {data.months.map((month) => (
                  <Th key={month} className="text-right whitespace-nowrap">
                    {formatMonthShort(month, true)}
                  </Th>
                ))}
              </Tr>
            </THead>
            <TBody>
              {(['expense', 'income'] as const).map((kind) => {
                const part = rows.filter((row) => row.kind === kind);
                if (part.length === 0) return null;
                return (
                  <Section
                    key={kind}
                    grid={data}
                    kind={kind}
                    rows={part}
                    view={view}
                    editing={editing}
                    edits={edits}
                    onEdit={(key, value) => setEdits((current) => ({ ...current, [key]: value }))}
                  />
                );
              })}
            </TBody>
          </Table>
        </Card>
      )}

      {data && rows.length > 0 && (
        <ChartCard
          className="mt-4"
          title={t('budget.chartTitle')}
          description={t('budget.chartHint')}
          kind="bar"
          data={chartData}
          xKey="month"
          series={[
            { key: 'planned', label: t('budget.views.plan'), slot: 1 },
            { key: 'actual', label: t('budget.views.fact'), slot: 2 },
          ]}
          formatValue={(value) => formatMoney(value)}
          formatX={(month) => formatMonthShort(month)}
          formatLabel={formatMonth}
        />
      )}
    </>
  );
}
