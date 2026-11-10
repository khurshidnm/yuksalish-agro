/**
 * Exact lookup of stock items by a scanned code: the barcode, the item's own code (SKU), or the
 * record id that a label printed here carries when the item has neither (`itemLabelCode`). Letter
 * case and spaces do not count, and a 12-digit UPC-A equals its 13-digit EAN; nothing looser does.
 * Barcodes are not unique in the table, so a code two items carry returns both.
 */
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { SCAN_CODE_MAX, matchScan, normalizeScan, scanKeyVariants } from '@yap/shared/formulas/scan-code';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { badRequest } from '../../core/errors';

const { items } = schema;

export const itemByCodeQuery = z.object({ code: z.string().trim().min(1).max(500) });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyOf = (column: AnyPgColumn) => sql`upper(regexp_replace(${column}, '\\s+', '', 'g'))`;

/** The same fields the item dropdown gives, without stock or any price. */
export async function itemsByCode(raw: string) {
  const code = normalizeScan(raw);
  if (code === null) throw badRequest('SCAN_UNREADABLE', `The scan holds no code of at most ${SCAN_CODE_MAX} characters`);
  const keys = scanKeyVariants(code);
  const rows = await tx()
    .select({
      id: items.id,
      name: items.name,
      category: items.category,
      unit: items.unit,
      defaultWarehouseId: items.defaultWarehouseId,
      sku: items.sku,
      barcode: items.barcode,
      active: items.active,
    })
    .from(items)
    .where(
      and(
        eq(items.farmId, ctx().farmId),
        or(
          inArray(keyOf(items.barcode), keys),
          inArray(keyOf(items.sku), keys),
          eq(items.barcode, code),
          eq(items.sku, code),
          UUID.test(code) ? eq(items.id, code.toLowerCase()) : undefined,
        ),
      ),
    )
    .orderBy(asc(items.name), asc(items.id));

  // One order for every item: barcode, then its own code, then the id on a label printed here.
  const candidates = rows.flatMap((row) => [
    ...(row.barcode ? [{ value: row.barcode, item: row, matchedBy: 'barcode' }] : []),
    ...(row.sku ? [{ value: row.sku, item: row, matchedBy: 'sku' }] : []),
    { value: row.id, item: row, matchedBy: 'id' },
  ]);
  return matchScan(code, candidates).map((hit) => ({
    ...hit.item,
    matchedBy: candidates.find((c) => c.item === hit.item && c.value === hit.value)!.matchedBy,
    exact: hit.exact,
  }));
}
