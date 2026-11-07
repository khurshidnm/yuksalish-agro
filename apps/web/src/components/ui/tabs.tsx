import { Tabs as RTabs } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Tabs = RTabs.Root;

/**
 * Scrolls sideways on phones rather than wrapping or pushing the page wider. A scroller clips on both
 * axes, so the padding keeps the focus ring whole and the negative margin takes that room back out of
 * the layout. The ring stays outside the tab: in dark mode it is the same colour as the active tab.
 */
export function TabsList({ className, ...props }: ComponentProps<typeof RTabs.List>) {
  return (
    <RTabs.List
      className={cn('-m-1 flex max-w-[calc(100%+0.5rem)] gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, onMouseDown, ...props }: ComponentProps<typeof RTabs.Trigger>) {
  return (
    <RTabs.Trigger
      className={cn(
        'focus-ring min-h-11 shrink-0 rounded-lg px-3.5 md:min-h-9 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-accent data-[state=active]:text-accent-foreground',
        className,
      )}
      onMouseDown={(event) => {
        // Radix focuses the tab from script on mouse down, and browsers give script focus the keyboard
        // ring. Focusing first without the ring makes that call a no-op. The condition is Radix's own:
        // any other press must not focus, because focusing a tab selects it.
        if (event.button === 0 && !event.ctrlKey) event.currentTarget.focus({ focusVisible: false });
        onMouseDown?.(event);
      }}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof RTabs.Content>) {
  return <RTabs.Content className={cn('focus-ring mt-4', className)} {...props} />;
}
