import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { Task } from './types';

const LINK = 'focus-ring inline-flex min-h-11 items-center rounded text-sm text-muted-foreground underline underline-offset-2';

interface TaskLinksProps {
  task: Pick<Task, 'alertId' | 'link'>;
  /** From `useOpenableLink()`: a link this person cannot follow is not offered. */
  openable: (link: string | null | undefined) => string | null;
}

/** For a task that came from an alert: the way to the place of the work, and back to the alert. */
export function TaskLinks({ task, openable }: TaskLinksProps) {
  const { t } = useTranslation('tasks');
  const work = openable(task.link);
  const alert = task.alertId ? openable(`/alerts?alert=${task.alertId}`) : null;
  if (!work && !alert) return null;
  return (
    <span className="flex flex-wrap gap-x-4">
      {work && (
        <Link to={work} className={LINK}>
          {t('workLink')}
        </Link>
      )}
      {alert && (
        <Link to={alert} className={LINK}>
          {t('fromAlert')}
        </Link>
      )}
    </span>
  );
}
