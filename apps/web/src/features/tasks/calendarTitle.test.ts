import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '@/lib/i18n';
import { calendarItemTitle } from './calendarTitle';
import type { CalendarItem, CalendarKind } from './types';

const item = (kind: CalendarKind, over: Partial<CalendarItem> = {}): CalendarItem => ({
  id: 'x',
  kind,
  date: '2026-11-21',
  endDate: null,
  title: null,
  params: {},
  link: null,
  division: null,
  responsibleUserId: null,
  responsibleName: null,
  status: null,
  priority: null,
  editableId: null,
  ...over,
});

const t = i18n.getFixedT('en', 'tasks');

describe('calendarItemTitle', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('keeps a real title', () => {
    expect(calendarItemTitle(item('task', { title: 'Feed the herd' }), t)).toBe('Feed the herd');
  });

  it('builds automatic titles from facts', () => {
    expect(calendarItemTitle(item('lambing', { params: { count: 2 } }), t)).toBe('Lambing expected: 2');
    expect(calendarItemTitle(item('field_operation', { params: { operation: 'irrigation', field: '7' } }), t)).toBe(
      'Irrigation: field 7',
    );
  });

  it('names a vaccination by its plan or drug', () => {
    const named = item('vaccination', { params: { name: 'Pox', type: 'vaccination', count: 1 } });
    expect(calendarItemTitle(named, t)).toBe('Vaccination: Pox');
  });

  it('never leaves a blank where the name should be', () => {
    const unnamed = item('vaccination', { params: { name: null, type: 'quarantine', count: 1 } });
    expect(calendarItemTitle(unnamed, t)).toBe(i18n.t('enums:healthRecordType.quarantine', { lng: 'en' }));
  });

  it('does not call a deworming a vaccination', () => {
    const title = calendarItemTitle(item('vaccination', { params: { name: 'Albendazol', type: 'deworming', count: 1 } }), t);
    expect(title).toBe(`${i18n.t('enums:healthRecordType.deworming', { lng: 'en' })}: Albendazol`);
  });
});
