import { CULL_REASONS, todayIso } from '@yap/shared';
import { Flag, FlagOff, ListChecks } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { z } from 'zod';
import { type Column, DataTableView, DateField, ErrorCard, FormDialog, SelectField, StatCard, TextareaField, useConfirm, useUrlParam } from '@/components';
import { Alert, Badge, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber, formatPercent } from '@/lib/format';
import { zDate, zEnum, zOptionalText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail, useList } from '@/lib/query';
import { ConditionBadge } from './appraisal-parts';
import { APPRAISAL_STALE, CULLING_PATH } from './options';
import type { CullSuggestion, CullingList, MarkedAnimal } from './types';

const LINK = 'relative font-medium text-primary after:absolute after:inset-x-0 after:-inset-y-3 hover:underline';
const markSchema = z.object({ reason: zEnum(CULL_REASONS), date: zDate(), note: zOptionalText(500) });

interface HerdRow {
  id: string;
  name: string;
}

interface MarkProps {
  /** The animal to mark, or null when the dialog is closed. */
  animal: { animalId: string; tag: string; reasons: string[] } | null;
  onClose: () => void;
}

/** A person's own decision that an animal is to leave the flock, with the reason in their words. */
export function CullMarkDialog({ animal, onClose }: MarkProps) {
  const { t } = useTranslation('vet');
  const mark = useApiMutation<z.output<typeof markSchema>>({
    mutationFn: (values) => api.post(`${CULLING_PATH}/marks`, { ...values, animalId: animal?.animalId }),
    invalidate: APPRAISAL_STALE,
    silentError: true,
  });
  const suggested = animal?.reasons[0];

  return (
    <FormDialog
      open={animal !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t('culling.markTitle', { tag: animal?.tag ?? '' })}
      description={t('culling.markHint')}
      schema={markSchema}
      defaultValues={{ reason: (suggested as (typeof CULL_REASONS)[number] | undefined) ?? 'other', date: todayIso(), note: '' }}
      onSubmit={(values) => mark.mutateAsync(values)}
      submitLabel={t('culling.mark')}
      successMessage="common:toast.saved"
    >
      {(form) => (
        <>
          <SelectField form={form} name="reason" label={t('culling.reason')} required options={enumOptions('cullReason', CULL_REASONS)} />
          <DateField form={form} name="date" label={t('common.date')} required max={todayIso()} />
          <TextareaField form={form} name="note" label={t('common.notes')} rows={2} />
        </>
      )}
    </FormDialog>
  );
}

/** Clears a mark after asking: the mark stays in the animal's history, closed. */
export function useClearCullMark() {
  const { t } = useTranslation('vet');
  const confirm = useConfirm();
  const clear = useApiMutation<string>({
    mutationFn: (id) => api.post(`${CULLING_PATH}/marks/${id}/clear`, {}),
    invalidate: APPRAISAL_STALE,
    successMessage: 'vet:culling.cleared',
  });
  return async (mark: { id: string; tag: string }) => {
    const ok = await confirm({ title: t('culling.clearTitle', { tag: mark.tag }), description: t('culling.clearBody'), confirmLabel: t('culling.clear') });
    if (ok) clear.mutate(mark.id);
  };
}

/** Why the records put a ewe on the list, each reason as a sentence with the line it crossed. */
function Reasons({ reasons, thresholds }: { reasons: string[]; thresholds: CullingList['thresholds'] }) {
  const { t } = useTranslation('vet');
  const values = {
    years: thresholds.oldAgeYears,
    seasons: thresholds.emptySeasons,
    lambings: thresholds.lambingsWithoutRearing,
    share: formatPercent(thresholds.lowScoreShare * 100, 0),
    scorings: thresholds.thinScorings,
    score: formatNumber(thresholds.thinAtOrBelow, 1),
    complications: thresholds.complicatedLambings,
  };
  return (
    <ul className="space-y-0.5 text-sm break-words whitespace-normal">
      {reasons.map((reason) => (
        <li key={reason}>{t(`culling.why.${reason}`, { ...values, defaultValue: t(`enums:cullReason.${reason}`) })}</li>
      ))}
    </ul>
  );
}

