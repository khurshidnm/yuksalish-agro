import { api } from '@/lib/api';
import { apiOptions, type ComboboxOption } from '@/components/ui';
import i18n from '@/lib/i18n';

export const BREEDING_PATH = '/livestock/breeding';
export const LAMBINGS_PATH = '/livestock/lambings';
export const HEALTH_PATH = '/livestock/health';
/** Records change animal statuses and herd counts, so these lists go stale together. */
export const ANIMALS_PATH = '/livestock/animals';

interface AnimalLookup {
  id: string;
  tag: string;
  category: string;
}

interface Named {
  id: string;
  name: string;
}

interface ItemLookup extends Named {
  unit: string;
}

interface EmployeeLookup extends Named {
  position: string;
}

interface HerdLookup extends Named {
  headCount: number;
}

export const animalOptions = (params?: { sex?: string; category?: string }) =>
  apiOptions<AnimalLookup>(
    `${ANIMALS_PATH}/lookup`,
    (a) => ({ value: a.id, label: a.tag, hint: i18n.t(`enums:animalCategory.${a.category}`) }),
    params,
  );

export const herdOptions = () =>
  apiOptions<HerdLookup>('/livestock/herds/lookup', (h) => ({
    value: h.id,
    label: h.name,
    hint: i18n.t('vet:common.head', { count: h.headCount }),
  }));

export const warehouseOptions = () => apiOptions<Named>('/inventory/warehouses/lookup', (w) => ({ value: w.id, label: w.name }), { type: 'vet' });

export const employeeOptions = () => apiOptions<EmployeeLookup>('/hr/employees/lookup', (e) => ({ value: e.id, label: e.name, hint: e.position }));

const toItem = (row: ItemLookup): ComboboxOption => ({ value: row.id, label: row.name, hint: i18n.t(`enums:unit.${row.unit}`), raw: row });

/** Drugs and vaccines are separate categories, and a vet picks from both. */
export async function drugOptions(search: string): Promise<ComboboxOption[]> {
  const [drugs, vaccines] = await Promise.all(
    ['vet_drug', 'vaccine'].map((category) => api.list<ItemLookup>('/inventory/items/lookup', { category, search })),
  );
  return [...drugs.data, ...vaccines.data].map(toItem);
}

/** Pairs a client key with one submit, so a double tap or a retry on bad signal records once. */
export function newRequestKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
