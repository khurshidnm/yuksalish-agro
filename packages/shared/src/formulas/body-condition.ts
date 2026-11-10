/**
 * Body condition score (BCS) of sheep: how much fat and muscle a hand finds over the loin, behind
 * the last rib. Pure functions, so the animal card, the herd screen and the alert cannot disagree.
 *
 * The scale, 1 (emaciated) to 5 (very fat) in half steps, is Russel, Doney and Gunn (1969),
 * "Subjective assessment of body fat in live sheep", Journal of Agricultural Science 72:451-454.
 *
 * A fat-tailed breed keeps much of its fat in the tail, so a loin score reads differently than in
 * the thin-tailed breeds the scale was drawn up on. Nothing here is a breed target.
 */
import { diffDays } from '../dates';

/** The scale itself (Russel et al. 1969). */
export const BODY_CONDITION_SCALE = { min: 1, max: 5, step: 0.5 } as const;

/** Every score a person can give: 1, 1.5, ... 5. */
export const BODY_CONDITION_STEPS: readonly number[] = Array.from(
  { length: Math.round((BODY_CONDITION_SCALE.max - BODY_CONDITION_SCALE.min) / BODY_CONDITION_SCALE.step) + 1 },
  (_, i) => BODY_CONDITION_SCALE.min + i * BODY_CONDITION_SCALE.step,
);

/**
 * Starting values chosen for this product, not figures from a book and not targets for any breed.
 * A farm's zootechnician should set their own once a season of scoring has shown what fits.
 */
export const BODY_CONDITION_RULES = {
  /** A score at or below this counts as thin. */
  thinAtOrBelow: 2,
  /** A herd figure uses each animal's latest score only when it is no older than this many days. */
  recentDays: 60,
  /** The thin-herd alert needs at least this many recently scored animals: three thin ewes of four prove little. */
  alertMinScored: 10,
  /** The thin-herd alert fires when at least this share of the recently scored animals is thin. */
  alertThinShare: 0.25,
} as const;

/** A score on the scale: between 1 and 5 and on a half step. */
export function isBodyConditionScore(score: number): boolean {
  if (!Number.isFinite(score)) return false;
  if (score < BODY_CONDITION_SCALE.min || score > BODY_CONDITION_SCALE.max) return false;
  return Number.isInteger(score / BODY_CONDITION_SCALE.step);
}

export function isThin(score: number): boolean {
  return score <= BODY_CONDITION_RULES.thinAtOrBelow;
}

export interface LatestCondition {
  score: number;
  date: string;
}

export interface HerdCondition {
  /** Animals whose latest score is recent enough to count. */
  scored: number;
  /** Mean of those scores; null when none is recent enough. */
  average: number | null;
  thin: number;
  /** Thin animals as a share of the scored ones, 0 to 1; null when none is scored. */
  thinShare: number | null;
}

/**
 * A herd's condition from each animal's latest score. A score older than `recentDays` says little
 * about today, so it is left out, and with none left the average is null, never 0.
 */
export function herdCondition(latest: LatestCondition[], today: string, recentDays: number = BODY_CONDITION_RULES.recentDays): HerdCondition {
  const recent = latest.filter((s) => {
    const age = diffDays(s.date, today);
    return age >= 0 && age <= recentDays;
  });
  if (recent.length === 0) return { scored: 0, average: null, thin: 0, thinShare: null };
  const thin = recent.filter((s) => isThin(s.score)).length;
  return {
    scored: recent.length,
    average: recent.reduce((sum, s) => sum + s.score, 0) / recent.length,
    thin,
    thinShare: thin / recent.length,
  };
}

/** Does this herd's condition call for the thin-herd alert? */
export function herdIsThin(c: HerdCondition): boolean {
  return c.thinShare !== null && c.scored >= BODY_CONDITION_RULES.alertMinScored && c.thinShare >= BODY_CONDITION_RULES.alertThinShare;
}
