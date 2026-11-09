import { Tabs as RTabs } from 'radix-ui';
import { type ComponentProps, useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export const Tabs = RTabs.Root;

/** Room kept between a revealed tab and the strip's edge, clear of the fade. */
const EDGE_PX = 40;

/** Scrolls the strip sideways, never the page, until the active tab shows whole. */
function revealActive(list: HTMLElement, smooth: boolean) {
  if (list.scrollWidth <= list.clientWidth) return;
  const tab = list.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
  if (!tab) return;
  const box = list.getBoundingClientRect();
  const rect = tab.getBoundingClientRect();
  const delta = rect.left < box.left + EDGE_PX ? rect.left - box.left - EDGE_PX : rect.right > box.right - EDGE_PX ? rect.right - box.right + EDGE_PX : 0;
  if (delta !== 0) list.scrollBy({ left: delta, behavior: smooth ? 'smooth' : 'auto' });
}

/** Marks the sides where tabs are hidden, for the fade (`tabs-scroller` in index.css). */
function markEdges(list: HTMLElement) {
  const max = list.scrollWidth - list.clientWidth;
  list.toggleAttribute('data-more-before', max > 1 && list.scrollLeft > 1);
  list.toggleAttribute('data-more-after', max > 1 && list.scrollLeft < max - 1);
}

/** A link (a stat card, an alert) switched the tab: bring the strip, and the content under it, into view. */
function showStrip(list: HTMLElement) {
  const rect = list.getBoundingClientRect();
  // The sticky top bar, and on phones the bottom navigation, cover the window's edges.
  const bottomBar = window.matchMedia('(min-width: 64rem)').matches ? 0 : 88;
  if (rect.top >= 56 && rect.bottom <= window.innerHeight - bottomBar) return;
  list.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/**
 * Scrolls sideways on phones rather than wrapping or pushing the page wider. A scroller clips on both
 * axes, so the padding keeps the focus ring whole and the negative margin takes that room back out of
 * the layout. The ring stays outside the tab: in dark mode it is the same colour as the active tab.
 * The active tab is always scrolled into the strip, and a side that hides more tabs fades out.
 */
export function TabsList({ className, ref, ...props }: ComponentProps<typeof RTabs.List>) {
  const own = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      own.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  useEffect(() => {
    const list = own.current;
    if (!list) return;
    revealActive(list, false);
    markEdges(list);
    // A press on the strip changes the tab in plain sight; only a change from elsewhere moves the page.
    let pressedAt = 0;
    const onPress = () => {
      pressedAt = Date.now();
    };
    const onScroll = () => markEdges(list);
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => markEdges(list));
    resize?.observe(list);
    const watch = new MutationObserver((records) => {
      const activated = records.some((r) => r.type === 'attributes' && (r.target as HTMLElement).getAttribute('data-state') === 'active');
      const external = activated && Date.now() - pressedAt > 1000;
      // After the router's own scroll reset, which runs in the same commit. Chrome runs one smooth scroll
      // at a time, so when the page is to move, the strip moves at once.
      requestAnimationFrame(() => {
        revealActive(list, activated && !external);
        markEdges(list);
        if (external) showStrip(list);
      });
    });
    watch.observe(list, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
    list.addEventListener('pointerdown', onPress);
    list.addEventListener('keydown', onPress);
    list.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      watch.disconnect();
      resize?.disconnect();
      list.removeEventListener('pointerdown', onPress);
      list.removeEventListener('keydown', onPress);
      list.removeEventListener('scroll', onScroll);
    };
  }, []);

  return (
    <RTabs.List
      ref={setRef}
      className={cn('tabs-scroller -m-1 flex max-w-[calc(100%+0.5rem)] scroll-mt-20 gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)}
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
