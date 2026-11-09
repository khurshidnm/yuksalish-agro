import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-xl border border-border bg-card text-card-foreground shadow-card', className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 p-4 md:p-5', className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<'h3'>) {
  return <h3 className={cn('text-base font-semibold text-heading', className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

/**
 * No top padding, because it follows a CardHeader. Without a header, pass `pt-4`: the top is set once for
 * every width (no `md:pt-0` here), so that padding holds on desktop too.
 */
export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-4 pt-0 pb-4 md:px-5 md:pb-5', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-center gap-2 border-t border-border p-4 md:px-5', className)} {...props} />;
}
