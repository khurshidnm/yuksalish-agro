import { Baby, HeartHandshake, Percent, Scale } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ErrorCard, StatCard } from '@/components';
import { formatNumber, formatPercent, formatQty } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { EweScores } from './EweScores';
import { BREEDING_PATH } from './options';
import type { ReproductionKpis } from './types';

export function KpisTab() {
  const { t } = useTranslation('vet');
  const kpis = useDetail<ReproductionKpis>(`${BREEDING_PATH}/kpis`);

  if (kpis.error) return <ErrorCard error={kpis.error} onRetry={() => void kpis.refetch()} />;
  const data = kpis.data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t('kpis.lambingPercent')}
          value={formatPercent(data?.lambingPercent ?? null)}
          hint={data && t('kpis.lambingPercentHint', { born: data.lambsBorn, ewes: data.ewesWithOutcome })}
          icon={Percent}
          loading={kpis.isLoading}
        />
        <StatCard label={t('kpis.survival')} value={formatPercent(data?.survivalPercent ?? null)} hint={t('kpis.survivalHint')} icon={HeartHandshake} loading={kpis.isLoading} />
        <StatCard
          label={t('kpis.lambsPerEwe')}
          value={formatNumber(data?.lambsPerEwe ?? null, 2)}
          hint={data && t('kpis.lambingsCount', { count: data.lambings })}
          icon={Baby}
          loading={kpis.isLoading}
        />
        <StatCard label={t('kpis.weight100')} value={formatQty(data?.avgWeight100Kg ?? null, 'kg')} hint={t('kpis.weight100Hint')} icon={Scale} loading={kpis.isLoading} />
      </div>
      <h2 className="text-lg font-semibold">{t('kpis.byEwe')}</h2>
      <p className="text-sm text-muted-foreground">{t('score.listHint')}</p>
      <EweScores />
    </div>
  );
}
