import { api } from '@/lib/api';
import { apiOptions, type ComboboxOption } from '@/components/ui';
import i18n from '@/lib/i18n';

export const BREEDING_PATH = '/livestock/breeding';
export const LAMBINGS_PATH = '/livestock/lambings';
export const HEALTH_PATH = '/livestock/health';
export const DESK_PATH = '/livestock/lambing-desk';
export const SCANS_PATH = '/livestock/scans';
export const LAMBS_PATH = '/livestock/lambs';
export const PENS_PATH = '/livestock/pens';
/** Records change animal statuses and herd counts, so these lists go stale together. */
export const ANIMALS_PATH = '/livestock/animals';
/** What a scan, a care record or a pen stay makes stale. */
export const DESK_STALE = [DESK_PATH, SCANS_PATH, LAMBS_PATH, PENS_PATH, BREEDING_PATH, ANIMALS_PATH];

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

export const animalOptions = (params?: { sex?: string; category?: string; forBreeding?: string }) =>
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

export const CONDITION_PATH = '/livestock/condition-scores';
export const FAT_TAIL_PATH = '/livestock/fat-tail';
export const GRADINGS_PATH = '/livestock/gradings';
export const EWES_PATH = '/livestock/ewes';
export const CULLING_PATH = '/livestock/culling';
/** What a condition score, a grading or a cull mark makes stale: the score, the lists and the animal's card. */
export const APPRAISAL_STALE = [CONDITION_PATH, FAT_TAIL_PATH, GRADINGS_PATH, EWES_PATH, CULLING_PATH, ANIMALS_PATH];
