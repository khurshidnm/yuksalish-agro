import { HERD_CONDITIONS, todayIso } from '@yap/shared';
import { CheckCircle2, ChevronRight, CircleDashed, ClipboardList, Droplets, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTable, EmptyState, ErrorCard, MoneyText, PageHeader, UrlTabs, useConfirm, useUrlParam } from '@/components';
import { Badge, Button, Card, DateInput, Select, Separator, Sheet, SheetContent, SheetDescription, SheetTitle, Skeleton, TBody, THead, Table, Td, Th, Tr } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission, useSession } from '@/lib/auth';
import { formatDate, formatDateLong, formatNumber, formatQty } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail, useList } from '@/lib/query';
import { cn } from '@/lib/utils';
import { DailyLogSheet, type LogDetail } from './DailyLogSheet';
import type { HerdRow } from './shared';

const PATH = '/livestock/daily-logs';

interface DayHerd {
  id: string;
  name: string;
  state: string;
  logId: string | null;
  condition: string | null;
  headCount: number;
  logged: boolean;
}

interface LogRow {
  id: string;
  herdId: string;
  herdName: string;
  date: string;
  headCount: number;
  waterL: number | null;
  condition: string;
  plannedKg: number | null;
  actualKg: number | null;
  deviationPercent: number | null;
  totalCost: number | null;
}

function DeviationBadge({ value, threshold }: { value: number | null; threshold: number }) {
  if (value === null) return <>—</>;
  const strayed = Math.abs(value) > threshold;
  return (
    <Badge variant={strayed ? 'warning' : 'neutral'}>
      {value > 0 ? '+' : ''}
      {formatNumber(value, 1)}%
    </Badge>
  );
}

interface Editing {
  herdId: string;
  herdName: string;
  date: string;
  logId?: string | null;
}

function useThreshold(): number {
  const session = useSession();
  return (session.settings as { feed?: { deviationPercent?: number } }).feed?.deviationPercent ?? 15;
}

