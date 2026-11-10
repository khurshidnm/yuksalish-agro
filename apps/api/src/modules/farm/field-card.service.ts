import { canSeeMoney } from '../../core/context';
import { fieldCosts } from '../finance/summary';
import { fieldFertiliser } from './fertiliser.service';
import { currentPlans, getField, rotationHistory } from './fields.service';
import { listGroundwater } from './groundwater.service';
import { listSoil } from './soil.service';

type Rotation = Awaited<ReturnType<typeof rotationHistory>>;

/**
 * Cost per ton for each harvested crop (spec 6.1.7). Cost comes from the finance engine, and is
 * money, so it is null for roles without finance.view (CLAUDE.md rule 7).
 */
async function withCostPerTon(rotation: Rotation) {
  const costs = new Map<string, number | null>();
  if (canSeeMoney()) {
    const harvested = rotation.filter((row) => row.harvestT);
    for (const seasonId of new Set(harvested.map((row) => row.seasonId))) {
      // A harvest with no recorded costs has an unknown cost, not a free ton (CLAUDE.md rule 5).
      for (const row of await fieldCosts(seasonId)) costs.set(row.cropPlanId, row.costPerTon || null);
    }
  }
  return rotation.map((row) => ({ ...row, costPerTon: costs.get(row.planId) ?? null }));
}

export async function getFieldCard(id: string) {
  const field = await getField(id);
  const plans = await currentPlans([id]);
  const currentCrop = plans.get(id) ?? null;
  return {
    ...field,
    currentCrop,
    rotation: await withCostPerTon(await rotationHistory(id)),
    soilAnalyses: await listSoil(id),
    fertiliser: await fieldFertiliser(id, currentCrop),
    groundwater: await listGroundwater(id),
  };
}
