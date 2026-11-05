import { todayIso } from '@yap/shared';
import {
  Baby,
  Camera,
  Check,
  ChevronRight,
  ClipboardCheck,
  CloudOff,
  HeartPulse,
  Map as MapIcon,
  PawPrint,
  Scale,
  Skull,
  Syringe,
  Tractor,
  TriangleAlert,
  Warehouse,
  Wheat,
  type LucideIcon,
} from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Badge, Button, Card } from '@/components/ui';
import { EmptyState, ErrorCard } from '@/components';
import { CheckInCard } from '@/features/hr/CheckInCard';
import { compressImage } from '@/features/livestock/shared';
import { useSession } from '@/lib/auth';
import { formatDateLong, formatDateTime } from '@/lib/format';
import { outbox, useOutbox, type OutboxRecord, type SentRecord } from '@/lib/outbox';
import { cn } from '@/lib/utils';
import { useAnimalDirectory, useTodayData, type TodayData, type TodayHerd, type TodayTask } from './data';
import { FieldSkeleton } from './field-ui';
import { herdDayStatus, type HerdDayStatus } from './logic';

interface ActionDef {
  to: string;
  icon: LucideIcon;
  /** Works with no connection. */
  offline?: boolean;
}

/** Screens per role, spec 18.1. The server decides which keys this user gets. */
const ACTIONS: Record<string, ActionDef> = {
  report_sick: { to: '/today/report-sick', icon: HeartPulse, offline: true },
  record_death: { to: '/today/death', icon: Skull, offline: true },
  weight: { to: '/today/weight', icon: Scale, offline: true },
  lambing: { to: '/today/lambing', icon: Baby, offline: true },
  animals: { to: '/livestock/animals', icon: PawPrint },
  health: { to: '/livestock/health', icon: Syringe },
  field_operation: { to: '/crops/operations', icon: ClipboardCheck },
  field_map: { to: '/farm/map', icon: MapIcon },
  machinery: { to: '/assets', icon: Tractor },
  stock: { to: '/inventory/stock', icon: Warehouse },
  rations: { to: '/feed/rations', icon: Wheat },
};

const STATUS_BADGE: Record<HerdDayStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  todo: 'neutral',
  queued: 'warning',
  failed: 'danger',
  conflict: 'danger',
  logged: 'success',
};

function HerdCard({ herd, status }: { herd: TodayHerd; status: HerdDayStatus }) {
  const { t } = useTranslation('today');
  const done = status === 'logged' || status === 'queued';
  const to = status === 'failed' || status === 'conflict' ? '/today/sync' : `/today/daily-log/${herd.id}`;
  return (
    <Link
      to={to}
      data-testid={`herd-${herd.id}`}
      className={cn(
        'focus-ring flex min-h-24 items-center gap-3 rounded-2xl p-4',
        done ? 'border border-border bg-card text-card-foreground' : 'bg-primary text-primary-foreground',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-lg leading-tight font-bold break-words">{herd.name}</p>
        <p className={cn('text-base', done ? 'text-muted-foreground' : 'text-primary-foreground')}>{t('herd.head', { n: herd.headCount })}</p>
        {status !== 'todo' && (
          <Badge variant={STATUS_BADGE[status]} className="mt-1.5">
            {t(`herd.${status}`)}
          </Badge>
        )}
      </div>
      {status === 'logged' ? <Check className="size-8 shrink-0 text-success" aria-hidden /> : <ChevronRight className="size-8 shrink-0" aria-hidden />}
    </Link>
  );
}

function ActionTile({ actionKey, def, offline }: { actionKey: string; def: ActionDef; offline: boolean }) {
  const { t } = useTranslation('today');
  const Icon = def.icon;
  const unavailable = offline && !def.offline;
  return (
    <Link
      to={def.to}
      className={cn(
        'focus-ring flex min-h-24 flex-col items-center justify-center gap-1.5 rounded-2xl border border-border bg-card p-3 text-center text-card-foreground hover:bg-muted',
        unavailable && 'opacity-60',
      )}
    >
      {unavailable ? <CloudOff className="size-8 text-muted-foreground" aria-hidden /> : <Icon className="size-8 text-primary" aria-hidden />}
      <span className="text-base leading-tight font-semibold break-words">{t(`actions.${actionKey}`)}</span>
    </Link>
  );
}

function taskIsQueued(task: TodayTask, records: OutboxRecord[], sent: SentRecord[]): boolean {
  const mine = (r: OutboxRecord | SentRecord) => r.kind === 'task_complete' && r.meta.taskId === task.id;
  return records.some(mine) || sent.some(mine);
}

const PRIORITY_CHIP: Record<string, string> = {
  high: 'bg-danger-soft text-danger',
  normal: 'bg-secondary text-secondary-foreground',
  low: 'bg-muted text-muted-foreground',
};

function TaskRow({ task, date, queued }: { task: TodayTask; date: string; queued: boolean }) {
  const { t } = useTranslation('today');
  const camera = useRef<HTMLInputElement>(null);
  const overdue = task.dueDate !== null && task.dueDate < date;

  const finish = async (photo?: { name: string; blob: Blob }) => {
    try {
      await outbox.enqueue({
        kind: 'task_complete',
        path: `/tasks/${task.id}/complete`,
        body: { note: null },
        title: task.title,
        meta: { taskId: task.id },
        ...(photo ? { photos: [photo], photoField: 'photoFileId' as const } : {}),
      });
    } catch {
      toast.error(t('saved.failed'));
    }
  };

  return (
    <li className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3">
      <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl', PRIORITY_CHIP[task.priority] ?? PRIORITY_CHIP.normal)}>
        {task.requiresPhoto ? <Camera className="size-5" aria-hidden /> : <ClipboardCheck className="size-5" aria-hidden />}
      </span>
      <div className={cn('min-w-0 flex-1', queued && 'text-muted-foreground line-through')}>
        <p className="text-base leading-snug font-semibold break-words">{task.title}</p>
        {task.entityLabel && <p className="text-sm text-muted-foreground">{task.entityLabel}</p>}
        {!queued && (overdue || task.priority === 'high') && (
          <span className="mt-1 flex flex-wrap gap-1">
            {overdue && <Badge variant="danger">{t('tasks.overdue')}</Badge>}
            {task.priority === 'high' && <Badge variant="danger">{t('enums:priority.high')}</Badge>}
          </span>
        )}
      </div>
      {task.requiresRecord ? (
        <Button variant="outline" size="lg" className="min-h-14 shrink-0" asChild>
          <Link to="/tasks">{t('tasks.open')}</Link>
        </Button>
      ) : queued ? (
        <Check className="size-8 shrink-0 text-success" aria-label={t('tasks.done')} />
      ) : task.requiresPhoto ? (
        <>
          <input
            ref={camera}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void compressImage(file, 1280, 0.7).then((c) => finish({ name: c.name, blob: c }));
            }}
          />
          <button
            type="button"
            aria-label={t('tasks.photoDone', { title: task.title })}
            className="focus-ring flex size-14 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"
            onClick={() => camera.current?.click()}
          >
            <Camera className="size-7" aria-hidden />
          </button>
        </>
      ) : (
        <button
          type="button"
          aria-label={t('tasks.markDone', { title: task.title })}
          className="focus-ring flex size-14 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground hover:bg-primary hover:text-primary-foreground"
          onClick={() => void finish()}
        >
          <Check className="size-7" aria-hidden />
        </button>
      )}
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-lg font-bold">{title}</h2>
      {children}
    </section>
  );
}

