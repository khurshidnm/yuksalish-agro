import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons; they wrap below the title on phones, and on wider screens whenever they leave the title too little room. */
  actions?: ReactNode;
  /** Back link for detail pages. */
  back?: { to: string; label: string };
  className?: string;
}

export function PageHeader({ title, description, actions, back, className }: PageHeaderProps) {
  return (
    <header className={cn('mb-4 flex flex-col gap-3 md:mb-6 md:flex-row md:flex-wrap md:items-start md:justify-between', className)}>
      {/* The title always keeps 20rem. When the buttons do not fit beside that, they move under the
          title instead of squeezing it down to a letter per line. */}
      <div className="min-w-0 md:min-w-80 md:flex-1">
        {back && (
          <Link
            to={back.to}
            className="focus-ring -ml-1 mb-1 inline-flex min-h-11 items-center gap-1 rounded px-1 text-sm text-muted-foreground hover:text-foreground md:min-h-0"
          >
            <ArrowLeft className="size-4" aria-hidden />
            {back.label}
          </Link>
        )}
        <h1 className="text-2xl leading-tight font-semibold tracking-tight break-words text-heading md:text-[1.75rem]">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
