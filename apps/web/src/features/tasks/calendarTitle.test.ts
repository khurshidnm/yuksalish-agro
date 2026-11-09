import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '@/lib/i18n';
import { calendarChipTitle, calendarItemTitle } from './calendarTitle';
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
    expect(calendarItemTitle(item('lambing', { params: { count: 2 } }), t)).toBe('Lambing expected: 2 head');
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

  it("shows a plan's name on its own: it already says what is done", () => {
    // Recorded as a vaccination, but the plan is a deworming: no "Vaccination:" in front of it.
    const plan = item('vaccination', { params: { name: 'Deworming (spring)', fromPlan: true, type: 'vaccination', count: 700 } });
    expect(calendarItemTitle(plan, t)).toBe('Deworming (spring)');
    const repeated = item('vaccination', { params: { name: 'Pox vaccination', fromPlan: true, type: 'vaccination', count: 1 } });
    expect(calendarItemTitle(repeated, t)).toBe('Pox vaccination');
  });

  it('gives month chips the fact first, and keeps the sentence elsewhere', () => {
    expect(calendarChipTitle(item('lambing', { params: { count: 15 } }), t)).toBe('Lambing: 15');
    expect(calendarChipTitle(item('contract', { params: { number: 'YS-2026/14', counterparty: 'Agro LLC' } }), t)).toBe('Contract: YS-2026/14');
    expect(calendarChipTitle(item('staff_contract', { params: { name: 'Rustam S.' } }), t)).toBe('Employment contract: Rustam S.');
    expect(calendarChipTitle(item('task', { title: 'Feed the herd' }), t)).toBe('Feed the herd');
    expect(calendarItemTitle(item('staff_contract', { params: { name: 'Rustam S.' } }), t)).toBe('Employment contract ends: Rustam S.');
  });

  it('counts lambing ewes in Russian with the right plural', () => {
    const ru = i18n.getFixedT('ru', 'tasks');
    expect(calendarItemTitle(item('lambing', { params: { count: 1 } }), ru)).toBe('Ожидаемый окот: 1 голова');
    expect(calendarItemTitle(item('lambing', { params: { count: 3 } }), ru)).toBe('Ожидаемый окот: 3 головы');
    expect(calendarItemTitle(item('lambing', { params: { count: 15 } }), ru)).toBe('Ожидаемый окот: 15 голов');
  });
});
