import { ArrowDownRight, ArrowRight, ArrowUpRight, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import { Skeleton } from './ui';

export type StatTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const ICON_TONE: Record<StatTone, string> = {
  neutral: 'bg-secondary text-secondary-foreground',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
};

export interface StatDelta {
  /** Already formatted, signed text: "+12%". */
  value: string;
  direction: 'up' | 'down' | 'flat';
  /** Which direction is good. Costs go `down`; the arrow still shows the true direction. */
  goodWhen?: 'up' | 'down';
  /** Comparison period: "vs last month". */
  label?: string;
}

export interface StatCardProps {
  label: ReactNode;
  value: ReactNode;
  delta?: StatDelta;
  hint?: ReactNode;
  tone?: StatTone;
  icon?: LucideIcon;
  loading?: boolean;
  /** Makes the whole tile a link. */
  to?: string;
  className?: string;
}

export function StatCard({ label, value, delta, hint, tone = 'neutral', icon: Icon, loading, to, className }: StatCardProps) {
  const DeltaIcon = delta?.direction === 'up' ? ArrowUpRight : delta?.direction === 'down' ? ArrowDownRight : ArrowRight;
  const deltaGood = delta && delta.direction !== 'flat' && delta.goodWhen ? delta.direction === delta.goodWhen : null;

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm break-words hyphens-auto text-muted-foreground">{label}</p>
        {Icon && (
          <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', ICON_TONE[tone])}>
            <Icon className="size-5" aria-hidden />
          </span>
        )}
      </div>
      {loading ? (
        <Skeleton className="mt-1 h-8 w-2/3" />
      ) : (
        <p className="mt-1 text-2xl leading-tight font-semibold tracking-tight break-words">{value}</p>
      )}
      {!loading && delta && (
        <p className="mt-1 flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <span className={cn('inline-flex items-center gap-0.5 font-medium', deltaGood === true && 'text-success', deltaGood === false && 'text-danger')}>
            <DeltaIcon className="size-4" aria-hidden />
            {delta.value}
          </span>
          {delta.label}
        </p>
      )}
      {!loading && hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
    </>
  );

  const classes = cn('block rounded-xl border border-border bg-card p-4 text-card-foreground shadow-card', className);
  if (to) {
    return (
      <Link to={to} className={cn(classes, 'focus-ring transition-colors hover:border-input')}>
        {body}
      </Link>
    );
  }
  return <div className={classes}>{body}</div>;
}
