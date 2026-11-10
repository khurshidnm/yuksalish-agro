import { todayIso } from '@yap/shared';
import { ClipboardCheck, Search, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTableView, ErrorCard, StatCard, useUrlParam } from '@/components';
import { Alert, Button, DateInput, Input, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber, formatPercent } from '@/lib/format';
import { errorMessage, useApiMutation, useDetail, useList } from '@/lib/query';
import { categoryLabel } from '../category';
import { ConditionBadge, ScoreButtons } from './appraisal-parts';
import { APPRAISAL_STALE, CONDITION_PATH } from './options';
import type { BulkConditionResult, ConditionAnimal, HerdCondition } from './types';

/** Rows drawn at once: a 700-ewe flock is narrowed by tag, not scrolled. */
const PAGE = 50;
const LINK = 'relative font-medium text-primary after:absolute after:inset-x-0 after:-inset-y-3 hover:underline';

interface HerdRow {
  id: string;
  name: string;
}

interface EntryProps {
  herd: HerdRow;
  animals: ConditionAnimal[];
  onClose: () => void;
  onSaved: (result: BulkConditionResult) => void;
}

/** A scoring day: find the animal by tag, tap the score the hand found, go on to the next. */
function ConditionEntry({ herd, animals, onClose, onSaved }: EntryProps) {
  const { t } = useTranslation('vet');
  const searchRef = useRef<HTMLInputElement>(null);
  const [date, setDate] = useState(todayIso());
  const [search, setSearch] = useState('');
  const [scores, setScores] = useState<Record<string, number>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const term = search.trim().toLowerCase();
  const matching = useMemo(() => (term ? animals.filter((animal) => animal.tag.toLowerCase().includes(term)) : animals), [animals, term]);
  const shown = matching.slice(0, PAGE);
  const entered = Object.keys(scores).length;

  const save = useApiMutation<void, BulkConditionResult>({
    mutationFn: () =>
      api.post<BulkConditionResult>(`${CONDITION_PATH}/bulk`, {
        herdId: herd.id,
        date,
        entries: Object.entries(scores).map(([animalId, score]) => ({ animalId, score })),
      }),
    invalidate: APPRAISAL_STALE,
    silentError: true,
    onSuccess: onSaved,
    onError: (error) => setProblem(errorMessage(error)),
  });

  const pick = (animalId: string, score: number) => {
    setProblem(null);
    setScores((current) => {
      const next = { ...current };
      if (next[animalId] === score) delete next[animalId];
      else next[animalId] = score;
      return next;
    });
    // The tag was typed to find this one animal: clear it for the next.
    if (term && matching.length === 1) {
      setSearch('');
      searchRef.current?.focus();
    }
  };

  return (
    <section aria-label={t('condition.dayTitle')} className="space-y-4 rounded-xl border border-border bg-card p-3 sm:p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{t('condition.dayTitle')}</h2>
          <p className="text-sm break-words text-muted-foreground">{herd.name}</p>
        </div>
        <Button variant="ghost" size="icon" aria-label={t('common:actions.close')} onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>

      <label className="block space-y-1 sm:max-w-xs">
        <span className="block text-sm font-medium">{t('common.date')}</span>
        <DateInput value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} />
      </label>

      <Alert tone="info">{t('condition.scaleHint')}</Alert>

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          ref={searchRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={t('common.searchTag')}
          placeholder={t('common.searchTag')}
          className="h-12 pl-11 text-base"
          inputMode="search"
          autoComplete="off"
        />
      </div>

      {matching.length === 0 ? (
        <p className="py-4 text-center text-muted-foreground">{t('condition.noMatch')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((animal) => (
            <li key={animal.animalId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3">
              <div className="min-w-0">
                <p className="text-lg font-semibold break-words tabular-nums">{animal.tag}</p>
                {animal.score !== null && (
                  <p className="text-sm text-muted-foreground">
                    {t('condition.earlier', { score: formatNumber(animal.score, 1), date: animal.scoredOn ? formatDate(animal.scoredOn) : '—' })}
                  </p>
                )}
              </div>
              <ScoreButtons value={scores[animal.animalId] ?? null} onPick={(score) => pick(animal.animalId, score)} label={t('condition.scoreFor', { tag: animal.tag })} />
            </li>
          ))}
        </ul>
      )}
      {matching.length > shown.length && <p className="text-sm text-muted-foreground">{t('scan.narrow', { shown: shown.length, total: matching.length })}</p>}

      {problem && <Alert tone="danger">{problem}</Alert>}

      <div className="sticky bottom-0 -mx-3 -mb-3 flex flex-wrap items-center justify-between gap-2 rounded-b-xl border-t border-border bg-card p-3 sm:-mx-4 sm:-mb-4 sm:p-4">
        <p className="font-medium">{t('scan.entered', { n: entered, total: animals.length })}</p>
        <Button size="lg" disabled={entered === 0} loading={save.isPending} onClick={() => save.mutate()}>
          {t('condition.save')}
        </Button>
      </div>
    </section>
  );
}

/** Body condition of a herd: the scoring day itself, the latest score of every animal, and the herd's average. */
export function ConditionTab() {
  const { t } = useTranslation('vet');
  const canRecord = usePermission('livestock.create');
  const canRecordVet = usePermission('health.update');
  const canEnter = canRecord || canRecordVet;

  // The thin-herd alert links here with the herd in the address.
  const [herdId, setHerdId] = useUrlParam('herd');
  const [entering, setEntering] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [result, setResult] = useState<BulkConditionResult | null>(null);

  const herds = useList<HerdRow>('/livestock/herds', { pageSize: 100 });
  const list = useDetail<HerdCondition>(`${CONDITION_PATH}/herd`, { herdId: herdId || undefined });
  const herd = herds.data?.data.find((row) => row.id === herdId) ?? null;
  const data = list.data;
  const animals = data?.animals ?? [];
  const rows = animals.slice(0, limit);
  const summary = data?.summary;

  const columns: Column<ConditionAnimal>[] = [
    {
      key: 'tag',
      header: t('common.animal'),
      mobile: 'title',
      cell: (row) => (
        <Link className={LINK} to={`/livestock/animals/${row.animalId}?tab=appraisal`}>
          {row.tag}
        </Link>
      ),
    },
    { key: 'score', header: t('condition.score'), mobile: 'subtitle', cell: (row) => <ConditionBadge score={row.score} /> },
    { key: 'scoredOn', header: t('condition.scoredOn'), cell: (row) => (row.scoredOn ? formatDate(row.scoredOn) : '—') },
    { key: 'category', header: t('condition.category'), cell: (row) => categoryLabel(row.category, row.speciesKey) },
    { key: 'herd', header: t('common.herd'), cell: (row) => row.herdName ?? '—' },
  ];

  if (list.error && !data) return <ErrorCard error={list.error} onRetry={() => void list.refetch()} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 space-y-1 sm:max-w-xs">
          <span className="block text-sm font-medium">{t('common.herd')}</span>
          <Select
            value={herdId}
            onChange={(e) => {
              setHerdId(e.target.value);
              setEntering(false);
              setLimit(PAGE);
            }}
          >
            <option value="">{t('scan.allHerds')}</option>
            {(herds.data?.data ?? []).map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </Select>
        </label>
        {canEnter && !entering && (
          <Button
            disabled={!herd}
            onClick={() => {
              setEntering(true);
              setResult(null);
            }}
          >
            <ClipboardCheck aria-hidden />
            {t('condition.start')}
          </Button>
        )}
      </div>
      {canEnter && !entering && !herd && <p className="text-sm text-muted-foreground">{t('condition.chooseHerd')}</p>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('condition.stats.head')} value={formatNumber(summary?.head ?? null)} loading={list.isLoading} />
        <StatCard
          label={t('condition.stats.scored')}
          value={formatNumber(summary?.scored ?? null)}
          hint={summary ? t('condition.stats.scoredHint', { days: summary.recentDays }) : undefined}
          loading={list.isLoading}
        />
        {/* With nobody scored lately there is no average: a dash, not a zero. */}
        <StatCard
          label={t('condition.stats.average')}
          value={formatNumber(summary?.average ?? null, 1)}
          hint={summary ? t('condition.stats.averageHint', { days: summary.recentDays }) : undefined}
          loading={list.isLoading}
        />
        <StatCard
          label={t('condition.stats.thin')}
          value={formatPercent(summary?.thinPercent ?? null)}
          hint={summary ? t('condition.stats.thinHint', { n: summary.thin, score: formatNumber(summary.thinAtOrBelow, 1) }) : undefined}
          tone={summary && summary.thin > 0 ? 'warning' : 'neutral'}
          loading={list.isLoading}
        />
      </div>

      {result && (
        <Alert tone={result.skipped.length > 0 ? 'warning' : 'success'} title={t('condition.doneTitle', { n: result.recorded, date: formatDate(result.date) })}>
          {result.skipped.length > 0 && (
            <ul className="mt-1 list-disc ps-5">
              {result.skipped.map((skip, index) => (
                <li key={`${skip.animalId ?? skip.tag}-${index}`}>
                  {skip.tag ?? '—'}: {t(`scan.skipped.${skip.reason}`, { defaultValue: skip.reason })}
                </li>
              ))}
            </ul>
          )}
        </Alert>
      )}

      {entering && herd ? (
        <ConditionEntry
          herd={herd}
          animals={animals}
          onClose={() => setEntering(false)}
          onSaved={(saved) => {
            setResult(saved);
            setEntering(false);
          }}
        />
      ) : (
        <DataTableView<ConditionAnimal>
          rows={rows}
          columns={columns}
          rowKey={(row) => row.animalId}
          loading={list.isLoading}
          empty={{ icon: ClipboardCheck, title: t('condition.emptyTitle'), description: t('condition.emptyBody') }}
          footer={
            animals.length > rows.length ? (
              <div className="flex flex-wrap items-center justify-between gap-2 p-3">
                <p className="text-sm text-muted-foreground">{t('condition.showing', { shown: rows.length, total: animals.length })}</p>
                <Button variant="outline" onClick={() => setLimit((current) => current + PAGE)}>
                  {t('common:actions.more')}
                </Button>
              </div>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
