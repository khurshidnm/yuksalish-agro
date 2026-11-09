import { useTranslation } from 'react-i18next';
import { StatCard } from '@/components';
import { formatMoney } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { FINANCE_PATHS } from './lib';
import type { ActualMonth } from './types';

/**
 * Money in less money out over a period, counted as the cash-flow page counts it: loans and the owner's
 * money are in, entries on credit and depreciation are not. Over all time it is the change in Kassa va
 * bank, so it can stand next to the balances. Income less expense cannot: it subtracts animals, machinery
 * and stock bought, and is neither cash nor the farm's result.
 */
export function CashFlowStat({ from, to }: { from?: string; to?: string }) {
  const { t } = useTranslation('finance');
  const months = useDetail<ActualMonth[]>(`${FINANCE_PATHS.cashflow}/actual`, { from: from || undefined, to: to || undefined });
  const net = months.data ? Math.round(months.data.reduce((sum, month) => sum + month.net, 0)) : null;
  return <StatCard label={t('journal.cashNet')} value={formatMoney(net)} hint={t('journal.cashNetHint')} loading={months.isLoading} />;
}
