/** The phone menu in the header: a native <details>, so it opens before any script has loaded. */
const OPEN_MENUS = 'header details[open]';

type Target = (Node & { closest?: (selector: string) => unknown }) | null;

/**
 * Whether a click should close an open menu: a tap anywhere else, or a link inside it that was
 * followed. A tap on the menu's own button is left to the browser, which toggles it.
 */
export function clickCloses(menu: { contains(node: Node | null): boolean }, target: Target): boolean {
  if (!target || !menu.contains(target)) return true;
  return typeof target.closest === 'function' && Boolean(target.closest('a[href]'));
}

/**
 * Closes the menu once it has done its job, which a bare <details> never does: after a section is
 * picked, on a tap outside it, and on Escape. Without this the open panel covers the section the
 * visitor asked for. Returns the function that removes the listeners.
 */
export function closeMenuWhenDone(root: Document = document): () => void {
  const openMenus = () => Array.from(root.querySelectorAll<HTMLDetailsElement>(OPEN_MENUS));
  const onClick = (event: MouseEvent) => {
    for (const menu of openMenus()) {
      if (clickCloses(menu, event.target as Target)) menu.open = false;
    }
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    for (const menu of openMenus()) {
      menu.open = false;
      menu.querySelector('summary')?.focus();
    }
  };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('keydown', onKey);
  };
}
