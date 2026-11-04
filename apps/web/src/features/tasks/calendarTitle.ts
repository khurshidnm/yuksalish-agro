import type { TFunction } from 'i18next';
import type { CalendarItem } from './types';

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
    return type === 'vaccination' ? t('calendar.item.vaccination', params) : `${label}: ${String(params.name)}`;
  }

  return t(`calendar.item.${item.kind}`, params);
}
