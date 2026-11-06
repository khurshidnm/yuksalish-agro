import { CalendarClock, Camera, CheckCircle2, ClipboardCheck, ListChecks, type LucideIcon, MoreVertical, Pencil, Play, RotateCcw, User, XCircle } from 'lucide-react';
import { todayIso } from '@yap/shared';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { EmptyState, ErrorCard } from '@/components';
import { Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Skeleton } from '@/components/ui';
import { usePermission } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { useList } from '@/lib/query';
import { cn } from '@/lib/utils';
import { entityText, isClosed, PRIORITY_TONE, type Task } from './types';
import { useTaskActions } from './useTaskActions';

interface TaskCardProps {
  task: Task;
  onComplete: (task: Task) => void;
  onEdit: (task: Task) => void;
}

/** What the coloured square says first: done, late, or what the task asks for. */
function chipFor(task: Task, overdue: boolean): { icon: LucideIcon; tone: string } {
  if (isClosed(task)) return { icon: CheckCircle2, tone: 'bg-success-soft text-success' };
  if (overdue) return { icon: CalendarClock, tone: 'bg-danger-soft text-danger' };
  if (task.requiresPhoto) return { icon: Camera, tone: 'bg-info-soft text-info' };
  if (task.requiresRecord) return { icon: ClipboardCheck, tone: 'bg-warning-soft text-warning' };
  return { icon: ListChecks, tone: 'bg-secondary text-secondary-foreground' };
}

function TaskCard({ task, onComplete, onEdit }: TaskCardProps) {
  const { t } = useTranslation('tasks');
  const canManage = usePermission('tasks.create');
  const { start, cancel, reopen } = useTaskActions();
  const closed = isClosed(task);
  const overdue = !closed && task.dueDate !== null && task.dueDate < todayIso();
  const chip = chipFor(task, overdue);

  return (
    <article className="rounded-xl border border-border bg-card p-3.5 text-card-foreground shadow-card">
      <div className="flex items-start gap-3">
        <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', chip.tone)}>
          <chip.icon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-1">
            <h4 className="min-w-0 pt-0.5 leading-snug font-semibold break-words">{task.title}</h4>
            {canManage && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" className="-mt-1.5 -mr-1.5 shrink-0" aria-label={t('common:table.actions')}>
                    <MoreVertical aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onEdit(task)}>
                    <Pencil aria-hidden />
                    {t('common:actions.edit')}
                  </DropdownMenuItem>
                  {closed ? (
                    <DropdownMenuItem onSelect={() => reopen.mutate(task.id)}>
                      <RotateCcw aria-hidden />
                      {t('actions.reopen')}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => cancel.mutate(task.id)}>
                      <XCircle aria-hidden />
                      {t('actions.cancel')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {task.dueDate && (
              <div className={cn('flex items-center gap-1', overdue && 'font-medium text-danger')}>
                <CalendarClock className="size-4" aria-hidden />
                <dt className="sr-only">{t('fields.dueDate')}</dt>
                <dd>{overdue ? t('overdueOn', { date: formatDate(task.dueDate) }) : formatDate(task.dueDate)}</dd>
              </div>
            )}
            {task.assigneeName && canManage && (
              <div className="flex items-center gap-1">
                <User className="size-4" aria-hidden />
                <dt className="sr-only">{t('fields.assignee')}</dt>
                <dd>{task.assigneeName}</dd>
              </div>
            )}
            {task.entityLink && task.entityLabel && (
              <div>
                <dt className="sr-only">{t('fields.linkedObject')}</dt>
                <dd>
                  <Link to={task.entityLink} className="focus-ring inline-flex min-h-11 items-center rounded underline underline-offset-2">
                    {entityText(task, t)}
                  </Link>
                </dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      {task.description && <p className="mt-2.5 line-clamp-2 text-sm text-muted-foreground">{task.description}</p>}

      {!closed && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Badge variant={PRIORITY_TONE[task.priority]}>{t(`enums:priority.${task.priority}`)}</Badge>
          {task.requiresPhoto && (
            <Badge>
              <Camera aria-hidden />
              {t('needsPhoto')}
            </Badge>
          )}
          {task.requiresRecord && (
            <Badge>
              <ClipboardCheck aria-hidden />
              {t(`record.${task.requiresRecord}`)}
            </Badge>
          )}
        </div>
      )}

      {task.completionNote && <p className="mt-2.5 text-sm">{task.completionNote}</p>}

      {!closed && (
        <div className="mt-3 flex gap-2 border-t border-dashed border-border pt-3">
          {task.status === 'open' && (
            <Button variant="outline" size="sm" className="flex-1" loading={start.isPending} onClick={() => start.mutate(task.id)}>
              <Play aria-hidden />
              {t('actions.start')}
            </Button>
          )}
          <Button variant="accent" size="sm" className="flex-1" onClick={() => onComplete(task)}>
            <CheckCircle2 aria-hidden />
            {t('actions.complete')}
          </Button>
        </div>
      )}
    </article>
  );
}

function Column({
  title,
  tasks,
  tone,
  ...actions
}: {
  title: string;
  tasks: Task[];
  tone: 'neutral' | 'info' | 'success';
} & Omit<TaskCardProps, 'task'>) {
  const { t } = useTranslation('tasks');
  return (
    <section className="min-w-0 rounded-2xl bg-muted p-3">
      <header className="flex items-center justify-between gap-2 px-1.5 pt-1 pb-3">
        <h3 className="font-semibold text-heading">{title}</h3>
        <Badge variant={tone} className={tone === 'neutral' ? 'bg-card' : undefined}>
          {tasks.length}
        </Badge>
      </header>
      <div className="space-y-3">
        {tasks.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">{t('board.empty')}</p>}
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} {...actions} />
        ))}
      </div>
    </section>
  );
}

/** Board for managers and the main screen for field staff: big buttons, no dragging, works with gloves. */
export function TaskBoard(props: Omit<TaskCardProps, 'task'>) {
  const { t } = useTranslation('tasks');
  const active = useList<Task>('/tasks', { active: true, pageSize: 200 });
  const done = useList<Task>('/tasks', { status: 'done', pageSize: 10, sort: '-dueDate' });

  if (active.isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-64 w-full" />
        ))}
      </div>
    );
  }
  if (active.error) return <ErrorCard error={active.error} onRetry={() => void active.refetch()} />;

  const tasks = active.data?.data ?? [];
  const closed = done.data?.data ?? [];
  if (tasks.length === 0 && closed.length === 0) {
    return <EmptyState icon={ListChecks} title={t('emptyTitle')} description={t('emptyBody')} />;
  }

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
      <Column title={t('board.open')} tone="neutral" tasks={tasks.filter((task) => task.status === 'open')} {...props} />
      <Column title={t('board.inProgress')} tone="info" tasks={tasks.filter((task) => task.status === 'in_progress')} {...props} />
      <Column title={t('board.done')} tone="success" tasks={closed} {...props} />
    </div>
  );
}
