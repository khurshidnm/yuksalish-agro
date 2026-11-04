import { Fuel, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ErrorCard, MoneyText, PageHeader, StatCard, UrlTabs } from '@/components';
import { Alert, Badge, Button, Card, CardContent, Skeleton } from '@/components/ui';
import { useCan, usePermission } from '@/lib/auth';
import { formatDate, formatNumber } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { AssetCostsTab } from './AssetCostsTab';
import { AssetFormDialog } from './AssetFormDialog';
import { AssetMaintenanceTab } from './AssetMaintenanceTab';
import { AssetUsageTab, ShiftDialog } from './AssetUsageTab';
import { STATUS_VARIANT } from './AssetsPage';
import type { AssetCard } from './types';

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

function Overview({ asset }: { asset: AssetCard }) {
  const { t } = useTranslation('assets');
  const seesMoney = usePermission('finance.view');
  const due = asset.maintenanceDue;
  return (
    <div className="space-y-4">
      {due?.overdue && (
        <Alert tone="warning" title={t('serviceDueTitle')}>
          {[due.nextDueDate ? formatDate(due.nextDueDate) : null, due.nextDueMotoHours === null ? null : `${formatNumber(due.nextDueMotoHours)} ${t('unit.hours')}`]
            .filter(Boolean)
            .join(' · ')}
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('fields.motoHours')} value={formatNumber(asset.motoHours)} />
        <StatCard label={t('overview.shifts')} value={formatNumber(asset.usage.shifts)} />
        <StatCard label={t('overview.hectares')} value={`${formatNumber(asset.usage.hectares)} ${t('unit.ha')}`} />
        <StatCard icon={Fuel} label={t('overview.fuel')} value={`${formatNumber(asset.usage.fuelL)} ${t('unit.liters')}`} />
      </div>

      <Card>
        <CardContent className="pt-4">
          <Fact label={t('fields.type')}>{t(`enums:assetType.${asset.type}`)}</Fact>
          <Fact label={t('fields.inventoryNo')}>{asset.inventoryNo ?? '—'}</Fact>
          {!asset.rented && <Fact label={t('fields.purchaseDate')}>{formatDate(asset.purchaseDate)}</Fact>}
          {!asset.rented && seesMoney && (
            <>
              <Fact label={t('fields.purchasePrice')}>
                <MoneyText value={asset.purchasePrice} />
              </Fact>
              <Fact label={t('overview.accumulated')}>
                <MoneyText value={asset.accumulatedDepreciation} />
              </Fact>
              <Fact label={t('overview.bookValue')}>
                <MoneyText value={asset.bookValue} />
              </Fact>
            </>
          )}
          {!asset.rented && <Fact label={t('fields.depreciationMethod')}>{t(`enums:depreciationMethod.${asset.depreciationMethod}`)}</Fact>}
          <Fact label={t('fields.fuelNormHour')}>{asset.fuelNormLPerHour === null ? '—' : `${formatNumber(asset.fuelNormLPerHour)} ${t('unit.lPerHour')}`}</Fact>
          <Fact label={t('fields.fuelNormHa')}>{asset.fuelNormLPerHa === null ? '—' : `${formatNumber(asset.fuelNormLPerHa)} ${t('unit.lPerHa')}`}</Fact>
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
  const canLog = can('assets.create') || can('crops.create');
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState(false);

  const { data: asset, isLoading, error, refetch } = useDetail<AssetCard>(`/assets/${id}`);

  if (error) return <ErrorCard error={error} onRetry={() => void refetch()} />;
  if (isLoading || !asset) return <Skeleton className="h-64 w-full" />;

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
                {t('usage.add')}
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
          { value: 'overview', label: t('tabs.overview'), content: <Overview asset={asset} /> },
          { value: 'usage', label: t('tabs.usage'), content: <AssetUsageTab assetId={id} /> },
          { value: 'service', label: t('tabs.maintenance'), content: <AssetMaintenanceTab assetId={id} /> },
          { value: 'costs', label: t('tabs.costs'), hidden: !seesMoney, content: <AssetCostsTab asset={asset} /> },
        ]}
      />

      <AssetFormDialog open={editing} onOpenChange={setEditing} asset={asset} />
      <ShiftDialog assetId={id} open={logging} onOpenChange={setLogging} />
    </>
  );
}
