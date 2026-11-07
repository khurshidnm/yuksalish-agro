import { readFileSync } from 'node:fs';
import { DEFAULT_ROLE_PERMISSIONS, type RoleKey } from '@yap/shared';
import { describe, expect, it, vi } from 'vitest';
import { linkOpens } from './canOpen';
import type { RouteAccess } from './guards';

// sonner injects a stylesheet on import, and these tests have no real DOM.
vi.mock('sonner', () => ({ toast: {} }));

const access = (role: RoleKey, over: Partial<RouteAccess> = {}): RouteAccess => {
  const held = new Set<string>(DEFAULT_ROLE_PERMISSIONS[role]);
  return { can: (permission) => held.has(permission), moduleEnabled: () => true, isPlatformAdmin: false, ...over };
};

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Every page a rule alert can point at, from the API's own source. `${id}` stands for any id. */
const ruleLinks = [...read('../../../api/src/modules/alerts/rules.ts').matchAll(/link: [`']([^`']+)[`']/g)].map(([, link]) => link.replaceAll(/\$\{[^}]+\}/g, 'x'));

describe('linkOpens', () => {
  it('every link a rule raises leads to a real page: the owner can open them all', () => {
    expect(ruleLinks.length).toBeGreaterThan(20);
    expect(ruleLinks.filter((link) => !linkOpens(link, access('owner')))).toEqual([]);
  });

  it('an investor is offered none of the pages alerts point at, since those are closed to them', () => {
    expect(ruleLinks.filter((link) => linkOpens(link, access('investor')))).toEqual([]);
  });

  it('an investor keeps the pages that are theirs', () => {
    for (const link of ['/', '/alerts', '/notifications', '/reports?tab=investor&month=2026-11']) {
      expect(linkOpens(link, access('investor'))).toBe(true);
    }
  });

  it('reads the page from a link with a query string or an id', () => {
    expect(linkOpens('/finance/debts?tab=receipts', access('accountant'))).toBe(true);
    expect(linkOpens('/finance/debts?tab=receipts', access('shepherd'))).toBe(false);
    expect(linkOpens('/assets/123', access('mechanic'))).toBe(true);
    expect(linkOpens('/assets/123', access('investor'))).toBe(false);
  });

  it('does not offer a switched-off module, even to its owner', () => {
    const noCameras = access('owner', { moduleEnabled: (module) => module !== 'cameras' });
    expect(linkOpens('/cameras', access('owner'))).toBe(true);
    expect(linkOpens('/cameras', noCameras)).toBe(false);
  });

  it('does not offer a page that does not exist', () => {
    expect(linkOpens('/no/such/page', access('owner'))).toBe(false);
  });

  it('keeps platform pages for the platform admin', () => {
    expect(linkOpens('/platform', access('owner'))).toBe(false);
    expect(linkOpens('/platform', access('owner', { isPlatformAdmin: true }))).toBe(true);
  });
});

describe('the approvals alert', () => {
  it('names a tab the journal page really has', () => {
    const tab = /finance\/transactions\?tab=(\w+)/.exec(ruleLinks.join(' '))?.[1];
    expect(tab).toBe('approval');
    expect(read('../features/finance/TransactionsPage.tsx')).toContain(`value: '${tab}'`);
  });
});
