import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { headlineTiles } from './headline';
import type { BlockKey, CropsData, DashboardData, FeedData, LivestockData, StaffData } from './types';

vi.mock('@/lib/i18n', () => ({ default: { language: 'uz', t: (key: string) => key } }));
// Tests here run without a DOM, and this library touches `document` on import.
vi.mock('sonner', () => ({ toast: {}, Toaster: () => null }));

const t = ((key: string) => key) as unknown as TFunction;
const link = (path: string) => path;

const livestock = {
  total: 500,
  byCategory: { ewe: 500 },
  byStatus: {},
  pregnant: 495,
  sick: 4,
  quarantine: 1,
  lambing: { weeks: [], totalEwes: 500, overdue: 0, expectedLambs: null, next7Days: 0, nextDate: '2027-02-07' },
  mortality: { dead: 0, percent: 0 },
  weightTrend: [],
} satisfies LivestockData;

const feed = {
  items: [],
  limiting: { itemId: 'i', name: 'Beda', days: 9.5, basis: 'actual' },
  avgDailyKg: 1143,
  consumption: [],
  lowStockCount: 1,
  lowStock: [],
} satisfies FeedData;

const crops = {
  status: { sown: 4, irrigated: 2, harvested: 0, total: 5 },
  overdueCount: 1,
  overdue: [],
  harvest: { plannedT: 363, actualT: 0 },
  weather: [],
} satisfies CropsData;

const staff = { attendance: { present: 9, total: 13 }, tasks: { open: 7, overdue: 1, doneToday: 1 } } satisfies StaffData;

function dashboard(order: BlockKey[], blocks: DashboardData['blocks']): DashboardData {
  return { asOf: '2026-11-04', order, blocks };
}

const ok = <T,>(data: T) => ({ status: 'ok' as const, data });

describe('headlineTiles', () => {
  it('gives the main block in full, then the lead figure of every other block', () => {
    const data = dashboard(['livestock', 'feed', 'crops', 'staff'], {
      livestock: ok(livestock),
      feed: ok(feed),
      crops: ok(crops),
      staff: ok(staff),
    });
    expect(headlineTiles(data, t, link).map((tile) => tile.key)).toEqual(['head', 'lambing', 'unwell', 'deaths', 'days', 'sown', 'present']);
  });

  it('follows the reader\'s order, so another role leads with another block', () => {
    const data = dashboard(['crops', 'livestock'], { crops: ok(crops), livestock: ok(livestock) });
    expect(headlineTiles(data, t, link)[0].key).toBe('sown');
  });

  it('skips blocks with no tiles, so the alerts block never leaves the main slot empty', () => {
    const data = dashboard(['alerts', 'feed'], { alerts: { status: 'unavailable', data: null }, feed: ok(feed) });
    expect(headlineTiles(data, t, link).map((tile) => tile.key)).toEqual(['days', 'low', 'daily']);
  });

  it('leaves out a block that failed instead of showing empty tiles', () => {
    const data = dashboard(['livestock', 'feed'], { livestock: { status: 'unavailable', data: null }, feed: ok(feed) });
    expect(headlineTiles(data, t, link).map((tile) => tile.key)).toEqual(['days', 'low', 'daily']);
  });

  it('keeps a missing figure as null, so the tile can say so rather than show zero', () => {
    const data = dashboard(['feed'], { feed: ok({ ...feed, limiting: null, avgDailyKg: null }) });
    const tiles = headlineTiles(data, t, link);
    expect(tiles.find((tile) => tile.key === 'days')?.value).toBeNull();
    expect(tiles.find((tile) => tile.key === 'daily')?.value).toBeNull();
  });

  it('leaves a tile unlinked when the reader could not open its page', () => {
    const data = dashboard(['livestock'], { livestock: ok(livestock) });
    expect(headlineTiles(data, t, () => undefined).every((tile) => tile.to === undefined)).toBe(true);
  });
});
