import { Fuel, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ErrorCard, MoneyText, PageHeader, StatCard, UrlTabs } from '@/components';
import { Alert, Badge, Button, Card, CardContent, Skeleton } from '@/components/ui';
import { useCan, usePermission } from '@/lib/auth';
import { formatDate, formatMoney, formatNumber } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { cn } from '@/lib/utils';
import { AssetCostsTab } from './AssetCostsTab';
import { AssetFormDialog } from './AssetFormDialog';
import { AssetMaintenanceTab } from './AssetMaintenanceTab';
import { AssetUsageTab, ShiftDialog } from './AssetUsageTab';
import { STATUS_VARIANT } from './AssetsPage';
import { type AssetKind, assetKind } from './assetKinds';
import { depreciationGaps } from './depreciationGaps';
import type { AssetCard } from './types';

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

function Overview({ asset, kind }: { asset: AssetCard; kind: AssetKind }) {
  const { t } = useTranslation('assets');
  const seesMoney = usePermission('finance.view');
  const due = asset.maintenanceDue;
  const gaps = depreciationGaps(asset);
  // A generator works no field and a plough has no engine: their tiles would only ever read 0.
  // A figure that was recorded still shows, whatever the type.
  const engine = kind.hasEngine || asset.motoHours > 0 || asset.usage.fuelL > 0;
  const fields = kind.worksFields || asset.usage.hectares > 0;
  const stats = [
    engine && <StatCard key="hours" label={t('fields.motoHours')} value={formatNumber(asset.motoHours)} />,
    (kind.logsWork || asset.usage.shifts > 0) && <StatCard key="shifts" label={t('overview.shifts')} value={formatNumber(asset.usage.shifts)} />,
    fields && <StatCard key="ha" label={t('overview.hectares')} value={`${formatNumber(asset.usage.hectares)} ${t('unit.ha')}`} />,
    engine && <StatCard key="fuel" icon={Fuel} label={t('overview.fuel')} value={`${formatNumber(asset.usage.fuelL)} ${t('unit.liters')}`} />,
  ].filter(Boolean);
  return (
    <div className="space-y-4">
      {gaps.length > 0 && (
        <Alert tone="warning">
          {gaps.map((gap) => (
            <p key={gap}>{t(`depreciation.gap.${gap}`)}</p>
          ))}
        </Alert>
      )}
      {due?.overdue && (
        <Alert tone="warning" title={t('serviceDueTitle')}>
          {[due.nextDueDate ? formatDate(due.nextDueDate) : null, due.nextDueMotoHours === null ? null : `${formatNumber(due.nextDueMotoHours)} ${t('unit.hours')}`]
            .filter(Boolean)
            .join(' · ')}
        </Alert>
      )}

      {stats.length > 0 && <div className={cn('grid grid-cols-2 gap-3', stats.length === 3 ? 'lg:grid-cols-3' : 'lg:grid-cols-4')}>{stats}</div>}

      <Card>
        <CardContent className="pt-4">
          <Fact label={t('fields.type')}>{t(`enums:assetType.${asset.type}`)}</Fact>
          <Fact label={t('fields.inventoryNo')}>{asset.inventoryNo ?? '—'}</Fact>
          {!asset.rented && <Fact label={t('fields.purchaseDate')}>{formatDate(asset.purchaseDate)}</Fact>}
          {!asset.rented && seesMoney && (
            <>
              <Fact label={t('fields.purchasePrice')}>
                <MoneyText value={asset.purchasePrice} />
                {asset.purchaseCurrency && asset.purchaseAmount !== null && (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {t('overview.original', { amount: formatMoney(asset.purchaseAmount, { currency: asset.purchaseCurrency }), rate: formatNumber(asset.purchaseFxRate, 2) })}
                  </span>
                )}
              </Fact>
              {!!asset.openingDepreciation && (
                <Fact label={t('overview.opening', { date: formatDate(asset.openingDepreciationDate) })}>
                  <MoneyText value={asset.openingDepreciation} />
                </Fact>
              )}
              <Fact label={t('overview.accumulated')}>
                <MoneyText value={asset.accumulatedDepreciation} />
              </Fact>
              <Fact label={t('overview.bookValue')}>
                <MoneyText value={asset.bookValue} />
              </Fact>
            </>
          )}
          {!asset.rented && <Fact label={t('fields.depreciationMethod')}>{t(`enums:depreciationMethod.${asset.depreciationMethod}`)}</Fact>}
          {(kind.hasEngine || asset.fuelNormLPerHour !== null) && (
            <Fact label={t('fields.fuelNormHour')}>{asset.fuelNormLPerHour === null ? '—' : `${formatNumber(asset.fuelNormLPerHour)} ${t('unit.lPerHour')}`}</Fact>
          )}
          {((kind.worksFields && kind.hasEngine) || asset.fuelNormLPerHa !== null) && (
            <Fact label={t('fields.fuelNormHa')}>{asset.fuelNormLPerHa === null ? '—' : `${formatNumber(asset.fuelNormLPerHa)} ${t('unit.lPerHa')}`}</Fact>
          )}
          {asset.rented && seesMoney && asset.rentalUnit && (
            <Fact label={t('fields.rentalPrice')}>
              <MoneyText value={asset.rentalPrice} /> / {t(`rentalUnit.${asset.rentalUnit}`)}
            </Fact>
          )}
          {asset.lastMaintenance && (
            <Fact label={t('overview.lastService')}>
              {formatDate(asset.lastMaintenance.date)} · {t(`enums:maintenanceType.${asset.lastMaintenance.type}`)}
            </Fact>
          )}
        </CardContent>
      </Card>

      {asset.notes && <p className="text-sm whitespace-pre-wrap">{asset.notes}</p>}
    </div>
  );
}

