import type { TFunction } from 'i18next';
import type { CalendarItem, CalendarKind } from './types';

/**
 * Tasks and manual events have titles. Automatic items carry facts instead, so that they read
 * correctly in every language.
 */
export function calendarItemTitle(item: CalendarItem, t: TFunction): string {
  if (item.title) return item.title;
  const params = { ...item.params };

  if (item.kind === 'field_operation') params.operation = t(`enums:operationType.${String(params.operation)}`);

  // The veterinary source covers anything with a next date: a repeat dose, the end of a quarantine.
  // Plan and drug are both optional on a record, so the record type is what is always known.
  if (item.kind === 'vaccination') {
    const type = String(params.type);
    const label = t(`enums:healthRecordType.${type}`);
    if (!params.name) return label;
    // A plan's name already says what is done ("Gijjaga qarshi ishlov"): a prefix would repeat it, or
    // call a deworming a vaccination. Only a drug name needs one.
    if (params.fromPlan === true) return String(params.name);
    return type === 'vaccination' ? t('calendar.item.vaccination', params) : `${label}: ${String(params.name)}`;
  }

  return t(`calendar.item.${item.kind}`, params);
}

/** Kinds whose sentence is too long for a month cell: the chip leads with the fact instead. */
const CHIP_KINDS: ReadonlySet<CalendarKind> = new Set(['lambing', 'loan', 'contract', 'document', 'state_report', 'staff_contract']);

/**
 * The text of a month-view chip, about 150 px wide: "Qo'zilash: 15" rather than a sentence whose
 * count is cut off. The full sentence stays in the agenda and the chip's tooltip.
 */
export function calendarChipTitle(item: CalendarItem, t: TFunction): string {
  if (item.title || !CHIP_KINDS.has(item.kind)) return calendarItemTitle(item, t);
  return t(`calendar.chip.${item.kind}`, item.params);
}
