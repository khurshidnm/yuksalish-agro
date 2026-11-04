import { CircleAlert, Info, OctagonAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Badge, type BadgeVariant, Card, CardContent, EmptyState } from '@/components';
import { alertText } from '@/features/alerts/alertText';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AlertsData } from '../types';

const SEVERITY: Record<string, { variant: BadgeVariant; icon: typeof Info }> = {
  urgent: { variant: 'danger', icon: OctagonAlert },
  attention: { variant: 'warning', icon: CircleAlert },
  info: { variant: 'info', icon: Info },
};

export function AlertsBlock({ data }: { data: AlertsData }) {
  const { t } = useTranslation('dashboard');
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
        <ul className="divide-y divide-border">
          {data.items.map((alert) => {
            const { variant, icon: Icon } = SEVERITY[alert.severity] ?? SEVERITY.info;
            const text = alertText(alert, t);
            const body = (
              <>
                <Badge variant={variant} className="mt-0.5 shrink-0">
                  <Icon aria-hidden />
                  {t(`enums:severity.${alert.severity}`)}
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium break-words">{text.title}</span>
                  {text.body && <span className="block text-sm text-muted-foreground break-words">{text.body}</span>}
                  <span className="block text-xs text-muted-foreground">{formatDateTime(alert.lastSeenAt)}</span>
                </span>
              </>
            );
            const row = 'flex min-h-11 flex-wrap items-start gap-x-3 gap-y-1 py-2.5';
            return (
              <li key={alert.id}>
                {alert.link ? (
                  <Link to={alert.link} className={cn(row, 'focus-ring -mx-2 rounded px-2 hover:bg-muted')}>
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
