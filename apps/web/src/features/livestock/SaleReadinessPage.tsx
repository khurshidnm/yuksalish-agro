import { ANIMAL_CATEGORIES, type AnimalStatus, SALE_READINESS_STATUSES, SEXES } from '@yap/shared';
import { SALE_READINESS, type SaleReadinessStatus } from '@yap/shared/formulas/sale-readiness';
import { BadgeCheck, BookmarkPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTable, MoneyText, PageHeader, useUrlParam } from '@/components';
import { Alert, Badge, type BadgeVariant, Label, NumberInput, Select } from '@/components/ui';
import { ReserveDialog } from '@/features/sales/reservations/ReserveDialog';
import { useModuleEnabled, usePermission } from '@/lib/auth';
import { formatDate, formatMoney, formatNumber, formatQty } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { useList } from '@/lib/query';
import type { HerdRow } from './shared';

const PATH = '/livestock/sale-readiness';

/** One animal on the list. Buyer, price and value arrive as null for people who may not see them. */
interface ReadinessRow {
  id: string;
  tag: string;
  sex: 'female' | 'male';
  category: string;
  animalStatus: AnimalStatus;
  herdName: string | null;
  targetKg: number | null;
  status: SaleReadinessStatus;
  currentWeightKg: number | null;
  lastWeighedOn: string | null;
  dailyGainKg: number | null;
  targetDate: string | null;
  daysToTarget: number | null;
  notGaining: boolean;
  withdrawalUntil: string | null;
  reservation: { id: string; reservedUntil: string; customer: string | null } | null;
  cullMark: { id: string } | null;
  freeToSell: boolean;
  pricePerKg: number | null;
  estimatedValue: number | null;
}

const STATUS_VARIANT: Record<SaleReadinessStatus, BadgeVariant> = {
  ready: 'success',
  soon: 'info',
  later: 'neutral',
  unknown: 'outline',
};

/** Waits for the typing to stop before the list is asked again. */
const TARGET_DELAY_MS = 500;

