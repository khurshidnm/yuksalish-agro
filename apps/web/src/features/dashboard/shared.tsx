import type { Permission } from '@yap/shared';
import { latinToCyrillic } from '@yap/shared/i18n';
import { ChevronRight, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button, Card, CardContent, StatCard, type StatCardProps } from '@/components';
import { useCan, useModuleEnabled } from '@/lib/auth';
import { formatMonthShort, formatNumber } from '@/lib/format';
import i18n from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { LocalizedName } from './types';

/** A path, or nothing when the reader could not open it: their number stays plain text. */
export function useLinkTo() {
  const can = useCan();
  const moduleEnabled = useModuleEnabled();
  return (path: string, permission: Permission): string | undefined =>
    can(permission) && moduleEnabled(permission.split('.')[0]) ? path : undefined;
}

export type LinkTo = ReturnType<typeof useLinkTo>;

export function localName(name: LocalizedName): string {
  if (i18n.language === 'uz-Cyrl') return latinToCyrillic(name.uz);
  return name[i18n.language as keyof LocalizedName] ?? name.uz;
}

/** Close to running out, a rounded figure would flatter the stock: 9,5 days must not read as 10. */
export function daysNumber(days: number): string {
  return formatNumber(days, days < 10 ? 1 : 0);
}

/** "2027-02-15" → "15 Fev", for chart axes. */
export function dayMonth(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${formatMonthShort(iso)}`;
}

/** `null` is missing data: a dash and a short reason, never a zero (CLAUDE.md rule 5). */
export function Tile({ value, hint, ...props }: Omit<StatCardProps, 'value'> & { value: ReactNode }) {
  const { t } = useTranslation('dashboard');
  const missing = value === null || value === undefined;
  return <StatCard {...props} value={missing ? '—' : value} hint={missing ? t('noData') : hint} />;
}

export function NoData({ className }: { className?: string }) {
  const { t } = useTranslation('dashboard');
  return <p className={cn('text-sm text-muted-foreground', className)}>{t('noData')}</p>;
}

export function Section({ title, to, children }: { title: string; to?: string; children: ReactNode }) {
  const { t } = useTranslation('dashboard');
  return (
    <section className="min-w-0">
      <div className="mb-2 flex min-h-11 items-center justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight text-heading">{title}</h2>
        {to && (
          <Link
            to={to}
            className="focus-ring inline-flex min-h-11 items-center gap-0.5 rounded-lg bg-muted px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground md:min-h-9"
          >
            {t('details')}
            <ChevronRight className="size-4" aria-hidden />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

/** One failed block: the rest of the page keeps working. */
export function BlockUnavailable({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('dashboard');
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between md:pt-5">
        <div>
          <p className="font-medium">{t('unavailable.title')}</p>
          <p className="text-sm text-muted-foreground">{t('unavailable.text')}</p>
        </div>
        <Button variant="outline" onClick={onRetry}>
          <RotateCcw aria-hidden />
          {t('unavailable.retry')}
        </Button>
      </CardContent>
    </Card>
  );
}

interface FigureRowProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  to?: string;
}

/** A label and its figure. Linked rows are full tap targets. */
export function FigureRow({ label, value, hint, to }: FigureRowProps) {
  const body = (
    <>
      <span className="min-w-0">
        <span className="block break-words">{label}</span>
        {hint && <span className="block text-sm text-muted-foreground">{hint}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1 text-right font-medium tabular-nums">
        {value}
        {to && <ChevronRight className="size-4 text-muted-foreground" aria-hidden />}
      </span>
    </>
  );
  const row = 'flex min-h-11 items-center justify-between gap-3 py-1.5';
  const divider = 'border-b border-dashed border-border last:border-0';
  if (to) {
    return (
      <li className={divider}>
        <Link to={to} className={cn(row, 'focus-ring -mx-2 rounded-lg px-2 hover:bg-muted')}>
          {body}
        </Link>
      </li>
    );
  }
  return <li className={cn(row, divider)}>{body}</li>;
}
