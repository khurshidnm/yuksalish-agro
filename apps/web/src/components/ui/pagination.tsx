import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from './button';

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  /** `total` is a floor: there are more rows than that. */
  capped?: boolean;
  onPageChange: (page: number) => void;
  className?: string;
}

export function Pagination({ page, pageSize, total, capped, onPageChange, className }: PaginationProps) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const more = capped ? '+' : '';

  return (
    <nav aria-label={t('common:table.pagination')} className={cn('flex items-center justify-between gap-3', className)}>
      <p className="text-sm text-muted-foreground tabular-nums">
        {t('common:table.range', { from: formatNumber(from), to: formatNumber(to), total: `${formatNumber(total)}${more}` })}
      </p>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon" aria-label={t('common:actions.previous')} disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <ChevronLeft aria-hidden />
        </Button>
        <span className="min-w-14 text-center text-sm tabular-nums" aria-current="page">
          {page} / {pages}
          {more}
        </span>
        <Button variant="outline" size="icon" aria-label={t('common:actions.next')} disabled={page >= pages} onClick={() => onPageChange(page + 1)}>
          <ChevronRight aria-hidden />
        </Button>
      </div>
    </nav>
  );
}
