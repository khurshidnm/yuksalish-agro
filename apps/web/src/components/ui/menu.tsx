import { DropdownMenu as RMenu, Tooltip as RTooltip } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const DropdownMenu = RMenu.Root;
export const DropdownMenuTrigger = RMenu.Trigger;

export function DropdownMenuContent({ className, sideOffset = 6, align = 'end', ...props }: ComponentProps<typeof RMenu.Content>) {
  return (
    <RMenu.Portal>
      <RMenu.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cn(
          'data-[state=open]:animate-pop-in z-[60] max-h-[70dvh] min-w-48 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-pop',
          className,
        )}
        {...props}
      />
    </RMenu.Portal>
  );
}

export interface DropdownMenuItemProps extends ComponentProps<typeof RMenu.Item> {
  destructive?: boolean;
}

export function DropdownMenuItem({ className, destructive, ...props }: DropdownMenuItemProps) {
  return (
    <RMenu.Item
      className={cn(
        'flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted md:min-h-9 [&_svg]:size-4 [&_svg]:shrink-0',
        destructive && 'text-destructive',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof RMenu.Label>) {
  return <RMenu.Label className={cn('px-2.5 py-1.5 text-xs text-muted-foreground', className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof RMenu.Separator>) {
  return <RMenu.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}

export const TooltipProvider = RTooltip.Provider;

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: ComponentProps<typeof RTooltip.Content>['side'];
}

export function Tooltip({ content, children, side }: TooltipProps) {
  return (
    <RTooltip.Root delayDuration={200}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="data-[state=delayed-open]:animate-fade-in z-[70] max-w-xs rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-pop"
        >
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}
