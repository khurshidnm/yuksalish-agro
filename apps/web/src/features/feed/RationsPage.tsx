import { Calculator, Pencil, Plus, Trash2, Wheat } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, ErrorCard, PageHeader, Skeleton, useConfirm } from '@/components';
import { api } from '@/lib/api';
import { usePermission, useSeesCost } from '@/lib/auth';
import { formatMoney, formatNumber } from '@/lib/format';
import { useApiMutation, useList } from '@/lib/query';
import { RationNutrientsSection } from './NutrientBalance';
import { RationDialog } from './RationDialog';
import type { Ration } from './types';

function RationCard({ ration, canEdit, canDelete, canSeeMoney, onEdit, onDelete }: {
  ration: Ration;
  canEdit: boolean;
  canDelete: boolean;
  canSeeMoney: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation('feed');
  return (
    <Card className="flex flex-col">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle className="break-words">{ration.name}</CardTitle>
          <Badge className="mt-1">{t(`enums:physiologicalState.${ration.state}`)}</Badge>
        </div>
        <div className="flex shrink-0">
          {canEdit && (
            <Button variant="ghost" size="icon-sm" aria-label={t('common:actions.edit')} onClick={onEdit}>
              <Pencil aria-hidden />
            </Button>
          )}
          {canDelete && (
            <Button variant="ghost" size="icon-sm" aria-label={t('common:actions.delete')} onClick={onDelete}>
              <Trash2 aria-hidden />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <ul className="flex flex-col gap-1.5">
          {ration.lines.map((line) => (
            <li key={line.id} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 break-words">
                {line.itemName}
                {line.dryMatterPct != null && <span className="text-muted-foreground"> · {t('rations.dryMatterPct', { pct: formatNumber(line.dryMatterPct, 0) })}</span>}
              </span>
              <span className="shrink-0 font-medium tabular-nums">{t('rations.amount', { kg: formatNumber(line.kgPerHeadDay, 3) })}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-auto flex flex-col gap-1 border-t border-border pt-3 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t('rations.totalLabel')}</dt>
            <dd className="font-medium tabular-nums">{t('rations.amount', { kg: formatNumber(ration.totalKgPerHeadDay, 3) })}</dd>
          </div>
          {/* Silage and hay do not add up as fed; dry matter is the figure norms are written in. */}
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t('rations.dryMatter')}</dt>
            <dd className="font-medium tabular-nums">
              {ration.totalDryMatterKg === null || ration.totalDryMatterKg === undefined ? '—' : t('rations.amount', { kg: formatNumber(ration.totalDryMatterKg, 2) })}
            </dd>
          </div>
          {canSeeMoney && (
            <>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('rations.costPerDay')}</dt>
                <dd className="font-medium tabular-nums">{formatMoney(ration.costPerHeadDay)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('rations.costPerSeason', { days: ration.seasonDays })}</dt>
                <dd className="font-medium tabular-nums">{formatMoney(ration.costPerSeason)}</dd>
              </div>
            </>
          )}
        </dl>
        <RationNutrientsSection rationId={ration.id} />
      </CardContent>
    </Card>
  );
}

export default function RationsPage() {
  const { t } = useTranslation('feed');
  const canCreate = usePermission('feed.create');
  const canUpdate = usePermission('feed.update');
  const canDelete = usePermission('feed.delete');
  const canSeeMoney = useSeesCost('feed.approve');
  const confirm = useConfirm();
  const rations = useList<Ration>('/feed/rations', { pageSize: 100 });
  const [dialog, setDialog] = useState<{ ration: Ration | null } | null>(null);

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`/feed/rations/${id}`),
    invalidate: ['/feed'],
    successMessage: 'common:toast.deleted',
  });

  const addButton = canCreate && (
    <Button onClick={() => setDialog({ ration: null })}>
      <Plus aria-hidden />
      {t('rations.add')}
    </Button>
  );
  // The mix is worked out from feed prices, so only people who see feed cost get the way in.
  const mixButton = canSeeMoney && (
    <Button variant="outline" asChild>
      <Link to="/feed/least-cost">
        <Calculator aria-hidden />
        {t('mix.open')}
      </Link>
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t('rations.title')}
        description={t('rations.description')}
        actions={
          (mixButton || addButton) && (
            <>
              {mixButton}
              {addButton}
            </>
          )
        }
      />

      {rations.isLoading && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      )}
      {rations.error && <ErrorCard error={rations.error} onRetry={() => void rations.refetch()} />}
      {rations.data?.data.length === 0 && <EmptyState icon={Wheat} title={t('rations.emptyTitle')} description={t('rations.emptyBody')} action={addButton} />}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rations.data?.data.map((ration) => (
          <RationCard
            key={ration.id}
            ration={ration}
            canEdit={canUpdate}
            canDelete={canDelete}
            canSeeMoney={canSeeMoney}
            onEdit={() => setDialog({ ration })}
            onDelete={async () => {
              const ok = await confirm({ title: t('rations.deleteTitle'), description: t('rations.deleteBody', { name: ration.name }), destructive: true });
              if (ok) remove.mutate(ration.id);
            }}
          />
        ))}
      </div>

      <RationDialog open={dialog !== null} ration={dialog?.ration ?? null} onOpenChange={(open) => !open && setDialog(null)} />
    </>
  );
}
