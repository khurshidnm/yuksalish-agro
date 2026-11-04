import { type VariantProps, cva } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  'focus-ring inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary-hover',
        accent: 'bg-accent text-accent-foreground hover:bg-accent-hover',
        outline: 'border border-input bg-card text-foreground hover:bg-muted',
        ghost: 'text-foreground hover:bg-muted',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive-hover',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'min-h-11 px-3 text-sm md:min-h-9 [&_svg]:size-4',
        md: 'min-h-11 px-4 text-base md:min-h-10 md:text-sm [&_svg]:size-5 md:[&_svg]:size-4',
        lg: 'min-h-13 px-6 text-base font-semibold [&_svg]:size-5',
        icon: 'size-11 md:size-10 [&_svg]:size-5',
        'icon-sm': 'size-11 md:size-8 [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  /** Render the single child as the button, e.g. a router Link. */
  asChild?: boolean;
  /** Show a spinner and block clicks. */
  loading?: boolean;
}

export function Button({ className, variant, size, asChild, loading, disabled, children, type, ...props }: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) {
    return (
      <Slot.Root className={classes} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button type={type ?? 'button'} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading && <Loader2 className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}
