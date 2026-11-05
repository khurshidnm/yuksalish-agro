import { hectaresForShortage, round } from '@yap/shared';
import { latinToCyrillic } from '@yap/shared/i18n';
import { CalendarDays, Coins, PackageX, Scale, Sprout, Wheat } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type Column,
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTableView,
  EmptyState,
  ErrorCard,
  Label,
  NumberInput,
  PageHeader,
  Select,
  Skeleton,
  StatCard,
  Tabs,
  TabsList,
  TabsTrigger,
  useUrlParam,
} from '@/components';
import { useSeesCost } from '@/lib/auth';
import { formatDate, formatMoney, formatNumber } from '@/lib/format';
import i18n from '@/lib/i18n';
import { useDetail, useList } from '@/lib/query';
import { formatKg } from './format';
import type { Ration, WinterPlan, WinterRow } from './types';

function cropName(row: WinterRow): string {
  if (!row.cropName) return '';
  if (i18n.language === 'uz-Cyrl') return latinToCyrillic(row.cropName.uz);
  return row.cropName[i18n.language as 'uz' | 'ru' | 'en'] ?? row.cropName.uz;
}

function SowingCard({ rows }: { rows: WinterRow[] }) {
  const { t } = useTranslation('feed');
  const [yields, setYields] = useState<Record<string, number | null>>({});
  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('winter.sowing.title')}</CardTitle>
        <CardDescription>{t('winter.sowing.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y divide-border">
          {rows.map((row) => {
            const yieldTHa = row.itemId in yields ? yields[row.itemId] : row.yieldTHa;
            const hectares = yieldTHa ? hectaresForShortage(row.shortageKg ?? 0, yieldTHa) : null;
            const id = `yield-${row.itemId}`;
            return (
              <li key={row.itemId} className="grid grid-cols-1 items-center gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_11rem_9rem]">
                <div className="min-w-0">
                  <p className="font-medium break-words">{cropName(row)}</p>
                  <p className="text-sm text-muted-foreground">{t('winter.sowing.short', { name: row.name, qty: formatKg(row.shortageKg) })}</p>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={id} className="text-xs text-muted-foreground">
                    {t('winter.sowing.yield')}
                  </Label>
                  <NumberInput id={id} value={yieldTHa ?? null} onChange={(value) => setYields((prev) => ({ ...prev, [row.itemId]: value }))} suffix={t('winter.sowing.yieldUnit')} />
                </div>
                <p className="text-lg font-semibold tabular-nums sm:text-right">
                  {hectares === null ? t('winter.sowing.enterYield') : t('winter.sowing.hectares', { ha: formatNumber(round(hectares, 2), 2) })}
                </p>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function Conclusion({ plan, canSeeMoney }: { plan: WinterPlan; canSeeMoney: boolean }) {
  const { t } = useTranslation('feed');
  const short = plan.rows.filter((row) => (row.shortageKg ?? 0) > 0);
  // Stock that cannot be turned into kilograms is not the same as enough stock (rule 5).
  const unknown = plan.rows.filter((row) => row.shortageKg === null);
  if (unknown.length > 0 && short.length === 0) {
    return (
      <Alert tone="warning" title={t('winter.unknownTitle')}>
        {t('winter.unknownBody', { names: unknown.map((row) => row.name).join(', ') })}
      </Alert>
    );
  }
  if (short.length === 0) {
    return (
      <Alert tone="success" title={t('winter.enoughTitle')}>
        {t('winter.enoughBody', { days: plan.days, head: formatNumber(plan.head, 0) })}
      </Alert>
    );
  }
  return (
    <Alert tone="warning" title={t('winter.shortTitle', { count: short.length })}>
      <ul className="mt-1 list-inside list-disc">
        {short.map((row) => (
          <li key={row.itemId}>{t('winter.shortLine', { name: row.name, qty: formatKg(row.shortageKg), date: formatDate(row.runsOutOn) })}</li>
        ))}
      </ul>
      {canSeeMoney && plan.totals.purchaseCost !== null && <p className="mt-2 font-medium">{t('winter.purchaseTotal', { amount: formatMoney(plan.totals.purchaseCost) })}</p>}
    </Alert>
  );
}

export default function WinterPlanPage() {
  const { t } = useTranslation('feed');
  const canSeeMoney = useSeesCost('feed.approve');
  const [mode, setMode] = useUrlParam('mode', 'herds');
  const [daysParam, setDaysParam] = useUrlParam('days');
  const [rationId, setRationId] = useUrlParam('ration');
  const [headParam, setHeadParam] = useUrlParam('head');

  const scenario = mode === 'scenario';
  const ready = !scenario || (rationId !== '' && headParam !== '');
  const params = { days: daysParam || undefined, ...(scenario ? { rationId, head: headParam } : {}) };
  const plan = useDetail<WinterPlan>('/feed/winter-plan', params, { enabled: ready });
  const rations = useList<Ration>('/feed/rations', { pageSize: 100 }, { enabled: scenario });

  const columns: Column<WinterRow>[] = [
    { key: 'name', header: t('winter.columns.feed'), cell: (row) => row.name, mobile: 'title' },
    {
      key: 'balance',
      header: t('winter.columns.balance'),
      mobile: 'subtitle',
      cell: (row) =>
        row.shortageKg === null ? (
          t('winter.unknown')
        ) : row.shortageKg > 0 ? (
          <Badge variant="danger">{t('winter.shortage', { qty: formatKg(row.shortageKg) })}</Badge>
        ) : (
          <Badge variant="success">{t('winter.surplus', { qty: formatKg(row.surplusKg) })}</Badge>
        ),
    },
    { key: 'required', header: t('winter.columns.required'), align: 'right', cell: (row) => formatKg(row.requiredKg) },
    { key: 'stock', header: t('winter.columns.stock'), align: 'right', cell: (row) => formatKg(row.stockKg) },
    { key: 'daily', header: t('winter.columns.daily'), align: 'right', cell: (row) => formatKg(row.dailyKg), mobile: 'hidden' },
    {
      key: 'coverage',
      header: t('winter.columns.coverage'),
      align: 'right',
      cell: (row) => (row.coverageDays === null ? '—' : t('winter.coverage', { days: formatNumber(row.coverageDays, 0), date: formatDate(row.runsOutOn) })),
    },
    ...(canSeeMoney ? [{ key: 'cost', header: t('winter.columns.cost'), align: 'right' as const, cell: (row: WinterRow) => (row.shortageKg ? formatMoney(row.purchaseCost) : '—') }] : []),
  ];

  const growable = plan.data?.rows.filter((row) => (row.shortageKg ?? 0) > 0 && row.cropId) ?? [];

  return (
    <>
      <PageHeader title={t('winter.title')} description={t('winter.description')} />

      <div className="flex flex-col gap-6">
        <Card>
          <CardContent className="flex flex-col gap-4">
            <Tabs value={mode} onValueChange={setMode}>
              <TabsList>
                <TabsTrigger value="herds">{t('winter.modeHerds')}</TabsTrigger>
                <TabsTrigger value="scenario">{t('winter.modeScenario')}</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="winter-days">{t('winter.days')}</Label>
                <NumberInput
                  id="winter-days"
                  value={daysParam ? Number(daysParam) : (plan.data?.days ?? null)}
                  onChange={(value) => setDaysParam(value ? String(Math.round(value)) : '')}
                  suffix={t('winter.daysUnit')}
                  maxDigits={0}
                />
              </div>
              {scenario && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="winter-ration">{t('winter.ration')}</Label>
                    <Select
                      id="winter-ration"
                      value={rationId}
                      onChange={(e) => setRationId(e.target.value)}
                      options={(rations.data?.data ?? []).map((ration) => ({ value: ration.id, label: ration.name }))}
                      placeholder={t('common:form.selectPlaceholder')}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="winter-head">{t('winter.head')}</Label>
                    <NumberInput
                      id="winter-head"
                      value={headParam ? Number(headParam) : null}
                      onChange={(value) => setHeadParam(value ? String(Math.round(value)) : '')}
                      suffix={t('winter.headUnit')}
                      maxDigits={0}
                    />
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {!ready && <EmptyState icon={Wheat} title={t('winter.scenarioPromptTitle')} description={t('winter.scenarioPromptBody')} />}
        {plan.error && <ErrorCard error={plan.error} onRetry={() => void plan.refetch()} />}
        {ready && plan.isLoading && <Skeleton className="h-64" />}

        {ready && plan.data && plan.data.rows.length === 0 && <EmptyState icon={Wheat} title={t('winter.emptyTitle')} description={t('winter.emptyBody')} />}

        {ready && plan.data && plan.data.rows.length > 0 && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label={t('winter.stats.herd')} value={t('winter.headValue', { head: formatNumber(plan.data.head, 0) })} hint={t('winter.stats.days', { days: plan.data.days })} icon={CalendarDays} />
              <StatCard label={t('winter.stats.required')} value={formatKg(plan.data.totals.requiredKg)} icon={Scale} />
              <StatCard
                label={t('winter.stats.shortage')}
                value={formatKg(plan.data.totals.shortageKg)}
                hint={t('winter.stats.shortItems', { count: plan.data.totals.shortItems })}
                icon={PackageX}
                tone={plan.data.totals.shortItems > 0 ? 'danger' : 'success'}
              />
              {canSeeMoney && <StatCard label={t('winter.stats.purchase')} value={formatMoney(plan.data.totals.purchaseCost)} icon={Coins} />}
            </div>

            <Conclusion plan={plan.data} canSeeMoney={canSeeMoney} />

            <DataTableView rows={plan.data.rows} columns={columns} rowKey={(row) => row.itemId} />

            <SowingCard key={`${plan.data.days}:${plan.data.head}`} rows={growable} />
            {growable.length === 0 && (plan.data.totals.shortItems ?? 0) > 0 && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Sprout className="size-4" aria-hidden />
                {t('winter.sowing.noCrop')}
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}