function LogDetailSheet({ logId, onClose, onEdit }: { logId: string | null; onClose: () => void; onEdit: (e: Editing) => void }) {
  const { t } = useTranslation('livestock');
  const session = useSession();
  const canUpdate = usePermission('livestock.update');
  const canCreate = usePermission('livestock.create');
  const canDelete = usePermission('livestock.delete');
  const canSeeMoney = usePermission('finance.view');
  const confirm = useConfirm();
  const { data: log, error, isLoading, refetch } = useDetail<LogDetail>(logId ? `${PATH}/${logId}` : null);

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: [PATH, '/livestock/herds', '/inventory', '/feed'],
    successMessage: 'common:toast.deleted',
    onSuccess: onClose,
  });

  // Same rule as the server: a shepherd corrects only their own record, on the day.
  const canEdit = log && (canUpdate || (canCreate && log.createdBy === session.user.id && log.date === todayIso()));

  return (
    <Sheet open={logId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full max-w-lg overflow-y-auto">
        <div className="space-y-4 p-4">
          <div className="pe-10">
            <SheetTitle className="text-xl font-semibold">{log?.herdName ?? t('dailyLogs.title')}</SheetTitle>
            <SheetDescription className="text-muted-foreground">{log ? formatDateLong(log.date) : ''}</SheetDescription>
          </div>
          {error ? (
            <ErrorCard error={error} onRetry={() => void refetch()} />
          ) : isLoading || !log ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="text-sm text-muted-foreground">{t('fields.headCount')}</dt>
                  <dd className="font-semibold">{formatNumber(log.headCount)}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">{t('dailyLogs.water')}</dt>
                  <dd className="font-semibold">{formatQty(log.waterL, 'l', 0)}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">{t('dailyLogs.condition')}</dt>
                  <dd>
                    <Badge variant={log.condition === 'normal' ? 'success' : 'warning'}>{t(`enums:herdCondition.${log.condition}`)}</Badge>
                  </dd>
                </div>
              </dl>
              {log.notes && <p className="rounded-lg bg-muted p-3 text-sm">{log.notes}</p>}
              <Separator />
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <Tr>
                      <Th>{t('dailyLogs.feed')}</Th>
                      <Th className="text-right">{t('dailyLogs.planned')}</Th>
                      <Th className="text-right">{t('dailyLogs.given')}</Th>
                      {canSeeMoney && <Th className="text-right">{t('dailyLogs.cost')}</Th>}
                    </Tr>
                  </THead>
                  <TBody>
                    {log.lines.map((line) => (
                      <Tr key={line.itemId}>
                        <Td>{line.itemName}</Td>
                        <Td className="text-right whitespace-nowrap tabular-nums">{formatQty(line.plannedQty, line.unit)}</Td>
                        <Td className="text-right whitespace-nowrap tabular-nums">{formatQty(line.actualQty, line.unit)}</Td>
                        {canSeeMoney && (
                          <Td className="text-right">
                            <MoneyText value={line.totalCost} />
                          </Td>
                        )}
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </div>
              {log.photos.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {log.photos.map((photo) => (
                    <a key={photo.id} href={photo.url} target="_blank" rel="noreferrer">
                      <img src={photo.url} alt={t('photo.alt')} className="size-24 rounded-lg border border-border object-cover" />
                    </a>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {canEdit && (
                  <Button
                    onClick={() => {
                      onEdit({ herdId: log.herdId, herdName: log.herdName ?? '', date: log.date, logId: log.id });
                      onClose();
                    }}
                  >
                    <Pencil aria-hidden />
                    {t('common:actions.edit')}
                  </Button>
                )}
                {canDelete && (
                  <Button
                    variant="outline"
                    onClick={async () => {
                      const ok = await confirm({ title: t('dailyLogs.deleteTitle'), description: t('dailyLogs.deleteBody'), destructive: true });
                      if (ok) remove.mutate(log.id);
                    }}
                  >
                    <Trash2 aria-hidden />
                    {t('common:actions.delete')}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The shepherd's screen: every herd, what is left to do today, one tap to start. */
function DayTab({ onEdit, onOpenLog }: { onEdit: (e: Editing) => void; onOpenLog: (id: string) => void }) {
  const { t } = useTranslation('livestock');
  const today = todayIso();
  const canCreate = usePermission('livestock.create');
  const [date, setDate] = useUrlParam('date', today);
  const { data, error, isLoading, refetch } = useDetail<{ date: string; herds: DayHerd[] }>(`${PATH}/day`, { date });

  const done = data?.herds.filter((h) => h.logged).length ?? 0;
  const total = data?.herds.length ?? 0;

  return (
    <div className="max-w-2xl space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DateInput aria-label={t('fields.date')} value={date} max={today} onChange={(e) => setDate(e.target.value)} className="w-44" />
        {total > 0 && <p className="text-sm text-muted-foreground">{t('dailyLogs.dayProgress', { done, total })}</p>}
      </div>

      {error ? (
        <ErrorCard error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : total === 0 ? (
        <EmptyState icon={ClipboardList} title={t('dailyLogs.noHerdsTitle')} description={t('dailyLogs.noHerdsBody')} />
      ) : (
        data?.herds.map((herd) => {
          const disabled = !herd.logged && !canCreate;
          return (
            <button
              key={herd.id}
              type="button"
              disabled={disabled}
              className={cn(
                'focus-ring flex min-h-24 w-full items-center gap-3 rounded-xl border bg-card p-4 text-left',
                herd.logged ? 'border-border' : 'border-primary',
                disabled && 'opacity-60',
              )}
              onClick={() => {
                if (herd.logId) onOpenLog(herd.logId);
                else onEdit({ herdId: herd.id, herdName: herd.name, date });
              }}
            >
              {herd.logged ? (
                <CheckCircle2 className="size-9 shrink-0 text-success" aria-hidden />
              ) : (
                <CircleDashed className="size-9 shrink-0 text-primary" aria-hidden />
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-lg font-semibold">{herd.name}</span>
                <span className="block text-sm text-muted-foreground">
                  {t('head', { count: herd.headCount })} · {herd.logged ? t('dailyLogs.recorded') : t('dailyLogs.notRecorded')}
                </span>
              </span>
              <ChevronRight className="size-6 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          );
        })
      )}
    </div>
  );
}

function JournalTab({ onOpenLog }: { onOpenLog: (id: string) => void }) {
  const { t } = useTranslation('livestock');
  const canSeeMoney = usePermission('finance.view');
  const threshold = useThreshold();
  const [herdId, setHerdId] = useUrlParam('herd');
  const [condition, setCondition] = useUrlParam('condition');
  const [from, setFrom] = useUrlParam('from');
  const [to, setTo] = useUrlParam('to');
  const { data: herds } = useList<HerdRow>('/livestock/herds', { pageSize: 100 });

  const columns: Column<LogRow>[] = [
    { key: 'date', header: t('fields.date'), cell: (row) => formatDate(row.date), sortable: true, mobile: 'title' },
    { key: 'herdName', header: t('fields.herd'), cell: (row) => row.herdName, sortable: true, mobile: 'subtitle' },
    { key: 'head', header: t('fields.headCount'), cell: (row) => formatNumber(row.headCount), align: 'right', mobile: 'hidden' },
    { key: 'planned', header: t('dailyLogs.plannedKg'), cell: (row) => formatQty(row.plannedKg, 'kg', 0), align: 'right', mobile: 'hidden' },
    { key: 'actual', header: t('dailyLogs.givenKg'), cell: (row) => formatQty(row.actualKg, 'kg', 0), align: 'right' },
    { key: 'deviation', header: t('dailyLogs.deviation'), cell: (row) => <DeviationBadge value={row.deviationPercent} threshold={threshold} />, align: 'right' },
    {
      key: 'water',
      header: t('dailyLogs.water'),
      mobile: 'hidden',
      align: 'right',
      cell: (row) => (
        <span className="inline-flex items-center gap-1">
          <Droplets className="size-4 text-muted-foreground" aria-hidden />
          {formatQty(row.waterL, 'l', 0)}
        </span>
      ),
    },
    {
      key: 'condition',
      header: t('dailyLogs.condition'),
      cell: (row) => <Badge variant={row.condition === 'normal' ? 'success' : 'warning'}>{t(`enums:herdCondition.${row.condition}`)}</Badge>,
    },
    ...(canSeeMoney
      ? [{ key: 'cost', header: t('dailyLogs.cost'), cell: (row: LogRow) => <MoneyText value={row.totalCost} />, align: 'right' as const, mobile: 'hidden' as const }]
      : []),
  ];

  return (
    <DataTable<LogRow>
      path={PATH}
      params={{ herdId: herdId || undefined, condition: condition || undefined, from: from || undefined, to: to || undefined }}
      columns={columns}
      defaultSort="-date"
      searchable={false}
      onRowClick={(row) => onOpenLog(row.id)}
      filters={
        <>
          <Select
            aria-label={t('fields.herd')}
            value={herdId}
            onChange={(e) => setHerdId(e.target.value)}
            options={(herds?.data ?? []).map((h) => ({ value: h.id, label: h.name }))}
            placeholder={t('animals.allHerds')}
            className="md:w-52"
          />
          <Select
            aria-label={t('dailyLogs.condition')}
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            options={enumOptions('herdCondition', HERD_CONDITIONS)}
            placeholder={t('dailyLogs.anyCondition')}
            className="md:w-44"
          />
          {/* Two equal date boxes need words: which one is "from" and which "to". */}
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="w-20 shrink-0 md:w-auto">{t('filters.from')}</span>
            <DateInput value={from} onChange={(e) => setFrom(e.target.value)} className="min-w-0 flex-1 md:w-44 md:flex-none" />
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="w-20 shrink-0 md:w-auto">{t('filters.to')}</span>
            <DateInput value={to} onChange={(e) => setTo(e.target.value)} className="min-w-0 flex-1 md:w-44 md:flex-none" />
          </label>
        </>
      }
      empty={{ icon: ClipboardList, title: t('dailyLogs.emptyTitle'), description: t('dailyLogs.emptyBody') }}
    />
  );
}

export default function DailyLogsPage() {
  const { t } = useTranslation('livestock');
  const [date] = useUrlParam('date');
  // The day tab says "Today" only when it shows today.
  const dayLabel = !date || date === todayIso() ? t('dailyLogs.tabs.day') : formatDate(date);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [openLog, setOpenLog] = useState<string | null>(null);

  return (
    <>
      <PageHeader title={t('dailyLogs.title')} description={t('dailyLogs.description')} />
      <Card className="border-0 bg-transparent p-0 shadow-none">
        <UrlTabs
          tabs={[
            { value: 'day', label: dayLabel, content: <DayTab onEdit={setEditing} onOpenLog={setOpenLog} /> },
            { value: 'journal', label: t('dailyLogs.tabs.journal'), content: <JournalTab onOpenLog={setOpenLog} /> },
          ]}
        />
      </Card>
      <LogDetailSheet logId={openLog} onClose={() => setOpenLog(null)} onEdit={setEditing} />
      {editing && (
        <DailyLogSheet
          open
          onOpenChange={(open) => !open && setEditing(null)}
          herdId={editing.herdId}
          herdName={editing.herdName}
          date={editing.date}
          logId={editing.logId}
        />
      )}
    </>
  );
}
