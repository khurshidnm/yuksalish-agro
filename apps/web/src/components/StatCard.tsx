import { ArrowDownRight, ArrowRight, ArrowUpRight, type LucideIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import { Skeleton } from './ui';

export type StatTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const ICON_TONE: Record<StatTone, string> = {
  neutral: 'text-muted-foreground',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
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
  /** The deep green tile that leads a row. One per row: when everything stands out, nothing does. */
  featured?: boolean;
  /** A picture behind a featured tile, under a deep green wash so the text stays readable. */
  backdrop?: string;
  className?: string;
}

export function StatCard({ label, value, delta, hint, tone = 'neutral', icon: Icon, loading, to, featured, backdrop, className }: StatCardProps) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const DeltaIcon = delta?.direction === 'up' ? ArrowUpRight : delta?.direction === 'down' ? ArrowDownRight : ArrowRight;
  const deltaGood = delta && delta.direction !== 'flat' && delta.goodWhen ? delta.direction === delta.goodWhen : null;
  const subdued = featured ? 'text-feature-muted' : 'text-muted-foreground';

  const body = (
    <>
      {featured && backdrop && !photoFailed && (
        <>
          <img src={backdrop} alt="" loading="lazy" decoding="async" onError={() => setPhotoFailed(true)} className="absolute inset-0 size-full object-cover" />
          <span aria-hidden className="absolute inset-0 bg-gradient-to-r from-feature via-feature/85 to-feature/35" />
        </>
      )}
      <div className="relative">
        <div className="flex items-start justify-between gap-2">
          <p className={cn('flex min-w-0 items-start gap-1.5 text-sm leading-snug break-words hyphens-auto', subdued)}>
            {/* On a phone a linked tile has no room for both, and the label would break mid-word. */}
            {Icon && <Icon className={cn('mt-px size-4 shrink-0', to && 'max-sm:hidden', !featured && ICON_TONE[tone])} aria-hidden />}
            <span className="min-w-0">{label}</span>
          </p>
          {to && (
            <span className={cn('-mt-1 -mr-1 flex size-8 shrink-0 items-center justify-center rounded-full', featured ? 'bg-feature-foreground text-feature' : 'bg-card text-foreground shadow-card')}>
              <ArrowUpRight className="size-4" aria-hidden />
            </span>
          )}
        </div>
        {loading ? (
          <Skeleton className="mt-4 h-8 w-2/3" />
        ) : (
          <p className="mt-4 text-2xl leading-tight font-medium tracking-tight break-words md:text-[1.75rem]">{value}</p>
        )}
        {!loading && delta && (
          <p className={cn('mt-1 flex flex-wrap items-center gap-1 text-sm', subdued)}>
            <span className={cn('inline-flex items-center gap-0.5 font-medium', !featured && deltaGood === true && 'text-success', !featured && deltaGood === false && 'text-danger')}>
              <DeltaIcon className="size-4" aria-hidden />
              {delta.value}
            </span>
            {delta.label}
          </p>
        )}
        {!loading && hint && <p className={cn('mt-1 text-sm', subdued)}>{hint}</p>}
      </div>
    </>
  );

  const classes = cn('relative block overflow-hidden rounded-xl p-4', featured ? 'feature-surface text-feature-foreground' : 'bg-muted text-card-foreground', className);
  if (to) {
    return (
      <Link to={to} className={cn(classes, 'focus-ring transition-colors', !featured && 'hover:bg-secondary')}>
        {body}
      </Link>
    );
  }
  return <div className={classes}>{body}</div>;
}
