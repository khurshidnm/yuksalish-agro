import { MAX_SCAN_FETUSES } from '@yap/shared/formulas/lambing';
import { todayIso } from '@yap/shared';
import { ArrowRightLeft, ScanLine, Search, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTableView, ErrorCard, StatCard, useConfirm, useUrlParam } from '@/components';
import { Alert, Badge, Button, Checkbox, DateInput, Input, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber } from '@/lib/format';
import { errorMessage, useApiMutation, useDetail, useList } from '@/lib/query';
import { cn } from '@/lib/utils';
import { TransferDialog } from '../TransferDialog';
import { DESK_STALE, SCANS_PATH } from './options';
import type { BulkScanResult, ScanEwe, ScanEwes } from './types';

const COUNTS = Array.from({ length: MAX_SCAN_FETUSES + 1 }, (_, n) => n);
/** Rows drawn at once: a 700-ewe flock is narrowed by tag, not scrolled. */
const PAGE = 50;
const LINK = 'relative font-medium text-primary after:absolute after:inset-x-0 after:-inset-y-3 hover:underline';

interface HerdRow {
  id: string;
  name: string;
}

function ScanBadge({ count }: { count: number | null }) {
  const { t } = useTranslation('vet');
  if (count === null) return <Badge variant="neutral">{t('scan.notScanned')}</Badge>;
  return <Badge variant={count >= 2 ? 'info' : 'success'}>{t(`scan.count.${Math.min(count, MAX_SCAN_FETUSES)}`)}</Badge>;
}

interface EntryProps {
  herd: HerdRow;
  ewes: ScanEwe[];
  onClose: () => void;
  onSaved: (result: BulkScanResult) => void;
}

