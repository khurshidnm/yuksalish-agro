import i18n from '@/lib/i18n';

/** One list of values serves every species, and its words do not: for cattle an "ewe" is a cow. */
export function categoryLabel(category: string, speciesKey: string | null | undefined): string {
  return i18n.t(`enums:animalCategoryBySpecies.${speciesKey}.${category}`, { defaultValue: i18n.t(`enums:animalCategory.${category}`) });
}
