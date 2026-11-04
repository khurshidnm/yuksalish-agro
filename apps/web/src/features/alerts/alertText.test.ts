import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '@/lib/i18n';
import { alertText } from './alertText';
import type { Alert } from './types';

const alert = (over: Partial<Alert>): Alert => ({
  id: '1',
  source: 'rule',
  ruleKey: 'sick_animals',
  severity: 'attention',
  status: 'open',
  title: 'Stored title',
  body: 'Stored body',
  data: {},
  link: null,
  lastSeenAt: '2026-11-04T07:00:00Z',
  createdAt: '2026-11-04T07:00:00Z',
  acknowledgedAt: null,
  ...over,
});

const text = (a: Alert) => alertText(a, i18n.t.bind(i18n));

describe('alertText', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it("uses the reader's language for a known rule", async () => {
    expect(text(alert({ data: { count: 3 } })).title).toBe('Sick animals: 3');
    await i18n.changeLanguage('ru');
    expect(text(alert({ data: { count: 3 } })).title).toBe('Больных животных: 3');
    await i18n.changeLanguage('uz');
    expect(text(alert({ data: { count: 3 } })).title).toBe('Kasal hayvonlar: 3 bosh');
    await i18n.changeLanguage('uz-Cyrl');
    expect(text(alert({ data: { count: 3 } })).title).toBe('Касал ҳайвонлар: 3 бош');
  });

  it('keeps the stored text for rules it does not know', () => {
    expect(text(alert({ ruleKey: 'from_some_device' }))).toEqual({ title: 'Stored title', body: 'Stored body' });
  });

  it('keeps the stored text when values are missing, rather than showing blanks', () => {
    expect(text(alert({ data: {} })).title).toBe('Stored title');
  });

  it('localises category names in every language', async () => {
    const budget = alert({
      ruleKey: 'budget_overrun',
      data: { category: { uz: 'Ozuqa', ru: 'Корма', en: 'Feed' }, percent: 112, month: '2026-11' },
    });
    expect(text(budget).title).toBe('Feed: over budget');
    await i18n.changeLanguage('ru');
    expect(text(budget).title).toBe('Корма: бюджет превышен');
    await i18n.changeLanguage('uz-Cyrl');
    expect(text(budget).title).toBe('Озуқа: бюджетдан ошди');
  });

  it('follows the wording the rule chose for this state', () => {
    const expired = alert({
      ruleKey: 'document_expiring',
      data: { title: 'Permit', date: '2026-10-29', textKey: 'document_expired' },
    });
    expect(text(expired).title).toBe('Document expired: Permit');
  });

  it('keeps the reporter\'s own words when a rule has only a title', async () => {
    await i18n.changeLanguage('ru');
    const sick = alert({ ruleKey: 'sick_report', body: 'Oqsoqlanyapti', data: { tag: 'YA-0104', note: 'Oqsoqlanyapti' } });
    expect(text(sick)).toEqual({ title: 'Больное животное: YA-0104', body: 'Oqsoqlanyapti' });
  });

  it('names device events from the cameras dictionary', async () => {
    const event = (eventType: string) => alert({ ruleKey: 'device_event', body: null, data: { deviceName: 'K1', eventType } });
    expect(text(event('camera.smoke')).title).toBe('K1: Signs of smoke');
    expect(text(event('camera.alien_landing')).title).toBe('K1: camera.alien_landing');
    await i18n.changeLanguage('ru');
    expect(text(event('fire')).title).toBe('K1: Признак пожара');
  });

  it('words an AI alert from the ai dictionary, with the values of its finding', () => {
    const ai = alert({
      source: 'ai',
      ruleKey: 'ai.mortality_spike',
      data: { insightId: 'x', confidence: 0.9, insightKey: 'mortality_spike', i18n: { dead: 4, expected: 1 } },
    });
    expect(text(ai).title).toBe('Sharp rise in deaths');
    expect(text(ai).body).toContain('4 head died');
  });

  it('keeps the stored text for an AI alert raised before it carried its values', () => {
    const old = alert({ source: 'ai', ruleKey: 'ai.mortality_spike', data: { insightId: 'x', confidence: 0.9 } });
    expect(text(old)).toEqual({ title: 'Stored title', body: 'Stored body' });
  });

  it('formats dates and units for reading', () => {
    const batch = alert({
      ruleKey: 'batch_expiring',
      data: { item: 'Vaksina', date: '2026-11-20', qty: 5, unit: 'dose' },
    });
    const { body } = text(batch);
    expect(body).not.toContain('2026-11-20');
    expect(body).toContain('5 dose');
  });
});
