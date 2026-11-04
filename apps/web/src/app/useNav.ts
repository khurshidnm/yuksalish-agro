import { useMemo } from 'react';
import { useAuth, useCan, useModuleEnabled } from '@/lib/auth';
import { NAV, type NavItem, type NavSection, bottomKeys } from './nav';

const MAX_BOTTOM_ITEMS = 4;

/** The menu as this user may see it: their permissions and their tenant's modules. */
export function useVisibleNav(): { sections: NavSection[]; bottom: NavItem[] } {
  const { session } = useAuth();
  const can = useCan();
  const moduleEnabled = useModuleEnabled();
  const isPlatformAdmin = Boolean(session?.user.isPlatformAdmin);
  const hasTenant = Boolean(session?.tenant);

  return useMemo(() => {
    const visible = (item: NavItem) => {
      if (item.platformOnly) return isPlatformAdmin;
      if (!hasTenant) return false;
      const needed = item.permission === undefined ? [] : [item.permission].flat();
      if (needed.length > 0 && !needed.some(can)) return false;
      const module = item.module ?? needed[0]?.split('.')[0];
      return module ? moduleEnabled(module) : true;
    };
    const sections = NAV.map((section) => ({ ...section, items: section.items.filter(visible) })).filter((section) => section.items.length > 0);
    const flat = sections.flatMap((section) => section.items);
    const bottom = bottomKeys(session?.role?.key)
      .map((key) => flat.find((item) => item.key === key))
      .filter((item): item is NavItem => Boolean(item))
      .slice(0, MAX_BOTTOM_ITEMS);
    return { sections, bottom };
  }, [session, can, moduleEnabled, isPlatformAdmin, hasTenant]);
}
