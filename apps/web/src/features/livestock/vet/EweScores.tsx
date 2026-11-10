import { Trophy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { type Column, DataTable, useUrlParam } from '@/components';
import { Select } from '@/components/ui';
import { formatNumber, formatPercent, formatQty } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { ConditionBadge, CullBadge, classLabel } from './appraisal-parts';
import { EWES_PATH, GRADINGS_PATH } from './options';
import { ScoreBreakdownDialog } from './ScoreBreakdown';
import type { ScoredEwe } from './types';

/** URL prefix of this table: the page it sits on has other lists. */
const PREFIX = 'k';
const DEFAULT_SORT = '-score';
/** What the server sorts by. A ewe with no figure comes last either way. */
const SORTS = ['-score', 'score', 'tag', 'condition', '-age', '-lambings'] as const;
const LINK = 'relative font-medium text-primary after:absolute after:inset-x-0 after:-inset-y-3 hover:underline';

/** The ewe list with each ewe's score: sorted and paged by the server, and a tap on a score takes it apart. */
export function EweScores() {
  const { t } = useTranslation('vet');
  const [urlParams, setUrlParams] = useSearchParams();
  const [gradingClass, setGradingClass] = useUrlParam(`${PREFIX}_class`);
  const [open, setOpen] = useState<ScoredEwe | null>(null);
  const classes = useDetail<{ classes: string[] }>(`${GRADINGS_PATH}/classes`);

  const sort = urlParams.get(`${PREFIX}_sort`) ?? DEFAULT_SORT;
  const setSort = (next: string) =>
    setUrlParams(
      (prev) => {
        const updated = new URLSearchParams(prev);
        if (next === DEFAULT_SORT) updated.delete(`${PREFIX}_sort`);
        else updated.set(`${PREFIX}_sort`, next);
        // Another order: the old page number means other ewes now.
        updated.delete(`${PREFIX}_page`);
        return updated;
      },
      { replace: true },
    );

  const columns: Column<ScoredEwe>[] = [
    {
      key: 'tag',
      header: t('common.ewe'),
      mobile: 'title',
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-2">
          <Link className={LINK} to={`/livestock/animals/${row.eweId}?tab=appraisal`}>
            {row.tag}
          </Link>
          {row.cullMarked && <CullBadge />}
        </span>
      ),
    },
    {
      key: 'score',
      header: t('score.title'),
      align: 'right',
      mobile: 'subtitle',
      cell: (row) =>
        row.score === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(row)}
            aria-label={t('score.open', { tag: row.tag, score: formatNumber(row.score, 1) })}
            className="focus-ring inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-2 font-semibold text-primary tabular-nums underline decoration-dotted underline-offset-4 hover:bg-muted"
          >
            {formatNumber(row.score, 1)}
          </button>
        ),
    },
    { key: 'lambings', header: t('kpis.lambings'), align: 'right', cell: (row) => row.lambings },
    { key: 'lambsBorn', header: t('kpis.lambsBorn'), align: 'right', cell: (row) => row.lambsBorn },
    { key: 'survival', header: t('kpis.survival'), align: 'right', cell: (row) => formatPercent(row.survivalPercent) },
    { key: 'weight', header: t('kpis.weight100'), align: 'right', cell: (row) => formatQty(row.avgWeight100Kg, 'kg') },
    { key: 'condition', header: t('condition.score'), align: 'right', cell: (row) => <ConditionBadge score={row.bodyCondition} /> },
    { key: 'gradingClass', header: t('grading.class'), cell: (row) => (row.gradingClass ? classLabel(row.gradingClass) : '—') },
  ];

  return (
    <>
      <DataTable<ScoredEwe>
        path={`${EWES_PATH}/scores`}
        urlPrefix={PREFIX}
        params={{ gradingClass: gradingClass || undefined }}
        columns={columns}
        rowKey={(row) => row.eweId}
        defaultSort={DEFAULT_SORT}
        searchPlaceholder={t('common.searchTag')}
        filters={
          <>
            <label className="space-y-1 sm:w-52">
              <span className="block text-sm font-medium">{t('score.sortLabel')}</span>
              <Select value={SORTS.includes(sort as (typeof SORTS)[number]) ? sort : DEFAULT_SORT} onChange={(e) => setSort(e.target.value)}>
                {SORTS.map((value) => (
                  <option key={value} value={value}>
                    {t(`score.sort.${value}`)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1 sm:w-48">
              <span className="block text-sm font-medium">{t('grading.class')}</span>
              <Select value={gradingClass} onChange={(e) => setGradingClass(e.target.value)}>
                <option value="">{t('common.all')}</option>
                {(classes.data?.classes ?? []).map((key) => (
                  <option key={key} value={key}>
                    {classLabel(key)}
                  </option>
                ))}
                <option value="none">{t('grading.none')}</option>
              </Select>
            </label>
          </>
        }
        empty={{ icon: Trophy, title: t('kpis.emptyTitle'), description: t('kpis.emptyBody') }}
      />
      <ScoreBreakdownDialog ewe={open} onClose={() => setOpen(null)} />
    </>
  );
}
