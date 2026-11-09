import { afterEach, describe, expect, it } from 'vitest';
import i18n from '@/lib/i18n';
import { insightText } from './insightText';
import type { Insight } from './types';

const insight = (over: Partial<Insight> & Pick<Insight, 'type' | 'data'>): Insight => ({
  id: '1',
  title: 'Stored title',
  body: 'Stored body',
  confidence: 0.6,
  sources: {},
  containsMoney: false,
  periodFrom: null,
  periodTo: null,
  model: 'statistics',
  decision: 'pending',
  decidedAt: null,
  decisionNote: null,
  outcome: null,
  createdAt: '2026-11-09T05:00:00Z',
  ...over,
});

const lambing = insight({
  type: 'lambing_workload',
  data: { i18n: { ewes: 700, lambs: 840, peakWeek: '08.02.2027', peakEwes: 107, workers: 2, extraFeedT: 25.8 } },
});

const cropPlan = insight({
  type: 'crop_suggestion',
  containsMoney: true,
  data: {
    textKey: 'crop_plan',
    i18n: { plan: '1-dala — Arpa', mix: 'Beda 50%, Arpa 50%', fields: 1, margin: '80 000 000', currency: 'UZS' },
    localized: {
      plan: { uz: '1-dala — Arpa', ru: 'поле 1 — Ячмень', en: 'field 1 — Barley' },
      mix: { uz: 'Beda 50%, Arpa 50%', ru: 'Люцерна 50%, Ячмень 50%', en: 'Alfalfa 50%, Barley 50%' },
    },
  },
});

afterEach(async () => {
  await i18n.changeLanguage('uz');
});

describe('insightText', () => {
  it('writes a fraction the way the reader does, and joins no suffix to a date', async () => {
    await i18n.changeLanguage('uz');
    const uz = insightText(lambing, i18n).body;
    expect(uz).toContain("qo'shimcha 25,8 t ozuqa");
    expect(uz).toContain('08.02.2027 kuni boshlanadi');
    expect(uz).not.toContain(' dan ');
    await i18n.changeLanguage('ru');
    expect(insightText(lambing, i18n).body).toContain('25,8 т корма');
    expect(insightText(lambing, i18n).body).toContain('понадобится работников: 2');
    await i18n.changeLanguage('en');
    expect(insightText(lambing, i18n).body).toContain('25.8 t of feed');
  });

  it('names the crops in the reader language', async () => {
    await i18n.changeLanguage('ru');
    const ru = insightText(cropPlan, i18n).body;
    expect(ru).toContain('поле 1 — Ячмень');
    expect(ru).toContain('Люцерна 50%');
    expect(ru).not.toContain('Beda');
    // The sum stays on one line on a phone.
    expect(ru).toContain('80 000 000 сум');
    await i18n.changeLanguage('en');
    expect(insightText(cropPlan, i18n).body).toContain('field 1 — Barley');
    await i18n.changeLanguage('uz-Cyrl');
    expect(insightText(cropPlan, i18n).body).toContain('1-дала — Арпа');
  });

  it('keeps the stored text when the wording needs a value the finding was stored without', async () => {
    // Stored before the per-head saving was part of the wording.
    const old = insight({
      type: 'feed_cost_saving',
      data: { i18n: { ration: 'R', from: 'A', to: 'B', savingPerDay: '1 000', head: 10, currency: 'UZS' } },
    });
    expect(insightText(old, i18n)).toEqual({ title: 'Stored title', body: 'Stored body' });
    // An insight with no values at all keeps its text too.
    expect(insightText(insight({ type: 'executive_summary', data: {} }), i18n).title).toBe('Stored title');
  });
});
