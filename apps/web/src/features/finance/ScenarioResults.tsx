import type { ScenarioAssumptions, ScenarioResult, ScenarioYear } from '@yap/shared/formulas/scenario';
import { CalendarCheck, Scale, TrendingUp, Wallet } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StatCard } from '@/components';
import { ChartCard } from '@/components/ChartCard';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, TBody, THead, Table, Td, Th, Tr } from '@/components/ui';
import { currencyLabel, formatMoney, formatMonth, formatMonthShort, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { keepTogether } from './lib';
import { chartRows } from './scenarioPlan';
import { shortfallPeriod } from './shortfall';

const money = (value: number | null) => formatMoney(value, { plain: true });
const count = (value: number | null) => formatNumber(value, 0);

interface YearRow {
  key: string;
  cell: (year: ScenarioYear) => string;
  strong?: boolean;
}

const YEAR_ROWS: YearRow[] = [
  { key: 'ewes', cell: (y) => count(y.herd.ewes) },
  { key: 'head', cell: (y) => count(y.herd.total) },
  { key: 'lambsBorn', cell: (y) => count(y.lambsBorn) },
  { key: 'lambsSold', cell: (y) => count(y.lambsSold) },
  { key: 'ewesCulled', cell: (y) => count(y.ewesCulled) },
  { key: 'kgSold', cell: (y) => count(y.kgSold) },
  { key: 'revenueLambs', cell: (y) => money(y.revenue.lambs) },
  { key: 'revenueCulls', cell: (y) => money(y.revenue.culls) },
  { key: 'costFeed', cell: (y) => money(y.costs.feed) },
  { key: 'costOther', cell: (y) => money(y.costs.other) },
  { key: 'costFixed', cell: (y) => money(y.costs.fixed) },
  { key: 'costOneOff', cell: (y) => money(y.costs.oneOff) },
  { key: 'costTotal', cell: (y) => money(y.costs.total), strong: true },
  { key: 'profit', cell: (y) => money(y.profit), strong: true },
  { key: 'closingCash', cell: (y) => money(y.closingCash), strong: true },
  { key: 'lowestCash', cell: (y) => (y.lowestCash === null ? '—' : `${money(y.lowestCash)} (${formatMonthShort(y.lowestCashMonth, true)})`) },
];

function YearTable({ years }: { years: ScenarioYear[] }) {
  const { t } = useTranslation('finance');
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('scenarios.years.title')}</CardTitle>
        <CardDescription>{t('scenarios.years.hint', { currency: currencyLabel() })}</CardDescription>
      </CardHeader>
      <CardContent className="px-0 md:px-0">
        <Table>
          <THead>
            <Tr>
              <Th className="min-w-36">{t('scenarios.years.figure')}</Th>
              {years.map((year) => (
                <Th key={year.year} className="h-auto py-2 text-right">
                  {t('scenarios.years.year', { n: year.year })}
                  <span className="block font-normal">
                    {formatMonthShort(year.from, true)} – {formatMonthShort(year.to, true)}
                  </span>
                </Th>
              ))}
            </Tr>
          </THead>
          <TBody>
            {YEAR_ROWS.map((row) => (
              <Tr key={row.key}>
                <Th scope="row" className={cn('h-auto py-2.5 text-sm font-normal whitespace-normal text-foreground', row.strong && 'font-semibold')}>
                  {t(`scenarios.years.rows.${row.key}`)}
                </Th>
                {years.map((year) => (
                  <Td key={year.year} className={cn('text-right whitespace-nowrap tabular-nums', row.strong && 'font-semibold')}>
                    {row.cell(year)}
                  </Td>
                ))}
              </Tr>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export interface ScenarioResultsProps {
  result: ScenarioResult;
  assumptions: ScenarioAssumptions;
}

/** What one set of assumptions leads to. A figure that rests on an empty assumption shows a dash, and the page names the assumption. */
export function ScenarioResults({ result, assumptions }: ScenarioResultsProps) {
  const { t } = useTranslation('finance');
  const { summary } = result;
  const rows = useMemo(() => chartRows(result), [result]);
  const shortfall = shortfallPeriod(rows);
  const firstMonth = rows[0]?.month;
  // Thirty-six months need the year on the axis, and it fits only where a year begins.
  const axisMonth = (month: string) => formatMonthShort(month, month === firstMonth || month.endsWith('-01'));

  const price = assumptions.pricePerKg;
  const breakEven = summary.breakEvenPricePerKg;
  const priceHint =
    price === null
      ? t('scenarios.stats.noPrice')
      : breakEven === null
        ? t('scenarios.stats.assumedPrice', { price: keepTogether(formatMoney(price)) })
        : t(price >= breakEven ? 'scenarios.stats.priceCovers' : 'scenarios.stats.priceShort', { price: keepTogether(formatMoney(price)) });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {result.missing.length > 0 && (
        <Alert tone="warning" title={t('scenarios.missing.title')}>
          {t('scenarios.missing.body', { fields: result.missing.map((key) => t(`scenarios.fields.${key}`)).join(', ') })}
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <StatCard
          label={t('scenarios.stats.breakEven')}
          value={formatMoney(breakEven)}
          hint={priceHint}
          icon={Scale}
          tone={price === null || breakEven === null ? 'neutral' : price >= breakEven ? 'success' : 'danger'}
        />
        <StatCard
          label={t('scenarios.stats.lowestCash')}
          value={formatMoney(summary.lowestCash)}
          hint={summary.lowestCashMonth ? formatMonth(summary.lowestCashMonth) : t('common:status.notEnoughData')}
          icon={Wallet}
          tone={summary.lowestCash === null ? 'neutral' : summary.lowestCash < 0 ? 'danger' : 'success'}
        />
        <StatCard
          label={t('scenarios.stats.payback')}
          value={summary.paybackMonth ? formatMonth(summary.paybackMonth) : summary.netKnown ? t('scenarios.stats.neverPays') : '—'}
          hint={t('scenarios.stats.paybackHint')}
          icon={CalendarCheck}
        />
        <StatCard
          label={t('scenarios.stats.profit')}
          value={formatMoney(summary.profit)}
          hint={summary.profitPerEwePerYear === null ? t('common:status.notEnoughData') : t('scenarios.stats.perEwe', { amount: keepTogether(formatMoney(summary.profitPerEwePerYear)) })}
          icon={TrendingUp}
          tone={summary.profit === null ? 'neutral' : summary.profit < 0 ? 'danger' : 'success'}
        />
      </div>

      {summary.cashKnown && summary.lowestCashMonth && summary.firstNegativeCashMonth && (
        <Alert tone="danger" title={t('scenarios.cash.shortTitle', { month: formatMonth(summary.firstNegativeCashMonth) })}>
          {t('scenarios.cash.shortBody', { amount: keepTogether(formatMoney(summary.lowestCash)), month: formatMonth(summary.lowestCashMonth) })}
        </Alert>
      )}
      {summary.cashKnown && summary.lowestCashMonth && !summary.firstNegativeCashMonth && (
        <Alert tone="success" title={t('scenarios.cash.okTitle')}>
          {t('scenarios.cash.okBody', { amount: keepTogether(formatMoney(summary.lowestCash)), month: formatMonth(summary.lowestCashMonth) })}
        </Alert>
      )}

      <YearTable years={result.years} />

      <ChartCard
        title={t('scenarios.charts.cash')}
        description={t('scenarios.charts.cashHint')}
        kind="area"
        data={rows.some((row) => row.cash !== null) ? rows : []}
        xKey="month"
        series={[{ key: 'cash', label: t('scenarios.charts.closing'), slot: 1, dashed: true }]}
        highlight={shortfall && { ...shortfall, tone: 'danger' }}
        formatValue={(value) => formatMoney(value)}
        formatX={axisMonth}
        formatLabel={formatMonth}
        emptyText={t('scenarios.charts.empty')}
      />
      <ChartCard
        title={t('scenarios.charts.herd')}
        description={t('scenarios.charts.herdHint')}
        kind="line"
        data={rows.some((row) => row.total !== null || row.ewes !== null) ? rows : []}
        xKey="month"
        series={[
          { key: 'total', label: t('scenarios.charts.total'), slot: 1, dashed: true },
          { key: 'ewes', label: t('scenarios.charts.ewes'), slot: 2, dashed: true },
        ]}
        formatValue={(value) => formatNumber(value, 0)}
        formatX={axisMonth}
        formatLabel={formatMonth}
        emptyText={t('scenarios.charts.empty')}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('scenarios.method.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
            <li>
              {summary.costs !== null && summary.kgSold !== null
                ? t('scenarios.method.breakEvenWith', { costs: keepTogether(formatMoney(summary.costs)), kg: keepTogether(formatNumber(summary.kgSold, 0)) })
                : t('scenarios.method.breakEven')}
            </li>
            <li>{t('scenarios.method.months')}</li>
            <li>{t('scenarios.method.leftOut')}</li>
            <li>{t('scenarios.method.notPromise')}</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
