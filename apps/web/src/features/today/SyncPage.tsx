import { CheckCircle2, CloudUpload, Loader2, Send, Trash2, TriangleAlert, Wifi, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Alert, Badge, Button, Card } from '@/components/ui';
import { EmptyState, useConfirm } from '@/components';
import { ApiError } from '@/lib/api';
import { formatDateTime, formatQty } from '@/lib/format';
import { canEdit, outbox, useOutbox, type OutboxRecord } from '@/lib/outbox';
import { errorMessage, useDetail } from '@/lib/query';
import { FieldScreen } from './field-ui';
import { keepMine, keepServer, sendToManager, type ServerDailyLog } from './sync';

interface DisplayLine {
  itemId: string;
  itemName: string;
  unit: string;
  actualQty: number | null;
}

function toError(record: OutboxRecord): ApiError {
  const e = record.error;
  return new ApiError(e?.status ?? 0, e?.code ?? 'ERROR', e?.message ?? '', e?.details);
}

const RecordRow = ({ record, children }: { record: OutboxRecord; children?: React.ReactNode }) => {
  const { t } = useTranslation('today');
  return (
    <Card className="flex flex-col gap-2 p-4" data-testid={`record-${record.status}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-base font-semibold break-words">{record.title}</p>
        <Badge variant="neutral">{t(`kinds.${record.kind}`)}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{formatDateTime(new Date(record.createdAt).toISOString())}</p>
      {children}
    </Card>
  );
};

function Failed({ record }: { record: OutboxRecord }) {
  const { t } = useTranslation('today');
  const confirm = useConfirm();
  const editTo = record.kind === 'daily_log' && canEdit(record) ? `/today/daily-log/${record.meta.herdId as string}` : null;

  const discard = async () => {
    const ok = await confirm({ title: t('sync.discardTitle'), description: t('sync.discardBody'), confirmLabel: t('sync.discard'), destructive: true });
    if (ok) await outbox.discard(record.id);
  };

  return (
    <RecordRow record={record}>
      <Alert tone="danger">{errorMessage(toError(record))}</Alert>
      <div className="grid grid-cols-2 gap-2">
        {editTo ? (
          <Button size="lg" className="min-h-14" asChild>
            <Link to={editTo}>{t('sync.edit')}</Link>
          </Button>
        ) : (
          <Button size="lg" className="min-h-14" onClick={() => void outbox.retry(record.id)}>
            {t('sync.retry')}
          </Button>
        )}
        <Button variant="outline" size="lg" className="min-h-14" onClick={() => void discard()}>
          <Trash2 aria-hidden />
          {t('sync.discard')}
        </Button>
      </div>
    </RecordRow>
  );
}

function Amounts({ title, lines, waterL, notes }: { title: string; lines: DisplayLine[]; waterL: number | null | undefined; notes: string | null | undefined }) {
  const { t } = useTranslation('today');
  return (
    <div className="min-w-0 rounded-lg bg-muted p-3">
      <p className="text-sm font-bold">{title}</p>
      <ul className="mt-1 text-base">
        {lines.map((line) => (
          <li key={line.itemId} className="break-words">
            {line.itemName}: <span className="font-semibold">{formatQty(line.actualQty, line.unit)}</span>
          </li>
        ))}
        {waterL != null && (
          <li>
            {t('log.water')}: <span className="font-semibold">{formatQty(waterL, 'l')}</span>
          </li>
        )}
      </ul>
      {notes && <p className="mt-1 text-sm break-words">{notes}</p>}
    </div>
  );
}

function Conflict({ record }: { record: OutboxRecord }) {
  const { t } = useTranslation('today');
  const confirm = useConfirm();
  const server = useDetail<ServerDailyLog>(record.serverId ? `/livestock/daily-logs/${record.serverId}` : null, undefined, { networkMode: 'always', retry: false });
  const [busy, setBusy] = useState<'mine' | 'server' | 'manager' | null>(null);
  const [needsManager, setNeedsManager] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const body = record.body as { waterL?: number | null; notes?: string | null };
  const mine = (record.meta.lines as DisplayLine[] | undefined) ?? [];
  const unknown = server.isError || !record.serverId;

  const run = async (kind: 'mine' | 'server' | 'manager', action: () => Promise<void>) => {
    setBusy(kind);
    setProblem(null);
    try {
      await action();
      toast.success(t('sync.settled'));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'EDIT_WINDOW_CLOSED') setNeedsManager(true);
      else if (error instanceof ApiError && error.code === 'STALE_UPDATE') void server.refetch();
      setProblem(errorMessage(error));
      setBusy(null);
    }
  };

  const chooseServer = async () => {
    const ok = await confirm({ title: t('sync.keepServerTitle'), description: t('sync.keepServerBody'), confirmLabel: t('sync.keepServer'), destructive: true });
    if (ok) await run('server', () => keepServer(record));
  };

  return (
    <RecordRow record={record}>
      <p className="text-base">{t('sync.conflictBody')}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Amounts title={t('sync.mine')} lines={mine} waterL={body.waterL} notes={body.notes} />
        {server.data ? (
          <Amounts title={t('sync.server')} lines={server.data.lines} waterL={server.data.waterL} notes={server.data.notes} />
        ) : (
          <div className="rounded-lg bg-muted p-3 text-base text-muted-foreground">{unknown ? t('sync.serverUnknown') : <Loader2 className="size-5 animate-spin" aria-hidden />}</div>
        )}
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {needsManager ? (
        <Button size="lg" className="min-h-14" loading={busy === 'manager'} onClick={() => void run('manager', () => sendToManager(record))}>
          <Send aria-hidden />
          {t('sync.sendToManager')}
        </Button>
      ) : (
        <Button size="lg" className="min-h-14" loading={busy === 'mine'} disabled={!server.data} onClick={() => void run('mine', () => keepMine(record))}>
          {t('sync.keepMine')}
        </Button>
      )}
      <Button variant="outline" size="lg" className="min-h-14" loading={busy === 'server'} onClick={() => void chooseServer()}>
        {t('sync.keepServer')}
      </Button>
    </RecordRow>
  );
}

export default function SyncPage() {
  const { t } = useTranslation('today');
  const state = useOutbox();
  const { records, sent, syncing, unreachable, others, lastSyncAt } = state;

  const conflicts = records.filter((r) => r.status === 'conflict');
  const failed = records.filter((r) => r.status === 'failed');
  const waiting = records.filter((r) => r.status === 'pending');
  const online = !unreachable && navigator.onLine;

  return (
    <FieldScreen title={t('sync.title')}>
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2 text-base font-semibold">
          {online ? <Wifi className="size-6 text-success" aria-hidden /> : <WifiOff className="size-6 text-warning" aria-hidden />}
          {t(online ? 'sync.online' : 'sync.offline')}
        </div>
        {lastSyncAt !== null && <p className="text-sm text-muted-foreground">{t('sync.lastSync', { time: formatDateTime(new Date(lastSyncAt).toISOString()) })}</p>}
        {waiting.length > 0 && (
          <Button size="lg" className="min-h-14" loading={syncing} onClick={() => void outbox.flush({ force: true })}>
            <CloudUpload aria-hidden />
            {t('sync.sendNow', { n: waiting.length })}
          </Button>
        )}
      </Card>

      {others > 0 && <Alert tone="info">{t('sync.others', { n: others })}</Alert>}

      {conflicts.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <TriangleAlert className="size-5 text-danger" aria-hidden />
            {t('sync.conflicts')}
          </h2>
          {conflicts.map((record) => (
            <Conflict key={record.id} record={record} />
          ))}
        </section>
      )}

      {failed.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <TriangleAlert className="size-5 text-danger" aria-hidden />
            {t('sync.failed')}
          </h2>
          {failed.map((record) => (
            <Failed key={record.id} record={record} />
          ))}
        </section>
      )}

      {waiting.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-bold">{t('sync.waiting')}</h2>
          {waiting.map((record) => (
            <RecordRow key={record.id} record={record} />
          ))}
        </section>
      )}

      {records.length === 0 && <EmptyState icon={CheckCircle2} title={t('sync.emptyTitle')} description={t('sync.emptyBody')} />}

      {sent.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-bold">{t('sync.sent')}</h2>
          <ul className="flex flex-col gap-1">
            {sent.slice(0, 10).map((record) => (
              <li key={record.id} className="flex items-center gap-2 rounded-lg bg-card p-3 text-base">
                <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
                <span className="min-w-0 flex-1 break-words">{record.title}</span>
                <span className="shrink-0 text-sm text-muted-foreground">{formatDateTime(new Date(record.sentAt).toISOString())}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </FieldScreen>
  );
}
