import { ANIMAL_CATEGORIES, ANIMAL_STATUSES, todayIso } from '@yap/shared';
import { ArrowRightLeft, Baby, MapPin, PawPrint, Plus, ShieldAlert, Thermometer, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTable, MoneyText, PageHeader, StatCard, useUrlParam } from '@/components';
import { Button, Checkbox, Select } from '@/components/ui';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber, formatQty } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { useDetail, useList } from '@/lib/query';
import { AnimalForm } from './AnimalForm';
import { type Animal, type HerdRow, type HerdSummary, StatusBadge, useAgeText, useLocalName } from './shared';
import { TransferDialog } from './TransferDialog';

const PATH = '/livestock/animals';

export default function AnimalsPage() {
  const { t } = useTranslation('livestock');
  const canManage = usePermission('livestock.update');
  const canSeeMoney = usePermission('finance.view');
  const localName = useLocalName();
  const ageText = useAgeText();
  const today = todayIso();

  const [scope, setScope] = useUrlParam('scope', 'on_farm');
  const [herdId, setHerdId] = useUrlParam('herd');
  const [status, setStatus] = useUrlParam('status');
  const [category, setCategory] = useUrlParam('category');
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState(false);
  // Selection survives paging, so animals can be picked across several pages of a 500-head flock.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data: summary, isLoading } = useDetail<HerdSummary>('/livestock/summary');
  const { data: herds } = useList<HerdRow>('/livestock/herds', { pageSize: 100 });

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const columns: Column<Animal>[] = [
    ...(canManage && scope === 'on_farm'
      ? [
          {
            key: 'select',
            header: <span className="sr-only">{t('animals.select')}</span>,
            mobile: 'hidden' as const,
            className: 'w-10',
            cell: (row: Animal) => (
              <Checkbox
                aria-label={t('animals.selectOne', { tag: row.tag })}
                checked={selected.has(row.id)}
                onCheckedChange={() => toggle(row.id)}
              />
            ),
          },
        ]
      : []),
    { key: 'tag', header: t('fields.tag'), cell: (row) => <span className="font-semibold whitespace-nowrap tabular-nums">{row.tag}</span>, sortable: true, mobile: 'title' },
    { key: 'status', header: t('fields.status'), cell: (row) => <StatusBadge status={row.status} />, sortable: true, mobile: 'subtitle' },
    { key: 'category', header: t('fields.category'), cell: (row) => t(`enums:animalCategory.${row.category}`), sortable: true },
    { key: 'breed', header: t('fields.breed'), cell: (row) => localName(row.breedName), mobile: 'hidden' },
    { key: 'herd', header: t('fields.herd'), cell: (row) => row.herdName ?? '—' },
    { key: 'birthDate', header: t('fields.age'), cell: (row) => ageText(row.birthDate, row.exitDate ?? today), sortable: true, mobile: 'hidden' },
    { key: 'currentWeightKg', header: t('fields.weight'), cell: (row) => <span className="whitespace-nowrap">{formatQty(row.currentWeightKg, 'kg', 1)}</span>, sortable: true, align: 'right' },
    { key: 'lastWeighedOn', header: t('fields.lastWeighed'), cell: (row) => formatDate(row.lastWeighedOn), sortable: true, mobile: 'hidden' },
    ...(canSeeMoney
      ? [{ key: 'price', header: t('fields.purchasePrice'), cell: (row: Animal) => <MoneyText value={row.purchasePrice} />, align: 'right' as const, mobile: 'hidden' as const }]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={t('animals.title')}
        description={t('animals.description')}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/livestock/tracking">
                <MapPin aria-hidden />
                {t('tracking:map')}
              </Link>
            </Button>
            {canManage && (
              <Button onClick={() => setAdding(true)}>
                <Plus aria-hidden />
                {t('animals.add')}
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('animals.stats.total')} value={formatNumber(summary?.total)} icon={PawPrint} loading={isLoading} />
        {/* The tile counts open pregnancies, sick and quarantined ewes too; the status filter and the herd card count by status. */}
        <StatCard
          label={t('animals.stats.pregnant')}
          value={formatNumber(summary?.pregnant)}
          hint={summary && (summary.sick > 0 || summary.quarantine > 0) ? t('animals.stats.pregnantHint') : undefined}
          icon={Baby}
          tone="info"
          loading={isLoading}
        />
        <StatCard label={t('animals.stats.sick')} value={formatNumber(summary?.sick)} icon={Thermometer} tone={summary?.sick ? 'danger' : 'neutral'} loading={isLoading} />
        <StatCard label={t('animals.stats.quarantine')} value={formatNumber(summary?.quarantine)} icon={ShieldAlert} tone={summary?.quarantine ? 'warning' : 'neutral'} loading={isLoading} />
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
          <p className="font-medium">{t('animals.selected', { count: selected.size })}</p>
          <div className="ms-auto flex gap-2">
            <Button variant="outline" onClick={() => setSelected(new Set())}>
              <X aria-hidden />
              {t('common:actions.clear')}
            </Button>
            <Button onClick={() => setMoving(true)}>
              <ArrowRightLeft aria-hidden />
              {t('transfer.title')}
            </Button>
          </div>
        </div>
      )}

      <DataTable<Animal>
        path={PATH}
        params={{ scope, herdId: herdId || undefined, status: status || undefined, category: category || undefined }}
        columns={columns}
        defaultSort="tag"
        searchPlaceholder={t('animals.searchPlaceholder')}
        rowHref={(row) => `/livestock/animals/${row.id}`}
        filters={
          // Two columns on a phone, so the list starts on the first screen.
          <div className="grid grid-cols-2 gap-2 md:contents">
            <Select
              aria-label={t('animals.scope')}
              value={scope}
              onChange={(e) => {
                setScope(e.target.value);
                setStatus('');
                setSelected(new Set());
              }}
              options={[
                { value: 'on_farm', label: t('animals.scopes.onFarm') },
                { value: 'archived', label: t('animals.scopes.archived') },
              ]}
              className="md:w-44"
            />
            <Select
              aria-label={t('fields.herd')}
              value={herdId}
              onChange={(e) => setHerdId(e.target.value)}
              options={(herds?.data ?? []).map((h) => ({ value: h.id, label: h.name }))}
              placeholder={t('animals.allHerds')}
              className="md:w-52"
            />
            <Select
              aria-label={t('fields.status')}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              options={enumOptions('animalStatus', ANIMAL_STATUSES.filter((s) => (['sold', 'slaughtered', 'dead', 'lost'].includes(s) ? scope === 'archived' : scope === 'on_farm')))}
              placeholder={t('animals.allStatuses')}
              className="md:w-44"
            />
            <Select
              aria-label={t('fields.category')}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              options={enumOptions('animalCategory', ANIMAL_CATEGORIES)}
              placeholder={t('animals.allCategories')}
              className="md:w-44"
            />
          </div>
        }
        empty={
          // A filter that finds nothing is not an empty farm: no "add your first animal" there.
          scope === 'archived'
            ? { icon: PawPrint, title: t('animals.emptyArchivedTitle') }
            : herdId || status || category
              ? { icon: PawPrint, title: t('animals.emptyFilteredTitle'), description: t('animals.emptyFilteredBody') }
              : {
                  icon: PawPrint,
                  title: t('animals.emptyTitle'),
                  description: t('animals.emptyBody'),
                  action: canManage && (
                    <Button onClick={() => setAdding(true)}>
                      <Plus aria-hidden />
                      {t('animals.add')}
                    </Button>
                  ),
                }
        }
      />

      <AnimalForm open={adding} onOpenChange={setAdding} herdId={herdId || undefined} />
      <TransferDialog
        open={moving}
        onOpenChange={setMoving}
        animalIds={[...selected]}
        count={selected.size}
        onDone={() => setSelected(new Set())}
      />
    </>
  );
}