export default function SaleReadinessPage() {
  const { t } = useTranslation('livestock');
  const moduleOn = useModuleEnabled();
  const canReserve = usePermission('sales.create') && moduleOn('sales');
  const seesMoney = usePermission('finance.view');
  const seesSettings = usePermission('settings.view');

  const [status, setStatus] = useUrlParam('status');
  const [herdId, setHerdId] = useUrlParam('herd');
  const [sex, setSex] = useUrlParam('sex');
  const [category, setCategory] = useUrlParam('category');
  const [target, setTarget] = useUrlParam('target');
  const [typedTarget, setTypedTarget] = useState<number | null>(Number(target) > 0 ? Number(target) : null);
  // Kept after the dialog closes, so its title does not change while it slides away.
  const [reserving, setReserving] = useState<ReadinessRow | null>(null);
  const [reserveOpen, setReserveOpen] = useState(false);

  useEffect(() => {
    const next = typedTarget !== null && typedTarget > 0 ? String(typedTarget) : '';
    if (next === target) return;
    const timer = window.setTimeout(() => setTarget(next), TARGET_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [typedTarget, target, setTarget]);

  const targetKg = Number(target) > 0 ? Number(target) : undefined;
  const { data: herds } = useList<HerdRow>('/livestock/herds', { pageSize: 100 });
  // One row is enough to learn the farm's own target and its price per kg.
  const sample = useList<ReadinessRow>(PATH, { pageSize: 1 }).data?.data[0];
  const noTarget = targetKg === undefined && sample !== undefined && sample.targetKg === null;

  const columns: Column<ReadinessRow>[] = [
    { key: 'tag', header: t('saleReadiness.columns.animal'), cell: (row) => row.tag, mobile: 'title' },
    {
      key: 'status',
      header: t('saleReadiness.columns.readiness'),
      cell: (row) => <Badge variant={STATUS_VARIANT[row.status]}>{t(`enums:saleReadinessStatus.${row.status}`)}</Badge>,
      mobile: 'subtitle',
    },
    {
      key: 'notes',
      header: t('saleReadiness.columns.notes'),
      cell: (row) => (
        <div className="flex flex-wrap gap-1.5">
          {row.withdrawalUntil && (
            <Badge variant="warning" className="whitespace-normal">
              {t('saleReadiness.withdrawal', { date: formatDate(row.withdrawalUntil) })}
            </Badge>
          )}
          {row.reservation && (
            <Badge variant="info" className="whitespace-normal">
              {row.reservation.customer
                ? t('saleReadiness.reservedFor', { name: row.reservation.customer, date: formatDate(row.reservation.reservedUntil) })
                : t('saleReadiness.reserved', { date: formatDate(row.reservation.reservedUntil) })}
            </Badge>
          )}
          {row.cullMark && <Badge variant="danger">{t('saleReadiness.cull')}</Badge>}
          {row.notGaining && <Badge variant="warning">{t('saleReadiness.notGaining')}</Badge>}
          {row.freeToSell && !row.cullMark && !row.notGaining && <span className="text-sm text-muted-foreground">{t('saleReadiness.free')}</span>}
        </div>
      ),
    },
    { key: 'herd', header: t('saleReadiness.columns.herd'), cell: (row) => row.herdName ?? '—' },
    {
      key: 'weight',
      header: t('saleReadiness.columns.weight'),
      cell: (row) => (
        <div className="flex flex-col">
          <span className="tabular-nums">{formatQty(row.currentWeightKg, t('enums:unit.kg'), 1)}</span>
          {row.lastWeighedOn && <span className="text-xs text-muted-foreground">{t('saleReadiness.weighedOn', { date: formatDate(row.lastWeighedOn) })}</span>}
        </div>
      ),
      align: 'right',
    },
    {
      key: 'gain',
      header: t('saleReadiness.columns.gain'),
      cell: (row) => (row.dailyGainKg === null ? '—' : t('saleReadiness.gramsPerDay', { value: formatNumber(row.dailyGainKg * 1000, 0) })),
      align: 'right',
    },
    {
      key: 'reaches',
      header: t('saleReadiness.columns.reaches'),
      cell: (row) =>
        row.status === 'ready' ? (
          t('saleReadiness.atTarget')
        ) : row.targetDate ? (
          <div className="flex flex-col">
            <span>{formatDate(row.targetDate)}</span>
            {row.daysToTarget !== null && <span className="text-xs text-muted-foreground">{t('saleReadiness.inDays', { days: row.daysToTarget })}</span>}
          </div>
        ) : (
          '—'
        ),
    },
    ...(seesMoney
      ? [{ key: 'value', header: t('saleReadiness.columns.value'), cell: (row: ReadinessRow) => <MoneyText value={row.estimatedValue} />, align: 'right' as const }]
      : []),
  ];

  return (
    <>
      <PageHeader title={t('saleReadiness.title')} description={t('saleReadiness.description')} />

      <div className="mb-3 flex flex-col gap-3">
        {noTarget && (
          <Alert tone="info" title={t('saleReadiness.noTargetTitle')}>
            {t('saleReadiness.noTargetBody')}
            {seesSettings && (
              <>
                {' '}
                <Link to="/settings?tab=sales" className="font-medium underline underline-offset-2">
                  {t('saleReadiness.openSettings')}
                </Link>
              </>
            )}
          </Alert>
        )}
        <p className="text-sm text-muted-foreground">
          {t('saleReadiness.method', { days: SALE_READINESS.recentWindowDays, soon: SALE_READINESS.soonDays })}
          {seesMoney && sample?.pricePerKg != null && <> {t('saleReadiness.valueHint', { price: formatMoney(sample.pricePerKg), days: SALE_READINESS.priceWindowDays })}</>}
        </p>
      </div>

      <DataTable<ReadinessRow>
        path={PATH}
        params={{ status: status || undefined, herdId: herdId || undefined, sex: sex || undefined, category: category || undefined, targetKg }}
        columns={columns}
        searchPlaceholder={t('saleReadiness.searchPlaceholder')}
        rowHref={(row) => `/livestock/animals/${row.id}`}
        filters={
          <>
            <Select
              aria-label={t('saleReadiness.statusFilter')}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              options={enumOptions('saleReadinessStatus', SALE_READINESS_STATUSES)}
              placeholder={t('saleReadiness.allStatuses')}
              className="md:w-48"
            />
            <Select
              aria-label={t('saleReadiness.herdFilter')}
              value={herdId}
              onChange={(e) => setHerdId(e.target.value)}
              options={(herds?.data ?? []).map((h) => ({ value: h.id, label: h.name }))}
              placeholder={t('saleReadiness.allHerds')}
              className="md:w-48"
            />
            <Select
              aria-label={t('saleReadiness.sexFilter')}
              value={sex}
              onChange={(e) => setSex(e.target.value)}
              options={enumOptions('sex', SEXES)}
              placeholder={t('saleReadiness.allSexes')}
              className="md:w-40"
            />
            <Select
              aria-label={t('saleReadiness.categoryFilter')}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              options={enumOptions('animalCategory', ANIMAL_CATEGORIES)}
              placeholder={t('saleReadiness.allCategories')}
              className="md:w-44"
            />
            <div className="flex flex-col gap-1.5 md:w-44">
              <Label htmlFor="sale-target">{t('saleReadiness.target')}</Label>
              <NumberInput id="sale-target" value={typedTarget} onChange={setTypedTarget} maxDigits={1} placeholder={sample?.targetKg != null && targetKg === undefined ? formatNumber(sample.targetKg, 1) : undefined} />
            </div>
          </>
        }
        empty={{ icon: BadgeCheck, title: t('saleReadiness.emptyTitle'), description: t('saleReadiness.emptyBody') }}
        rowActions={(row) => [{
          label: t('saleReadiness.reserve'),
          icon: BookmarkPlus,
          hidden: !canReserve || row.reservation !== null,
          onClick: () => {
            setReserving(row);
            setReserveOpen(true);
          },
        }]}
      />

      <ReserveDialog
        open={reserveOpen && reserving !== null}
        onOpenChange={setReserveOpen}
        animal={reserving ? { id: reserving.id, tag: reserving.tag } : null}
        withdrawalUntil={reserving?.withdrawalUntil}
      />
    </>
  );
}
