import { apiOptions } from '@/components/ui';
import { formatHa } from '@/features/farm/utils';
import { formatQty } from '@/lib/format';

export const PLANS = '/crops/plans';
export const OPERATIONS = '/crops/operations';
export const HARVESTS = '/crops/harvests';
export const TECH_CARDS = '/crops/tech-cards';
export const SEASONS = '/crops/seasons';
export const SUMMARY = '/crops/summary';

/** Everything that changes when field work changes. Stock moves too, so it refreshes as well. */
export const AFFECTED_BY_WORK = [OPERATIONS, HARVESTS, PLANS, SUMMARY, '/crops/plan-fact', '/inventory'];

export interface FieldOption {
  id: string;
  number: string;
  /** Already formatted by the API, number included. */
  name: string;
  areaHa: number;
}

export interface ItemOption {
  id: string;
  name: string;
  category: string;
  unit: string;
  defaultWarehouseId: string | null;
  qtyOnHand: number;
}

export const fieldOptions = apiOptions<FieldOption>(
  '/farm/fields/lookup',
  (f) => ({ value: f.id, label: f.name, hint: formatHa(f.areaHa) }),
  { landUse: 'arable' },
);

export const assetOptions = apiOptions<{ id: string; name: string; inventoryNo: string | null }>('/assets/lookup', (a) => ({
  value: a.id,
  label: a.name,
  hint: a.inventoryNo ?? undefined,
}));

export const employeeOptions = apiOptions<{ id: string; name: string; position: string }>('/hr/employees/lookup', (e) => ({
  value: e.id,
  label: e.name,
  hint: e.position,
}));

export const warehouseOptions = apiOptions<{ id: string; name: string }>('/inventory/warehouses/lookup', (w) => ({
  value: w.id,
  label: w.name,
}));

export const itemOptions = (category?: string) =>
  apiOptions<ItemOption>(
    '/inventory/items/lookup',
    (i) => ({ value: i.id, label: i.name, hint: formatQty(i.qtyOnHand, i.unit) }),
    category ? { category } : undefined,
  );

/** Which stock a type of work draws from. */
export const MATERIAL_CATEGORY: Record<string, string | undefined> = {
  sowing: 'seed',
  fertilizing: 'fertilizer',
  protection: 'chemical',
};

/** The form only asks what this work actually has (spec 7.2). */
export const WORK_FIELDS: Record<string, { machine?: boolean; area?: boolean; materials?: boolean; water?: boolean }> = {
  tillage: { machine: true, area: true },
  sowing: { machine: true, area: true, materials: true },
  irrigation: { water: true },
  fertilizing: { machine: true, area: true, materials: true },
  protection: { machine: true, area: true, materials: true },
  observation: {},
  harvest: { machine: true, area: true },
};