function AttendanceNote({ attendance }: { attendance: TodayData['attendance'] }) {
  const { t } = useTranslation('today');
  if (!attendance?.checkIn) return null;
  return <Card className="p-4 text-base">{t('attendance.since', { time: formatDateTime(attendance.checkIn) })}</Card>;
}

export default function TodayPage() {
  const { t } = useTranslation('today');
  const session = useSession();
  const { data, offline, savedAt, loading, error, refetch } = useTodayData();
  const { records, sent } = useOutbox();
  const date = todayIso();
  // Loaded here, not on the forms: the connection may be gone by the time a form is opened.
  useAnimalDirectory();

  if (loading) return <FieldSkeleton />;

  if (!data) {
    // Nothing stored yet: the phone has never had a connection on this account.
    return (
      <div className="mx-auto max-w-xl">
        {error ? (
          <ErrorCard title={t('data.firstTimeTitle')} error={error} onRetry={() => void refetch()} />
        ) : (
          <EmptyState icon={CloudOff} title={t('data.firstTimeTitle')} description={t('data.firstTimeBody')} />
        )}
      </div>
    );
  }

  const actions = data.actions.filter((key) => key in ACTIONS);
  const stale = data.date !== date;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-5">
      <header>
        <h1 className="text-2xl font-bold text-heading">{t('title')}</h1>
        <p className="text-base text-muted-foreground">{formatDateLong(date)}</p>
        {session.farm && <p className="text-sm text-muted-foreground">{session.farm.name}</p>}
      </header>

      {(offline || stale) && savedAt !== null && (
        <div role="status" data-testid="stale-data" className="flex items-start gap-2 rounded-xl bg-warning-soft p-3 text-base text-warning">
          <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
          {t('data.stale', { time: formatDateTime(new Date(savedAt).toISOString()) })}
        </div>
      )}

      {data.herds.length > 0 && (
        <Section title={t('sections.herds')}>
          {data.herds.map((herd) => (
            <HerdCard key={herd.id} herd={herd} status={herdDayStatus(herd, records, sent, date, data.date)} />
          ))}
        </Section>
      )}

      {offline ? <AttendanceNote attendance={data.attendance} /> : <CheckInCard className="min-h-36 rounded-xl [&_button]:min-h-14" />}

      {actions.length > 0 && (
        <Section title={t('sections.actions')}>
          <div className="grid grid-cols-2 gap-2.5">
            {actions.map((key) => (
              <ActionTile key={key} actionKey={key} def={ACTIONS[key]} offline={offline} />
            ))}
          </div>
        </Section>
      )}

      <Section title={t('sections.tasks')}>
        {data.tasks.length === 0 ? (
          <p className="rounded-2xl border border-border bg-card p-4 text-base text-muted-foreground">{t('tasks.none')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.tasks.map((task) => (
              <TaskRow key={task.id} task={task} date={date} queued={taskIsQueued(task, records, sent)} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
