import { CalendarPlus, Droplets, Pencil, Plus, Sprout, Trash2, TriangleAlert, Wheat } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTable, MoneyText, PageHeader, StatCard, UrlTabs, useConfirm, useUrlParam } from '@/components';
import { Badge, Button, Select } from '@/components/ui';
import { useLocalName } from '@/features/farm/utils';
import { api } from '@/lib/api';
import { usePermission, useSeesCost } from '@/lib/auth';
import { formatDate, formatNumber, formatQty } from '@/lib/format';
import { useApiMutation, useDetail } from '@/lib/query';
import { OPERATIONS, PLANS, SEASONS, SUMMARY } from './options';
import { PlanFactTab } from './PlanFactTab';
import { PlanFormDialog } from './PlanFormDialog';
import { SeasonsTab } from './SeasonsTab';
import { TechCardsTab } from './TechCardsTab';
import type { CropPlan, CropsSummary, Season } from './types';

const STATUS_VARIANT: Record<CropPlan['status'], 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  planned: 'neutral',
  sown: 'info',
  growing: 'success',
  harvested: 'warning',
  cancelled: 'danger',
};

function PlansTab({ seasonId, onAdd }: { seasonId: string; onAdd: () => void }) {
  const { t } = useTranslation('crops');
  const localName = useLocalName();
  const canCreate = usePermission('crops.create');
  const canUpdate = usePermission('crops.update');
  const canDelete = usePermission('crops.delete');
  const seesMoney = useSeesCost('crops.approve');
  const confirm = useConfirm();
  const [editing, setEditing] = useState<CropPlan | null>(null);

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PLANS}/${id}`),
    invalidate: [PLANS, SUMMARY, OPERATIONS],
    successMessage: 'common:toast.deleted',
  });
  const generate = useApiMutation<string, { created: number }>({
    mutationFn: (id) => api.post<{ created: number }>(`${PLANS}/${id}/generate-operations`),
    invalidate: [OPERATIONS, PLANS, SUMMARY],
    successMessage: 'crops:plans.generated',
  });

  const columns: Column<CropPlan>[] = [
    {
      key: 'field',
      header: t('operations.fields.field'),
      mobile: 'title',
      cell: (p) => (
        <>
          №{p.fieldNumber} · {localName(p.cropName)}
          {p.variety && <span className="block text-sm font-normal text-muted-foreground">{p.variety}</span>}
        </>
      ),
    },
    {
      key: 'status',
      header: t('plans.fields.status'),
      sortable: true,
      mobile: 'subtitle',
      cell: (p) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge variant={STATUS_VARIANT[p.status]}>{t(`enums:cropPlanStatus.${p.status}`)}</Badge>
          {p.operationsOverdue > 0 && <Badge variant="danger">{t('plans.overdueWork', { count: p.operationsOverdue })}</Badge>}
        </span>
      ),
    },
    { key: 'areaHa', header: t('plans.fields.area'), sortable: true, align: 'right', cell: (p) => `${formatNumber(p.areaHa)} ${t('unit.ha')}` },
    { key: 'sowingDatePlan', header: t('plans.fields.sowing'), sortable: true, cell: (p) => formatDate(p.sowingDateFact ?? p.sowingDatePlan) },
    { key: 'expected', header: t('planFact.expected'), align: 'right', cell: (p) => formatQty(p.expectedHarvestT, 't') },
    { key: 'lastWork', header: t('plans.lastWork'), mobile: 'hidden', cell: (p) => formatDate(p.lastWorkDate) },
    ...(seesMoney
      ? [{ key: 'plannedCost', header: t('plans.fields.plannedCost'), align: 'right' as const, mobile: 'hidden' as const, cell: (p: CropPlan) => <MoneyText value={p.plannedCost} compact /> }]
      : []),
  ];

  const addButton = canCreate && (
    <Button onClick={onAdd}>
      <Plus aria-hidden />
      {t('plans.add')}
    </Button>
  );

  return (
    <>
      <DataTable<CropPlan>
        path={PLANS}
        params={{ seasonId: seasonId || undefined }}
        columns={columns}
        searchPlaceholder={t('plans.searchPlaceholder')}
        urlPrefix="plans"
        empty={{ icon: Sprout, title: t('plans.emptyTitle'), description: t('plans.emptyBody'), action: addButton }}
        rowActions={(plan) => [
          {
            label: t('plans.generate'),
            icon: CalendarPlus,
            hidden: !canCreate || !plan.techCardId || !plan.sowingDatePlan,
            onClick: () => generate.mutate(plan.id),
          },
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(plan) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({
                title: t('plans.deleteTitle'),
                description: t('plans.deleteBody', { field: plan.fieldNumber }),
                destructive: true,
              });
              if (ok) remove.mutate(plan.id);
            },
          },
        ]}
      />
      <PlanFormDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} plan={editing} />
    </>
  );
}

export default function CropPlansPage() {
  const { t } = useTranslation('crops');
  const canCreate = usePermission('crops.create');
  const [season, setSeason] = useUrlParam('season');
  const [creating, setCreating] = useState(false);

  const { data: seasons } = useDetail<Season[]>(SEASONS);
  const { data: summary, isLoading } = useDetail<CropsSummary>(SUMMARY, { seasonId: season || undefined });

  useEffect(() => {
    if (!season && seasons?.length) setSeason((seasons.find((s) => s.isCurrent) ?? seasons[0]).id);
  }, [season, seasons, setSeason]);

  const fields = summary?.fields;

  return (
    <>
      <PageHeader
        title={t('plans.title')}
        description={t('plans.description')}
        actions={
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select
              aria-label={t('plans.fields.season')}
              value={season}
              onChange={(e) => setSeason(e.target.value)}
              options={(seasons ?? []).map((s) => ({ value: s.id, label: s.name }))}
              placeholder={t('plans.chooseSeason')}
              className="sm:w-52"
            />
            {canCreate && (
              <Button onClick={() => setCreating(true)}>
                <Plus aria-hidden />
                {t('plans.add')}
              </Button>
            )}
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Sprout} label={t('plans.stats.sown')} value={fields ? `${fields.sown} / ${fields.total}` : '—'} loading={isLoading} />
        <StatCard icon={Droplets} label={t('plans.stats.irrigated')} value={fields ? `${fields.irrigated} / ${fields.total}` : '—'} loading={isLoading} />
        <StatCard icon={Wheat} label={t('plans.stats.harvested')} value={fields ? `${fields.harvested} / ${fields.total}` : '—'} loading={isLoading} />
        <StatCard
          icon={TriangleAlert}
          label={t('plans.stats.overdue')}
          value={summary?.overdue.length ?? '—'}
          tone={summary?.overdue.length ? 'danger' : 'neutral'}
          to="/crops/operations?view=overdue"
          loading={isLoading}
        />
      </div>

      <UrlTabs
        tabs={[
          { value: 'plans', label: t('plans.tabs.plans'), content: <PlansTab seasonId={season} onAdd={() => setCreating(true)} /> },
          { value: 'fact', label: t('plans.tabs.fact'), content: <PlanFactTab seasonId={season} /> },
          { value: 'cards', label: t('plans.tabs.cards'), content: <TechCardsTab /> },
          { value: 'seasons', label: t('plans.tabs.seasons'), content: <SeasonsTab /> },
        ]}
      />

      <PlanFormDialog open={creating} onOpenChange={setCreating} seasonId={season} />
    </>
  );
}