export default function AssetCardPage() {
  const { t } = useTranslation('assets');
  const { id = '' } = useParams();
  const can = useCan();
  const canEdit = usePermission('assets.update');
  const seesMoney = usePermission('finance.view');
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState(false);

  const { data: asset, isLoading, error, refetch } = useDetail<AssetCard>(`/assets/${id}`);

  if (error) return <ErrorCard error={error} onRetry={() => void refetch()} />;
  if (isLoading || !asset) return <Skeleton className="h-64 w-full" />;

  const kind = assetKind(asset.type);
  // A scale or a camera has no hours, fuel or field work, so it has no work log either.
  const hasLog = kind.logsWork || asset.usage.shifts > 0;
  const canLog = (can('assets.create') || can('crops.create')) && hasLog;

  return (
    <>
      <PageHeader
        back={{ to: '/assets', label: t('title') }}
        title={asset.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_VARIANT[asset.status] ?? 'neutral'}>{t(`enums:assetStatus.${asset.status}`)}</Badge>
            {asset.rented && <Badge variant="outline">{t('rentedBadge')}</Badge>}
          </span>
        }
        actions={
          <div className="flex flex-col gap-2 sm:flex-row">
            {canLog && (
              <Button size="lg" onClick={() => setLogging(true)}>
                <Plus aria-hidden />
                {kind.stationary ? t('usage.addHours') : t('usage.add')}
              </Button>
            )}
            {canEdit && (
              <Button size="lg" variant="outline" onClick={() => setEditing(true)}>
                <Pencil aria-hidden />
                {t('common:actions.edit')}
              </Button>
            )}
          </div>
        }
      />

      <UrlTabs
        tabs={[
          { value: 'overview', label: t('tabs.overview'), content: <Overview asset={asset} kind={kind} /> },
          { value: 'usage', label: t('tabs.usage'), hidden: !hasLog, content: <AssetUsageTab asset={asset} kind={kind} /> },
          { value: 'service', label: t('tabs.maintenance'), content: <AssetMaintenanceTab assetId={id} /> },
          { value: 'costs', label: t('tabs.costs'), hidden: !seesMoney, content: <AssetCostsTab asset={asset} kind={kind} /> },
        ]}
      />

      <AssetFormDialog open={editing} onOpenChange={setEditing} asset={asset} />
      {canLog && <ShiftDialog assetId={id} kind={kind} open={logging} onOpenChange={setLogging} />}
    </>
  );
}
