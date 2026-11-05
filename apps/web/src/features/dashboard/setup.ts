/** The first-day path of a new farm. Order matters: a receipt needs a warehouse and items, a herd its ration. */
import type { Permission } from '@yap/shared';

export interface SetupStep {
  key: string;
  /** The list that tells whether the step is done. */
  source: string;
  /** Where the step is done. */
  link: string;
  access: Permission;
  /** Rows that are there from the start: the owner counts as a member. */
  given?: number;
}

export const SETUP_STEPS: SetupStep[] = [
  { key: 'accounts', source: '/finance/accounts', link: '/finance/accounts', access: 'finance.create' },
  { key: 'fields', source: '/farm/fields', link: '/farm/fields', access: 'farm.create' },
  { key: 'warehouses', source: '/inventory/warehouses', link: '/inventory/warehouses', access: 'inventory.create' },
  { key: 'items', source: '/inventory/items', link: '/inventory/items', access: 'inventory.create' },
  { key: 'stock', source: '/inventory/movements', link: '/inventory/stock', access: 'inventory.create' },
  { key: 'rations', source: '/feed/rations', link: '/feed/rations', access: 'feed.create' },
  { key: 'herds', source: '/livestock/herds', link: '/livestock/herds', access: 'livestock.create' },
  { key: 'staff', source: '/settings/users', link: '/settings/users', access: 'users.create', given: 1 },
];

export interface SetupProgress {
  open: SetupStep[];
  done: number;
  total: number;
  /** Nothing is left, and every list answered: the checklist need never ask again. */
  finished: boolean;
}

/** `counts` holds a number per step whose list answered. A step that could not be read is neither done nor shown. */
export function setupProgress(steps: SetupStep[], counts: Record<string, number | null>): SetupProgress {
  const known = steps.filter((step) => typeof counts[step.key] === 'number');
  const open = known.filter((step) => (counts[step.key] as number) <= (step.given ?? 0));
  return { open, done: known.length - open.length, total: steps.length, finished: open.length === 0 && known.length === steps.length };
}
