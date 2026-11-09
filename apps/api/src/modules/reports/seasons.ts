/**
 * The season a season report reads. There is no "all seasons": every crop report adds up one
 * season's plans, so an empty choice must not read "all" on screen while the figures are for one.
 * The engine fills the empty choice in here and names it, on screen and in every export.
 */
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { currentSeason } from '../crops/seasons.service';
import type { SeasonDefault } from './types';

const { cropPlans, harvests, seasons } = schema;

export interface SeasonChoice {
  id: string;
  name: string;
}

async function seasonById(id: string): Promise<SeasonChoice | null> {
  const [row] = await tx()
    .select({ id: seasons.id, name: seasons.name })
    .from(seasons)
    .where(and(eq(seasons.id, id), eq(seasons.farmId, ctx().farmId)));
  return row ?? null;
}

/** The newest season with a harvest in. A yield report on a crop still in the ground is all zeros. */
async function latestHarvestedSeason(): Promise<SeasonChoice | null> {
  const farm = ctx().farmId;
  const [row] = await tx()
    .select({ id: seasons.id, name: seasons.name })
    .from(seasons)
    .innerJoin(cropPlans, eq(cropPlans.seasonId, seasons.id))
    .innerJoin(harvests, eq(harvests.cropPlanId, cropPlans.id))
    .where(and(eq(seasons.farmId, farm), eq(harvests.farmId, farm)))
    .groupBy(seasons.id, seasons.name, seasons.startDate)
    .orderBy(desc(seasons.startDate))
    .limit(1);
  return row ?? null;
}

/**
 * The chosen season, or the default the filter names: the current season, or for harvest figures
 * the newest season with a harvest (the current one when nothing was ever harvested).
 * `filled` says the report chose it, so the screen can show it as the filter's value.
 */
export async function resolveSeason(
  chosen: string | undefined,
  fallback: SeasonDefault,
): Promise<{ season: SeasonChoice | null; filled: boolean }> {
  if (chosen) return { season: await seasonById(chosen), filled: false };
  const harvested = fallback === 'harvested' ? await latestHarvestedSeason() : null;
  const season = harvested ?? (await currentSeason());
  return { season: season ? { id: season.id, name: season.name } : null, filled: season !== null };
}
