import type { Permission } from '@yap/shared';
import { canSeeMoney, hasPermission } from './context';

function hide<T extends object>(rows: T[], fields: (keyof T)[], allowed: boolean): T[] {
  if (allowed) return rows;
  return rows.map((row) => {
    const copy = { ...row };
    for (const field of fields) (copy as Record<keyof T, unknown>)[field] = null;
    return copy;
  });
}

/** Null out money fields unless the caller may see them (CLAUDE.md rule 7). */
export const hideMoney = <T extends object>(rows: T[], fields: (keyof T)[], domain?: Permission): T[] =>
  hide(rows, fields, canSeeMoney(domain));

/** Null out personal data unless the caller holds pii.view (CLAUDE.md rule 8). */
export const hidePii = <T extends object>(rows: T[], fields: (keyof T)[]): T[] =>
  hide(rows, fields, hasPermission('pii.view' as Permission));
