import { Progress } from 'radix-ui';
import { cn } from '@/lib/utils';

type Tone = 'primary' | 'success' | 'warning' | 'danger';

const FILL: Record<Tone, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-accent',
  danger: 'bg-destructive',
};

export interface MeterProps {
  /** Percentage. Values above 100 fill the bar; the caller shows the real number. */
  value: number | null | undefined;
  tone?: Tone;
  label: string;
  className?: string;
}

/** A filled bar for budget execution, stock level and the like. Pair it with a visible number. */
export function Meter({ value, tone = 'primary', label, className }: MeterProps) {
  const percent = Math.min(100, Math.max(0, value ?? 0));
  return (
    <Progress.Root value={percent} aria-label={label} className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}>
      <Progress.Indicator className={cn('h-full rounded-full transition-[width]', FILL[tone])} style={{ width: `${percent}%` }} />
    </Progress.Root>
  );
}
