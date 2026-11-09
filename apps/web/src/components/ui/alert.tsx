import { type VariantProps, cva } from 'class-variance-authority';
import { CheckCircle2, Info, type LucideIcon, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

const alertVariants = cva('flex gap-3 rounded-lg p-3 text-sm', {
  variants: {
    tone: {
      info: 'bg-info-soft text-info',
      success: 'bg-success-soft text-success',
      warning: 'bg-warning-soft text-warning',
      danger: 'bg-danger-soft text-danger',
    },
  },
  defaultVariants: { tone: 'info' },
});

const ICONS = { info: Info, success: CheckCircle2, warning: TriangleAlert, danger: OctagonAlert };

export interface AlertProps extends Omit<ComponentProps<'div'>, 'title'>, VariantProps<typeof alertVariants> {
  title?: ReactNode;
  /** Replaces the tone's own icon, e.g. a padlock for a closed month. One icon per alert. */
  icon?: LucideIcon;
}

export function Alert({ tone, title, icon, children, className, ...props }: AlertProps) {
  const Icon = icon ?? ICONS[tone ?? 'info'];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn(alertVariants({ tone }), className)} {...props}>
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="break-words">{children}</div>}
      </div>
    </div>
  );
}
