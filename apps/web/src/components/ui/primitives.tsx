import { Check, Minus } from 'lucide-react';
import { Checkbox as RCheckbox, Label as RLabel, Separator as RSeparator, Switch as RSwitch } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Label({ className, ...props }: ComponentProps<typeof RLabel.Root>) {
  return <RLabel.Root className={cn('block text-sm font-medium text-foreground', className)} {...props} />;
}

export function Checkbox({ className, ...props }: ComponentProps<typeof RCheckbox.Root>) {
  return (
    <RCheckbox.Root
      className={cn(
        'focus-ring relative flex size-6 shrink-0 items-center justify-center rounded border border-input bg-popover after:absolute after:-inset-2.5 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground disabled:opacity-50 md:size-5',
        className,
      )}
      {...props}
    >
      <RCheckbox.Indicator>
        {props.checked === 'indeterminate' ? <Minus className="size-4" aria-hidden /> : <Check className="size-4" aria-hidden />}
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  );
}

export function Switch({ className, ...props }: ComponentProps<typeof RSwitch.Root>) {
  return (
    <RSwitch.Root
      className={cn(
        'focus-ring relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border border-input bg-muted transition-colors after:absolute after:-inset-2 data-[state=checked]:border-primary data-[state=checked]:bg-primary disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <RSwitch.Thumb className="block size-5 translate-x-1 rounded-full bg-popover ring-1 ring-input transition-transform data-[state=checked]:translate-x-6 data-[state=checked]:ring-transparent" />
    </RSwitch.Root>
  );
}

export function Separator({ className, orientation = 'horizontal', ...props }: ComponentProps<typeof RSeparator.Root>) {
  return (
    <RSeparator.Root
      orientation={orientation}
      className={cn('shrink-0 bg-border', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)}
      {...props}
    />
  );
}

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}