/** A scanning day: find the ewe by tag, tap what the scanner showed, go on to the next. */
function ScanEntry({ herd, ewes, onClose, onSaved }: EntryProps) {
  const { t } = useTranslation('vet');
  const confirm = useConfirm();
  const searchRef = useRef<HTMLInputElement>(null);
  const [date, setDate] = useState(todayIso());
  const [scannedBy, setScannedBy] = useState('');
  const [search, setSearch] = useState('');
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const term = search.trim().toLowerCase();
  const matching = useMemo(() => (term ? ewes.filter((ewe) => ewe.tag.toLowerCase().includes(term)) : ewes), [ewes, term]);
  const shown = matching.slice(0, PAGE);
  const entered = Object.keys(counts).length;
  const empty = Object.values(counts).filter((count) => count === 0).length;

  const save = useApiMutation<void, BulkScanResult>({
    mutationFn: () =>
      api.post<BulkScanResult>(`${SCANS_PATH}/bulk`, {
        herdId: herd.id,
        date,
        scannedBy: scannedBy.trim() || null,
        entries: Object.entries(counts).map(([eweId, fetusCount]) => ({ eweId, fetusCount })),
      }),
    invalidate: DESK_STALE,
    silentError: true,
    onSuccess: onSaved,
    onError: (error) => setProblem(errorMessage(error)),
  });

  const pick = (eweId: string, count: number) => {
    setProblem(null);
    setCounts((current) => {
      const next = { ...current };
      if (next[eweId] === count) delete next[eweId];
      else next[eweId] = count;
      return next;
    });
    // The tag was typed to find this one ewe: clear it for the next.
    if (term && matching.length === 1) {
      setSearch('');
      searchRef.current?.focus();
    }
  };

  const submit = async () => {
    if (empty > 0) {
      const ok = await confirm({ title: t('scan.emptyConfirmTitle', { n: empty }), description: t('scan.emptyConfirmBody'), confirmLabel: t('common:actions.save') });
      if (!ok) return;
    }
    save.mutate();
  };

  return (
    <section aria-label={t('scan.dayTitle')} className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{t('scan.dayTitle')}</h2>
          <p className="text-sm break-words text-muted-foreground">{herd.name}</p>
        </div>
        <Button variant="ghost" size="icon" aria-label={t('common:actions.close')} onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="block text-sm font-medium">{t('scan.date')}</span>
          <DateInput value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="block text-sm font-medium">{t('scan.scannedBy')}</span>
          <Input value={scannedBy} maxLength={120} onChange={(e) => setScannedBy(e.target.value)} autoComplete="off" />
        </label>
      </div>

      <Alert tone="info">{t('scan.zeroHint')}</Alert>

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
        <p className="py-4 text-center text-muted-foreground">{t('scan.noMatch')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((ewe) => (
            <li key={ewe.eweId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2">
              <div className="min-w-0">
                <p className="text-lg font-semibold break-words tabular-nums">{ewe.tag}</p>
                {ewe.fetusCount !== null && (
                  <p className="text-sm text-muted-foreground">{t('scan.earlier', { n: ewe.fetusCount, date: ewe.scanDate ? formatDate(ewe.scanDate) : '—' })}</p>
                )}
              </div>
              <div className="flex gap-2" role="group" aria-label={t('scan.countFor', { tag: ewe.tag })}>
                {COUNTS.map((count) => {
                  const on = counts[ewe.eweId] === count;
                  return (
                    <button
                      key={count}
                      type="button"
                      aria-pressed={on}
                      onClick={() => pick(ewe.eweId, count)}
                      className={cn(
                        'focus-ring flex size-12 items-center justify-center rounded-lg border-2 text-lg font-bold tabular-nums transition-colors',
                        on ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-foreground hover:border-input',
                      )}
                    >
                      {count}
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      )}
      {matching.length > shown.length && <p className="text-sm text-muted-foreground">{t('scan.narrow', { shown: shown.length, total: matching.length })}</p>}

      {problem && <Alert tone="danger">{problem}</Alert>}

      <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-wrap items-center justify-between gap-2 rounded-b-xl border-t border-border bg-card p-4">
        <p className="font-medium">{t('scan.entered', { n: entered, total: ewes.length })}</p>
        <Button size="lg" disabled={entered === 0} loading={save.isPending} onClick={() => void submit()}>
          {t('scan.save')}
        </Button>
      </div>
    </section>
  );
}

/** What the scanner found, ewe by ewe: the scanning day itself, and the list twin bearers are moved from. */
export function ScanTab() {
  const { t } = useTranslation('vet');
  const canRecord = usePermission('livestock.create');
  const canRecordVet = usePermission('health.update');
  const canMove = usePermission('livestock.update');
  const canEnter = canRecord || canRecordVet;

  const [herdId, setHerdId] = useUrlParam('sHerd');
  const [filter, setFilter] = useUrlParam('sCount');
  const [entering, setEntering] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState(false);
  const [result, setResult] = useState<BulkScanResult | null>(null);

  const herds = useList<HerdRow>('/livestock/herds', { pageSize: 100 });
  // The entry list is the whole herd, whatever the filter says.
  const list = useDetail<ScanEwes>(`${SCANS_PATH}/ewes`, { herdId: herdId || undefined, fetusCount: entering ? undefined : filter || undefined });
  const herd = herds.data?.data.find((row) => row.id === herdId) ?? null;
  const data = list.data;
  const ewes = data?.ewes ?? [];
  const rows = ewes.slice(0, limit);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const reset = () => {
    setSelected(new Set());
    setLimit(PAGE);
  };

  const columns: Column<ScanEwe>[] = [
    ...(canMove
      ? [
          {
            key: 'select',
            header: <span className="sr-only">{t('livestock:animals.select')}</span>,
            mobile: 'hidden' as const,
            className: 'w-10',
            cell: (row: ScanEwe) => (
              <Checkbox aria-label={t('livestock:animals.selectOne', { tag: row.tag })} checked={selected.has(row.eweId)} onCheckedChange={() => toggle(row.eweId)} />
            ),
          },
        ]
      : []),
    {
      key: 'tag',
      header: t('common.ewe'),
      mobile: 'title',
      cell: (row) => (
        <Link className={LINK} to={`/livestock/animals/${row.eweId}`}>
          {row.tag}
        </Link>
      ),
    },
    { key: 'scan', header: t('scan.result'), mobile: 'subtitle', cell: (row) => <ScanBadge count={row.fetusCount} /> },
    { key: 'scanDate', header: t('scan.scannedOn'), cell: (row) => (row.scanDate ? formatDate(row.scanDate) : '—') },
    { key: 'expected', header: t('scan.due'), cell: (row) => formatDate(row.expectedDate) },
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
              reset();
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
        {!entering && (
          <label className="min-w-0 flex-1 space-y-1 sm:max-w-xs">
            <span className="block text-sm font-medium">{t('scan.result')}</span>
            <Select
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                reset();
              }}
            >
              <option value="">{t('common.all')}</option>
              <option value="none">{t('scan.notScanned')}</option>
              {COUNTS.filter((count) => count > 0).map((count) => (
                <option key={count} value={String(count)}>
                  {t(`scan.count.${count}`)}
                </option>
              ))}
            </Select>
          </label>
        )}
        {canEnter && !entering && (
          <Button
            disabled={!herd}
            onClick={() => {
              setEntering(true);
              setResult(null);
              reset();
            }}
          >
            <ScanLine aria-hidden />
            {t('scan.start')}
          </Button>
        )}
      </div>
      {canEnter && !entering && !herd && <p className="text-sm text-muted-foreground">{t('scan.chooseHerd')}</p>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label={t('scan.stats.total')} value={formatNumber(data?.summary.total ?? null)} loading={list.isLoading} />
        <StatCard
          label={t('scan.notScanned')}
          value={formatNumber(data?.summary.notScanned ?? null)}
          tone={data && data.summary.notScanned > 0 ? 'warning' : 'neutral'}
          loading={list.isLoading}
        />
        <StatCard label={t('scan.count.1')} value={formatNumber(data?.summary.single ?? null)} loading={list.isLoading} />
        <StatCard
          label={t('scan.stats.multiples')}
          value={formatNumber(data ? data.summary.twin + data.summary.triplet : null)}
          hint={data ? t('scan.stats.multiplesHint', { twin: data.summary.twin, triplet: data.summary.triplet }) : undefined}
          tone="info"
          loading={list.isLoading}
        />
        {/* Counted from scans only: with nobody scanned there is no figure, not a zero. */}
        <StatCard
          label={t('scan.stats.fetuses')}
          value={formatNumber(data && data.summary.total > data.summary.notScanned ? data.summary.fetuses : null)}
          hint={t('scan.stats.fetusesHint')}
          loading={list.isLoading}
        />
      </div>

      {result && (
        <Alert tone={result.skipped.length > 0 ? 'warning' : 'success'} title={t('scan.doneTitle', { n: result.recorded, date: formatDate(result.date) })}>
          {result.closed > 0 && <p>{t('scan.doneClosed', { n: result.closed })}</p>}
          {result.skipped.length > 0 && (
            <ul className="mt-1 list-disc ps-5">
              {result.skipped.map((skip, index) => (
                <li key={`${skip.eweId ?? skip.tag}-${index}`}>
                  {skip.tag ?? '—'}: {t(`scan.skipped.${skip.reason}`, { defaultValue: skip.reason })}
                </li>
              ))}
            </ul>
          )}
        </Alert>
      )}

      {entering && herd ? (
        <ScanEntry
          herd={herd}
          ewes={ewes}
          onClose={() => setEntering(false)}
          onSaved={(saved) => {
            setResult(saved);
            setEntering(false);
          }}
        />
      ) : (
        <>
          {canMove && (selected.size > 0 || (ewes.length > 0 && filter !== '')) && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
              <p className="font-medium">{t('livestock:animals.selected', { count: selected.size })}</p>
              <div className="ms-auto flex flex-wrap gap-2">
                {selected.size < ewes.length && (
                  <Button variant="outline" onClick={() => setSelected(new Set(ewes.map((ewe) => ewe.eweId)))}>
                    {t('scan.selectAll', { n: ewes.length })}
                  </Button>
                )}
                {selected.size > 0 && (
                  <>
                    <Button variant="outline" onClick={() => setSelected(new Set())}>
                      <X aria-hidden />
                      {t('common:actions.clear')}
                    </Button>
                    <Button onClick={() => setMoving(true)}>
                      <ArrowRightLeft aria-hidden />
                      {t('scan.move')}
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
          <DataTableView<ScanEwe>
            rows={rows}
            columns={columns}
            rowKey={(row) => row.breedingId}
            loading={list.isLoading}
            isRowSelected={(row) => selected.has(row.eweId)}
            onRowClick={canMove ? (row) => toggle(row.eweId) : undefined}
            empty={{ icon: ScanLine, title: t('scan.emptyTitle'), description: t(filter ? 'scan.emptyFiltered' : 'scan.emptyBody') }}
            footer={
              ewes.length > rows.length ? (
                <div className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <p className="text-sm text-muted-foreground">{t('scan.narrow', { shown: rows.length, total: ewes.length })}</p>
                  <Button variant="outline" onClick={() => setLimit((current) => current + PAGE)}>
                    {t('common:actions.more')}
                  </Button>
                </div>
              ) : undefined
            }
          />
        </>
      )}

      <TransferDialog
        open={moving}
        onOpenChange={setMoving}
        animalIds={[...selected]}
        count={selected.size}
        currentHerdId={herdId || undefined}
        onDone={() => {
          setSelected(new Set());
          void list.refetch();
        }}
      />
    </div>
  );
}
