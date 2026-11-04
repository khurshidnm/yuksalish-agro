import { RefreshCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/lib/query';
import { cn } from '@/lib/utils';
import { Button } from './ui';

export interface ErrorCardProps {
  error: unknown;
  onRetry?: () => void;
  title?: ReactNode;
  className?: string;
}

/** Shows the server's message with a retry, in place of content that failed to load. */
export function ErrorCard({ error, onRetry, title, className }: ErrorCardProps) {
  const { t } = useTranslation();
  return (
    <div role="alert" className={cn('flex flex-col items-center gap-2 rounded-xl border border-border bg-card px-4 py-10 text-center', className)}>
      <span className="mb-1 flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger">
        <TriangleAlert className="size-6" aria-hidden />
      </span>
      <p className="font-semibold">{title ?? t('common:errors.title')}</p>
      <p className="max-w-md text-sm break-words text-muted-foreground">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" className="mt-2" onClick={onRetry}>
          <RefreshCw aria-hidden />
          {t('common:actions.retry')}
        </Button>
      )}
    </div>
  );
}
