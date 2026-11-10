import { todayIso } from '@yap/shared';
import { ListPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { z } from 'zod';
import { ComboboxField, DateField, FormDialog } from '@/components';
import { Badge, type BadgeVariant, Button } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { zOptionalDate, zOptionalRef } from '@/lib/forms';
import { useApiMutation } from '@/lib/query';
import { memberOptions } from '@/features/tasks/TaskFormDialog';
import type { Alert, AlertTask } from './types';

const TASK_TONE: Record<AlertTask['status'], BadgeVariant> = {
  open: 'neutral',
  in_progress: 'info',
  done: 'success',
  cancelled: 'outline',
};

/** The tasks list, narrowed to the task of one alert. */
export const tasksOfAlertLink = (alertId: string) => `/tasks?tab=list&alert=${alertId}`;

interface AlertTaskCellProps {
  alert: Alert;
  canCreate: boolean;
  /** Null when this person cannot open the tasks page. */
  tasksLink: string | null;
  onCreate: (alert: Alert) => void;
}

/**
 * The task column of an alert: its task with status and a way to it, or the button that makes one.
 * A task that is done leaves the button, because the problem is still there and may need more work.
 */
export function AlertTaskCell({ alert, canCreate, tasksLink, onCreate }: AlertTaskCellProps) {
  const { t } = useTranslation('alerts');
  const task = alert.task ?? null;
  const mayAdd = canCreate && alert.status !== 'resolved' && (!task || task.status === 'done');
  if (!task && !mayAdd) return '—';

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      {task && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Badge variant={TASK_TONE[task.status]}>{t(`enums:taskStatus.${task.status}`)}</Badge>
          <span className="text-sm text-muted-foreground">
            {task.assigneeUserId === null ? t('task.unassigned') : task.assigneeName}
            {task.dueDate && task.status !== 'done' && ` · ${formatDate(task.dueDate)}`}
          </span>
          {task.completionSource === 'alert_resolved' && (
            <span className="text-sm text-muted-foreground">{t('enums:taskCompletionSource.alert_resolved')}</span>
          )}
          {tasksLink && (
            <Link to={tasksLink} className="focus-ring inline-flex min-h-11 items-center rounded text-sm underline underline-offset-2">
              {t('task.open')}
            </Link>
          )}
        </div>
      )}
      {mayAdd && (
        <Button variant="outline" size="sm" onClick={() => onCreate(alert)}>
          <ListPlus aria-hidden />
          {t('actions.createTask')}
        </Button>
      )}
    </div>
  );
}

const schema = z.object({
  assigneeUserId: zOptionalRef(),
  dueDate: zOptionalDate(),
});

interface AlertTaskDialogProps {
  /** The alert to make a task for; null keeps the dialog closed. */
  alert: Alert | null;
  onOpenChange: (open: boolean) => void;
}

/** Both fields may stay empty: the task takes its words, priority and date from the alert. */
export function AlertTaskDialog({ alert, onOpenChange }: AlertTaskDialogProps) {
  const { t } = useTranslation('alerts');
  const create = useApiMutation<z.output<typeof schema>>({
    mutationFn: (values) => api.post(`/alerts/${alert!.id}/task`, values),
    invalidate: ['/alerts', '/tasks'],
    silentError: true,
  });

  return (
    <FormDialog
      open={alert !== null}
      onOpenChange={onOpenChange}
      title={t('taskDialog.title')}
      description={t('taskDialog.description')}
      schema={schema}
      defaultValues={{ assigneeUserId: null, dueDate: '' }}
      onSubmit={(values) => create.mutateAsync(values)}
      submitLabel={t('taskDialog.submit')}
      successMessage="alerts:toast.taskCreated"
      size="sm"
    >
      {(form) => (
        <>
          <ComboboxField
            form={form}
            name="assigneeUserId"
            label={t('taskDialog.assignee')}
            loadOptions={memberOptions}
            placeholder={t('taskDialog.assigneePlaceholder')}
          />
          <DateField form={form} name="dueDate" label={t('taskDialog.dueDate')} hint={t('taskDialog.dueDateHint')} min={todayIso()} />
        </>
      )}
    </FormDialog>
  );
}
