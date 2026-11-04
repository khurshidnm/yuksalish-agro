import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** Shared by every text-like control. text-base below md stops iOS zooming on focus. */
export const controlClasses =
  'focus-ring block w-full min-h-11 rounded-lg border border-input bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-70 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive md:min-h-10 md:text-sm';

export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return <input type={type ?? 'text'} className={cn(controlClasses, className)} {...props} />;
}

export function Textarea({ className, rows, ...props }: ComponentProps<'textarea'>) {
  return <textarea rows={rows ?? 3} className={cn(controlClasses, 'resize-y', className)} {...props} />;
}

/** Native date picker: the best experience on phones. Value is a YYYY-MM-DD string. */
export function DateInput({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return <input type="date" className={cn(controlClasses, 'appearance-none', className)} {...props} />;
}
