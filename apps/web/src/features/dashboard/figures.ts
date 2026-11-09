import type { TFunction } from 'i18next';
import { formatNumber, formatQty, intlLocale } from '@/lib/format';
import i18n from '@/lib/i18n';
import type { FeedData, FeedItem, LivestockData } from './types';

/**
 * A month inside a sentence: "Kepak tugaydi: mart 2027". Uzbek and Russian write month names in lower
 * case there; the capital of formatMonth belongs to headings and labels. English keeps its capital.
 */
export function monthInText(month: string, withYear = true): string {
  const names = i18n.t('common:date.months', { returnObjects: true }) as unknown as string[];
  const name = names[Number(month.slice(5, 7)) - 1] ?? '';
  const word = i18n.language === 'en' ? name : name.toLocaleLowerCase(intlLocale());
  return withYear ? `${word} ${month.slice(0, 4)}` : word;
}

/**
 * The lambs to expect. The farm's own lambing record decides once it has one; until then the stated
 * assumption gives a figure that says it is an assumption, so it agrees with the outlook.
 */
export function expectedLambsText(lambing: LivestockData['lambing'], t: TFunction): string {
  if (lambing.expectedLambs !== null) return formatNumber(lambing.expectedLambs, 0);
  if (typeof lambing.assumedLambs === 'number' && typeof lambing.assumedLambsPerEwe === 'number') {
    return t('livestock.lambsAssumed', { value: formatNumber(lambing.assumedLambs, 0), perEwe: formatNumber(lambing.assumedLambsPerEwe, 1) });
  }
  return t('livestock.lambsUnknown');
}

/**
 * Feed issued per day, for the chart. Today counts only once something was issued today, the rule of
 * averageDailyConsumption: in the morning the log is not in yet, and an empty bar would read as nothing fed.
 */
export function consumptionToChart(days: FeedData['consumption'], today: string): FeedData['consumption'] {
  const last = days.at(-1);
  return last && last.date === today && last.qty <= 0 ? days.slice(0, -1) : days;
}

/** Feed in stock that no ration plans and nobody has issued lately: nothing is missing, it is not being used. */
export function feedNotInUse(item: FeedItem): boolean {
  return item.days === null && item.plannedDaily === null && item.actualDaily === null;
}

/** A value axis around the weights, in steps of 5 kg, so a gain of 2 kg is not a flat line on a 0 to 80 axis. */
export function weightDomain(weights: number[]): [number, number] | undefined {
  if (weights.length === 0) return undefined;
  const low = Math.max(0, Math.floor((Math.min(...weights) - 2) / 5) * 5);
  return [low, Math.ceil((Math.max(...weights) + 2) / 5) * 5];
}

/** "+2,3 kg", "−1,5 kg", "0 kg": a change in weight with its sign written out, to one decimal. */
export function signedKg(change: number): string {
  const tenths = Math.round(change * 10);
  const sign = tenths > 0 ? '+' : tenths < 0 ? '−' : '';
  return `${sign}${formatQty(Math.abs(tenths) / 10, 'kg', 1)}`;
}
