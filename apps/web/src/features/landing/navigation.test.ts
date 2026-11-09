import { describe, expect, it } from 'vitest';
import { landingPath, loginHref } from './paths';
import { clickCloses, closeMenuWhenDone } from './menu';

/** Just enough of the DOM for the menu: these tests run in node. */
interface FakeNode {
  tag: string;
  parent: FakeNode | null;
  href?: string;
}

const el = (tag: string, parent: FakeNode | null = null, href?: string): FakeNode => ({ tag, parent, href });
const within = (root: FakeNode, node: FakeNode | null) => {
  for (let at = node; at; at = at.parent) if (at === root) return true;
  return false;
};
/** What event.target is in a browser: the node, with closest('a[href]'). */
const target = (node: FakeNode) =>
  Object.assign(node, {
    closest: () => {
      for (let at: FakeNode | null = node; at; at = at.parent) if (at.tag === 'a' && at.href) return at;
      return null;
    },
  }) as unknown as Node;

function page() {
  const header = el('header');
  const details = el('details', header);
  const summary = el('summary', details);
  const panel = el('div', details);
  const link = el('a', panel, '#features');
  const label = el('span', link);
  const outside = el('p', el('main'));
  let focused: FakeNode | null = null;
  const menu = {
    open: true,
    contains: (node: Node | null) => within(details, node as unknown as FakeNode),
    querySelector: () => ({ focus: () => void (focused = summary) }),
  };
  const listeners = new Map<string, (event: unknown) => void>();
  const root = {
    querySelectorAll: () => (menu.open ? [menu] : []),
    addEventListener: (type: string, fn: (event: unknown) => void) => void listeners.set(type, fn),
    removeEventListener: (type: string) => void listeners.delete(type),
  };
  return { summary, label, outside, menu, root, listeners, focused: () => focused };
}

describe('the phone menu closes once it has done its job', () => {
  it('closes for a picked link or a tap elsewhere, and leaves its own button to the browser', () => {
    const { summary, label, outside, menu } = page();
    expect(clickCloses(menu, target(label))).toBe(true);
    expect(clickCloses(menu, target(outside))).toBe(true);
    expect(clickCloses(menu, null)).toBe(true);
    expect(clickCloses(menu, target(summary))).toBe(false);
  });

  it('listens on the page: a section picked, then Escape, then nothing once stopped', () => {
    const { label, summary, menu, root, listeners, focused } = page();
    const stop = closeMenuWhenDone(root as unknown as Document);

    listeners.get('click')?.({ target: target(summary) });
    expect(menu.open).toBe(true);
    listeners.get('click')?.({ target: target(label) });
    expect(menu.open).toBe(false);

    menu.open = true;
    listeners.get('keydown')?.({ key: 'Enter' });
    expect(menu.open).toBe(true);
    listeners.get('keydown')?.({ key: 'Escape' });
    expect(menu.open).toBe(false);
    expect(focused()).toBe(summary);

    stop();
    expect(listeners.size).toBe(0);
  });
});

describe('links between the public pages and sign-in', () => {
  it('signs in in the language of the page, and the default page leaves a saved language alone', () => {
    expect(loginHref('ru')).toBe('/login?lang=ru');
    expect(loginHref('en')).toBe('/login?lang=en');
    expect(loginHref('uz-Cyrl')).toBe('/login?lang=uz-Cyrl');
    expect(loginHref('uz')).toBe('/login');
  });

  it('goes back to the public page in the language of the app', () => {
    expect(landingPath('ru')).toBe('/ru');
    expect(landingPath('uz-Cyrl')).toBe('/uz-cyrl');
    expect(landingPath('uz')).toBe('/');
    expect(landingPath('de')).toBe('/');
  });
});
