import { Progress } from 'radix-ui';
import { cn } from '@/lib/utils';

type Tone = 'primary' | 'success' | 'warning' | 'danger';

const FILL: Record<Tone, string> = {
  primary: 'bg-mark',
  success: 'bg-success',
  warning: 'bg-warning-fill',
  danger: 'bg-destructive',
};

export interface MeterProps {
  /** Percentage. Values above 100 fill the bar; the caller shows the real number. */
  value: number | null | undefined;
  tone?: Tone;
  label: string;
  /** Fine vertical ticks instead of a solid bar, for levels read at a glance: stock, feed, progress. */
  ticks?: boolean;
  className?: string;
}

/** A filled bar for budget execution, stock level and the like. Pair it with a visible number. */
export function Meter({ value, tone = 'primary', label, ticks, className }: MeterProps) {
  const percent = Math.min(100, Math.max(0, value ?? 0));
  return (
    <Progress.Root
      value={percent}
      aria-label={label}
      className={cn('w-full overflow-hidden bg-mark-track', ticks ? 'meter-ticks h-3.5' : 'h-2 rounded-full', className)}
    >
      <Progress.Indicator className={cn('h-full transition-[width]', !ticks && 'rounded-full', FILL[tone])} style={{ width: `${percent}%` }} />
    </Progress.Root>
  );
}
