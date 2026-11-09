import { useTranslation } from 'react-i18next';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Meter, MoneyText } from '@/components';
import { ChartCard } from '@/components/ChartCard';
import { formatCompact, formatMoney, formatMonth, formatMonthShort, formatPercent } from '@/lib/format';
import { accountLabel } from '@/features/finance/lib';
import { FigureRow, type LinkTo, localName, NoData } from '../shared';
import type { BudgetTotals, FinanceData } from '../types';

function BudgetLine({ label, totals }: { label: string; totals: BudgetTotals }) {
  const { t } = useTranslation('dashboard');
  const over = totals.percent !== null && totals.percent > 100;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums">{totals.percent === null ? '—' : formatPercent(totals.percent, 0)}</span>
      </div>
      {totals.percent === null ? (
        <NoData />
      ) : (
        <>
          <Meter value={totals.percent} tone={over ? 'danger' : 'primary'} label={label} />
          <p className="mt-1 text-sm text-muted-foreground">
            {t('finance.budgetFact', { actual: formatCompact(totals.actual), planned: formatCompact(totals.planned) })}
            {over && ` · ${t('finance.budgetOver', { value: formatCompact(totals.deviation) })}`}
          </p>
        </>
      )}
    </div>
  );
}

export function FinanceBlock({ data, link }: { data: FinanceData; link: LinkTo }) {
  const { t } = useTranslation('dashboard');
  const { budget, cash, debts, forecast } = data;
  const budgetTo = link('/finance/budget', 'finance.view');
  const debtsTo = link('/finance/debts', 'finance.view');
  const cashflowTo = link('/finance/cashflow', 'finance.view');
  const transactions = link('/finance/transactions', 'finance.view');

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>{t('finance.cash')}</CardTitle>
        </CardHeader>
        <CardContent>
          {cash.accounts.length === 0 && !cash.total && <NoData />}
          <ul>
            {cash.accounts.length === 0 && !!cash.total && <FigureRow label={t('finance.cashTotal')} value={<MoneyText value={cash.total} compact />} />}
            {/* People's cash is one line below, so the list stays the farm's own accounts. */}
            {cash.accounts
              .filter((account) => !account.holder)
              .map((account) => (
                <FigureRow
                  key={account.id}
                  label={accountLabel(account)}
                  hint={t(`enums:accountType.${account.type}`)}
                  value={<MoneyText value={account.balance} currency={account.currency} compact />}
                  to={link('/finance/accounts', 'finance.view')}
                />
              ))}
            {data.capital && data.capital.holders > 0 && (
              <FigureRow
                label={t('finance.cashWithPeople')}
                hint={t('finance.cashWithPeopleHint', { n: data.capital.holders })}
                value={<MoneyText value={data.capital.cashWithPeople} compact />}
                to={link('/finance/cash-holders', 'finance.view')}
              />
            )}
            {data.capital && data.capital.contributed > 0 && (
              <FigureRow
                label={t('finance.invested')}
                hint={t('finance.investedHint')}
                value={<MoneyText value={data.capital.invested} compact />}
                to={link('/finance/cash-holders', 'finance.view')}
              />
            )}
            <FigureRow label={t('finance.monthIncome')} value={<MoneyText value={data.month.income} compact />} to={transactions} />
            <FigureRow label={t('finance.monthExpense')} value={<MoneyText value={data.month.expense} compact />} to={transactions} />
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('finance.budget')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <BudgetLine label={t('finance.thisMonth')} totals={budget.month} />
          <BudgetLine label={t('finance.yearToDate')} totals={budget.year} />
          {budget.overruns.length > 0 && (
            <div>
              <p className="text-sm font-medium">{t('finance.overruns')}</p>
              <ul>
                {budget.overruns.map((row) => (
                  <FigureRow key={row.categoryId} label={localName(row.name)} value={<MoneyText value={row.deviation} compact />} to={budgetTo} />
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('finance.debts')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul>
            <FigureRow label={t('finance.receivable')} value={<MoneyText value={debts.receivable} compact />} to={debtsTo} />
            <FigureRow label={t('finance.payable')} value={<MoneyText value={debts.payable} compact />} to={debtsTo} />
            <FigureRow label={t('finance.overdueDebts')} value={<MoneyText value={debts.overdue} compact />} to={debtsTo} />
            <FigureRow label={t('finance.loans')} value={<MoneyText value={debts.loansOutstanding} compact />} to={link('/finance/loans', 'finance.view')} />
          </ul>
        </CardContent>
      </Card>

      <ChartCard
        className="lg:col-span-2"
        title={t('finance.forecast')}
        description={t('finance.forecastNote')}
        kind="bar"
        data={forecast.months}
        xKey="month"
        series={[
          { key: 'inflow', label: t('finance.inflow'), slot: 1 },
          { key: 'outflow', label: t('finance.outflow'), slot: 2 },
        ]}
        formatValue={(v) => formatMoney(v)}
        formatX={(m) => formatMonthShort(m)}
        formatLabel={formatMonth}
        height={220}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('finance.closing')}</CardTitle>
          {forecast.lowConfidence && <CardDescription>{t('finance.lowConfidence')}</CardDescription>}
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {forecast.firstNegativeMonth && (
            <Alert tone="danger">{t('finance.shortfall', { month: formatMonth(forecast.firstNegativeMonth) })}</Alert>
          )}
          <ul>
            {forecast.months.map((row) => (
              <FigureRow
                key={row.month}
                label={formatMonth(row.month)}
                hint={row.negative ? <Badge variant="danger">{t('finance.negative')}</Badge> : undefined}
                value={<MoneyText value={row.closing} compact />}
                to={cashflowTo}
              />
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
