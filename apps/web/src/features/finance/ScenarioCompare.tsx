import { type ScenarioAssumptions, type ScenarioResult, runScenario } from '@yap/shared/formulas/scenario';
import { FolderOpen, Pencil, Trash2 } from 'lucide-react';
import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorCard } from '@/components';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Skeleton, TBody, THead, Table, Td, Th, Tr } from '@/components/ui';
import { formatDate, formatMoney, formatMonth, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAssumptionText } from './ScenarioInputs';
import { COMPARE_LIMIT, FIELDS, type SavedScenario, invalidFields } from './scenarioPlan';

/** The plan on the page, in the list of plans to compare. */
export const CURRENT_PLAN = 'current';

export interface ComparedPlan {
  id: string;
  name: string;
  assumptions: ScenarioAssumptions;
}

interface Line {
  key: string;
  label: string;
  cells: string[];
  strong?: boolean;
}

function monthOrNever(month: string | null, known: boolean, never: string): string {
  return month ? formatMonth(month) : known ? never : '—';
}

/** Up to three plans in one table: what each leads to, then the assumptions in which they differ. */
export function CompareTable({ plans }: { plans: ComparedPlan[] }) {
  const { t } = useTranslation('finance');
  const text = useAssumptionText();
  const monthNames = t('common:date.monthsShort', { returnObjects: true }) as unknown as string[];
  // A plan holding a figure the API would refuse is not run: its column shows dashes.
  const results = useMemo(() => plans.map((p) => (invalidFields(p.assumptions).length > 0 ? null : runScenario(p.assumptions))), [plans]);

  const outcome = (key: string, cell: (r: ScenarioResult, a: ScenarioAssumptions) => string, strong?: boolean): Line => ({
    key,
    label: t(`scenarios.compare.rows.${key}`),
    cells: results.map((r, i) => (r ? cell(r, plans[i].assumptions) : '—')),
    strong,
  });
  const outcomes: Line[] = [
    outcome('breakEven', (r) => formatMoney(r.summary.breakEvenPricePerKg), true),
    outcome('price', (_, a) => formatMoney(a.pricePerKg)),
    outcome('profit', (r) => formatMoney(r.summary.profit), true),
    outcome('revenue', (r) => formatMoney(r.summary.revenue)),
    outcome('costs', (r) => formatMoney(r.summary.costs)),
    outcome('perEwe', (r) => formatMoney(r.summary.profitPerEwePerYear)),
    outcome('lowestCash', (r) => (r.summary.lowestCash === null ? '—' : `${formatMoney(r.summary.lowestCash)} (${formatMonth(r.summary.lowestCashMonth)})`), true),
    outcome('firstNegative', (r) => monthOrNever(r.summary.firstNegativeCashMonth, r.summary.cashKnown, t('scenarios.compare.never'))),
    outcome('payback', (r) => monthOrNever(r.summary.paybackMonth, r.summary.netKnown, t('scenarios.stats.neverPays'))),
    outcome('closingCash', (r) => formatMoney(r.years[r.years.length - 1]?.closingCash ?? null)),
    outcome('ewes', (r) => formatNumber(r.years[r.years.length - 1]?.herd.ewes ?? null, 0)),
  ];

  const stall = (months: number[] | null) => (months === null ? '—' : months.length === 0 ? t('scenarios.compare.none') : months.map((m) => monthNames[m - 1]).join(', '));
  const oneOffs = (a: ScenarioAssumptions) => formatMoney(a.oneOffs.reduce((sum, o) => sum + o.amount, 0));
  const assumed: Line[] = [
    { key: 'startMonth', label: t('scenarios.fields.startMonth'), cells: plans.map((p) => formatMonth(p.assumptions.startMonth)) },
    ...FIELDS.map((spec) => ({ key: spec.key, label: t(`scenarios.fields.${spec.key}`), cells: plans.map((p) => text(spec, p.assumptions[spec.key])) })),
    { key: 'stallMonths', label: t('scenarios.fields.stallMonths'), cells: plans.map((p) => stall(p.assumptions.stallMonths)) },
    { key: 'oneOffs', label: t('scenarios.oneOffs.title'), cells: plans.map((p) => oneOffs(p.assumptions)) },
  ].filter((line) => new Set(line.cells).size > 1);

  const columns = plans.length + 1;
  const rows = (lines: Line[]) =>
    lines.map((line) => (
      <Tr key={line.key}>
        <Th scope="row" className={cn('h-auto py-2.5 text-sm font-normal whitespace-normal text-foreground', line.strong && 'font-semibold')}>
          {line.label}
        </Th>
        {line.cells.map((cell, i) => (
          <Td key={plans[i].id} className={cn('text-right whitespace-nowrap tabular-nums', line.strong && 'font-semibold')}>
            {cell}
          </Td>
        ))}
      </Tr>
    ));
  const heading = (label: string) => (
    <Tr className="bg-muted">
      <Th scope="colgroup" colSpan={columns} className="h-9 text-foreground">
        {label}
      </Th>
    </Tr>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('scenarios.compare.title')}</CardTitle>
        <CardDescription>{t('scenarios.compare.hint')}</CardDescription>
      </CardHeader>
      <CardContent className="px-0 md:px-0">
        <Table>
          <THead>
            <Tr>
              <Th className="min-w-36">{t('scenarios.years.figure')}</Th>
              {plans.map((plan) => (
                <Th key={plan.id} className="h-auto max-w-48 py-2 text-right whitespace-normal text-foreground">
                  {plan.name}
                </Th>
              ))}
            </Tr>
          </THead>
          <TBody>
            {heading(t('scenarios.compare.outcomes'))}
            {rows(outcomes)}
            {heading(t('scenarios.compare.differences'))}
            {assumed.length > 0 ? (
              rows(assumed)
            ) : (
              <Tr>
                <Td colSpan={columns} className="text-muted-foreground">
                  {t('scenarios.compare.noDifferences')}
                </Td>
              </Tr>
            )}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export interface SavedPlansProps {
  rows: SavedScenario[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  loadedId: string | null;
  compare: string[];
  onCompare: (ids: string[]) => void;
  onLoad: (row: SavedScenario) => void;
  /** Left out when the person may not do it. */
  onRename?: (row: SavedScenario) => void;
  onDelete?: (row: SavedScenario) => void;
  canSave: boolean;
}

/** Saved plans: open one on the page, or tick up to three to see them side by side. */
export function SavedPlans({ rows, loading, error, onRetry, loadedId, compare, onCompare, onLoad, onRename, onDelete, canSave }: SavedPlansProps) {
  const { t } = useTranslation('finance');
  const currentId = useId();
  const full = compare.length >= COMPARE_LIMIT;
  const toggle = (id: string, on: boolean) => onCompare(on ? [...compare, id].slice(0, COMPARE_LIMIT) : compare.filter((x) => x !== id));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('scenarios.saved.title')}</CardTitle>
        <CardDescription>{t('scenarios.saved.hint', { n: COMPARE_LIMIT })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error ? (
          <ErrorCard error={error} onRetry={onRetry} />
        ) : loading || !rows ? (
          <>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </>
        ) : rows.length === 0 ? (
          <EmptyState icon={FolderOpen} title={t('scenarios.saved.emptyTitle')} description={t(canSave ? 'scenarios.saved.emptyBody' : 'scenarios.saved.emptyBodyReadOnly')} className="py-8" />
        ) : (
          <>
            <div className="flex min-h-11 items-center gap-3 rounded-lg border border-dashed border-border px-3 py-2">
              <Checkbox
                id={currentId}
                checked={compare.includes(CURRENT_PLAN)}
                disabled={full && !compare.includes(CURRENT_PLAN)}
                onCheckedChange={(on) => toggle(CURRENT_PLAN, on === true)}
              />
              <label htmlFor={currentId} className="min-w-0 flex-1 text-sm font-medium">
                {t('scenarios.compare.current')}
              </label>
            </div>
            <ul className="flex flex-col gap-2">
              {rows.map((row) => {
                const ticked = compare.includes(row.id);
                return (
                  <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border px-3 py-2">
                    <Checkbox
                      checked={ticked}
                      disabled={full && !ticked}
                      onCheckedChange={(on) => toggle(row.id, on === true)}
                      aria-label={t('scenarios.saved.compareOne', { name: row.name })}
                    />
                    <div className="min-w-0 flex-1 basis-40">
                      <p className="flex flex-wrap items-center gap-2 font-medium break-words">
                        {row.name}
                        {row.id === loadedId && <Badge variant="info">{t('scenarios.saved.open')}</Badge>}
                      </p>
                      <p className="text-sm break-words text-muted-foreground">
                        {row.notes ? `${row.notes} · ` : ''}
                        {t('scenarios.saved.updated', { date: formatDate(row.updatedAt) })}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="outline" size="sm" onClick={() => onLoad(row)}>
                        {t('scenarios.saved.load')}
                      </Button>
                      {onRename && (
                        <Button variant="ghost" size="icon-sm" aria-label={t('scenarios.saved.renameOne', { name: row.name })} onClick={() => onRename(row)}>
                          <Pencil aria-hidden />
                        </Button>
                      )}
                      {onDelete && (
                        <Button variant="ghost" size="icon-sm" aria-label={t('scenarios.saved.deleteOne', { name: row.name })} onClick={() => onDelete(row)}>
                          <Trash2 aria-hidden />
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {full && <p className="text-sm text-muted-foreground">{t('scenarios.saved.limit', { n: COMPARE_LIMIT })}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
