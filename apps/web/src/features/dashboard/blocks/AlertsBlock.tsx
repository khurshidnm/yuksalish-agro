import { CircleAlert, Info, OctagonAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useOpenableLink } from '@/app/canOpen';
import { Badge, type BadgeVariant, Card, CardContent, EmptyState } from '@/components';
import { alertText } from '@/features/alerts/alertText';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AlertsData } from '../types';

const SEVERITY: Record<string, { variant: BadgeVariant; icon: typeof Info; chip: string }> = {
  urgent: { variant: 'danger', icon: OctagonAlert, chip: 'bg-danger-soft text-danger' },
  attention: { variant: 'warning', icon: CircleAlert, chip: 'bg-warning-soft text-warning' },
  info: { variant: 'info', icon: Info, chip: 'bg-info-soft text-info' },
};

export function AlertsBlock({ data }: { data: AlertsData }) {
  const { t } = useTranslation('dashboard');
  const openable = useOpenableLink();
  if (data.items.length === 0) {
    return (
      <Card>
        <EmptyState title={t('alerts.none')} className="py-8" />
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="pt-2 md:pt-2">
        <ul className="divide-y divide-dashed divide-border">
          {data.items.map((alert) => {
            const { variant, icon: Icon, chip } = SEVERITY[alert.severity] ?? SEVERITY.info;
            const text = alertText(alert, t);
            // The icon has a fixed width, so every title starts in the same place whatever the severity's word.
            const body = (
              <>
                <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full', chip)} aria-hidden>
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium break-words">{text.title}</span>
                  {text.body && <span className="block text-sm text-muted-foreground break-words">{text.body}</span>}
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <Badge variant={variant}>{t(`enums:severity.${alert.severity}`)}</Badge>
                    {formatDateTime(alert.lastSeenAt)}
                  </span>
                </span>
              </>
            );
            const row = 'flex min-h-11 items-start gap-3 py-2.5';
            const to = openable(alert.link);
            return (
              <li key={alert.id}>
                {to ? (
                  <Link to={to} className={cn(row, 'focus-ring -mx-2 rounded px-2 hover:bg-muted')}>
                    {body}
                  </Link>
                ) : (
                  <div className={row}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