/** The culling list: what the records suggest, and beside it what a person has decided. */
export function CullingTab() {
  const { t } = useTranslation('vet');
  const canChange = usePermission('livestock.update');
  const canChangeVet = usePermission('health.update');
  const canDecide = canChange || canChangeVet;
  const [herdId, setHerdId] = useUrlParam('cHerd');
  const [marking, setMarking] = useState<CullSuggestion | null>(null);
  const clearMark = useClearCullMark();

  const herds = useList<HerdRow>('/livestock/herds', { pageSize: 100 });
  const list = useDetail<CullingList>(CULLING_PATH, { herdId: herdId || undefined });
  const data = list.data;

  if (list.error && !data) return <ErrorCard error={list.error} onRetry={() => void list.refetch()} />;

  const tagCell = (row: { animalId: string; tag: string }) => (
    <Link className={LINK} to={`/livestock/animals/${row.animalId}?tab=appraisal`}>
      {row.tag}
    </Link>
  );

  const suggestedColumns: Column<CullSuggestion>[] = [
    { key: 'tag', header: t('common.ewe'), mobile: 'title', cell: tagCell },
    {
      key: 'reasons',
      header: t('culling.whyTitle'),
      mobile: 'subtitle',
      cell: (row) => (data ? <Reasons reasons={row.reasons} thresholds={data.thresholds} /> : null),
    },
    { key: 'age', header: t('culling.age'), align: 'right', cell: (row) => formatNumber(row.ageYears, 1) },
    { key: 'lambings', header: t('kpis.lambings'), align: 'right', cell: (row) => row.lambings },
    { key: 'score', header: t('score.title'), align: 'right', cell: (row) => formatNumber(row.score, 1) },
    { key: 'condition', header: t('condition.score'), align: 'right', cell: (row) => <ConditionBadge score={row.bodyCondition} /> },
    { key: 'herd', header: t('common.herd'), cell: (row) => row.herdName ?? '—' },
  ];

  const markedColumns: Column<MarkedAnimal>[] = [
    { key: 'tag', header: t('common.animal'), mobile: 'title', cell: tagCell },
    { key: 'reason', header: t('culling.reason'), mobile: 'subtitle', cell: (row) => <Badge variant="warning">{t(`enums:cullReason.${row.reason}`)}</Badge> },
    { key: 'note', header: t('common.notes'), cell: (row) => <span className="break-words whitespace-normal">{row.note ?? '—'}</span> },
    { key: 'markedOn', header: t('culling.markedOn'), cell: (row) => formatDate(row.markedOn) },
    {
      key: 'records',
      header: t('culling.recordsSay'),
      cell: (row) => (row.suggestedReasons.length > 0 && data ? <Reasons reasons={row.suggestedReasons} thresholds={data.thresholds} /> : '—'),
    },
    { key: 'score', header: t('score.title'), align: 'right', cell: (row) => formatNumber(row.score, 1) },
    { key: 'herd', header: t('common.herd'), cell: (row) => row.herdName ?? '—' },
  ];

  return (
    <div className="space-y-4">
      <Alert tone="info">{t('culling.explain')}</Alert>

      <label className="block space-y-1 sm:max-w-xs">
        <span className="block text-sm font-medium">{t('common.herd')}</span>
        <Select value={herdId} onChange={(e) => setHerdId(e.target.value)}>
          <option value="">{t('scan.allHerds')}</option>
          {(herds.data?.data ?? []).map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </Select>
      </label>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('culling.stats.suggested')} value={formatNumber(data?.suggested.length ?? null)} tone={data && data.suggested.length > 0 ? 'warning' : 'neutral'} loading={list.isLoading} />
        <StatCard label={t('culling.stats.marked')} value={formatNumber(data?.marked.length ?? null)} loading={list.isLoading} />
        <StatCard
          label={t('culling.stats.ewes')}
          value={formatNumber(data?.flock.ewes ?? null)}
          hint={data ? t('culling.stats.scoredHint', { n: data.flock.scored }) : undefined}
          loading={list.isLoading}
        />
        {/* Under the smallest flock the lowest share means nothing: no line, and a dash. */}
        <StatCard
          label={t('culling.stats.cutoff')}
          value={formatNumber(data?.flock.lowScoreCutoff ?? null, 1)}
          hint={data ? t('culling.stats.cutoffHint', { share: formatPercent(data.thresholds.lowScoreShare * 100, 0), n: data.thresholds.lowScoreMinFlock }) : undefined}
          loading={list.isLoading}
        />
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t('culling.markedTitle')}</h2>
        <DataTableView<MarkedAnimal>
          rows={data?.marked ?? []}
          columns={markedColumns}
          loading={list.isLoading}
          rowActions={canDecide ? (row) => [{ label: t('culling.clear'), icon: FlagOff, onClick: () => void clearMark(row) }] : undefined}
          empty={{ icon: Flag, title: t('culling.markedEmptyTitle'), description: t('culling.markedEmptyBody') }}
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t('culling.suggestedTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('culling.suggestedHint')}</p>
        <DataTableView<CullSuggestion>
          rows={data?.suggested ?? []}
          columns={suggestedColumns}
          rowKey={(row) => row.animalId}
          loading={list.isLoading}
          rowActions={canDecide ? (row) => [{ label: t('culling.mark'), icon: Flag, onClick: () => setMarking(row) }] : undefined}
          empty={{ icon: ListChecks, title: t('culling.suggestedEmptyTitle'), description: t('culling.suggestedEmptyBody') }}
        />
      </section>

      <CullMarkDialog animal={marking} onClose={() => setMarking(null)} />
    </div>
  );
}
