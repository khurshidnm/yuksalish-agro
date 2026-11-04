import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons; they wrap below the title on phones. */
  actions?: ReactNode;
  /** Back link for detail pages. */
  back?: { to: string; label: string };
  className?: string;
}

export function PageHeader({ title, description, actions, back, className }: PageHeaderProps) {
  return (
    <header className={cn('mb-4 flex flex-col gap-3 md:mb-6 md:flex-row md:items-start md:justify-between', className)}>
      <div className="min-w-0">
        {back && (
          <Link
            to={back.to}
            className="focus-ring -ml-1 mb-1 inline-flex min-h-11 items-center gap-1 rounded px-1 text-sm text-muted-foreground hover:text-foreground md:min-h-0"
          >
            <ArrowLeft className="size-4" aria-hidden />
            {back.label}
          </Link>
        )}
        <h1 className="text-2xl leading-tight font-semibold tracking-tight break-words">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
