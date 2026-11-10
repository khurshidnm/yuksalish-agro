/**
 * Ration balancing by nutrients: what a ration supplies against what the herd it feeds needs, and the
 * cheapest mix of chosen feeds that meets the need. Every calculation is in
 * `@yap/shared/formulas/nutrition`; this file only gathers the feeds, the herd and the prices.
 *
 * The balance holds no money, so everyone with `feed.view` reads it. The least-cost mix is built on
 * feed prices and is for people who may see feed cost (rule 7).
 */
import { ANIMAL_ON_FARM_STATUSES, PHYSIOLOGICAL_STATES, round } from '@yap/shared';
import {
  dailyRequirement,
  LEAST_COST_DEFAULTS,
  leastCostRation,
  missingFeedNutrients,
  nutrientBalance,
  PREGNANCY_STAGES,
  rationNutrientSupply,
  requirementInputFor,
  roughageSharePct,
  type BalanceLine,
  type DailyRequirement,
  type FeedNutrientField,
  type MixFeed,
  type NutrientAmounts,
  type RequirementChoice,
} from '@yap/shared/formulas/nutrition';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/client';
import { canSeeMoney, ctx, tx } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { unitCostsPerKg } from './rations.service';

const { animals, herds, items, rationLines, rations, species } = schema;

/**
 * Rations meant for young stock, as in the feed balance: every other ration leaves suckling lambs
 * (categories lamb_male and lamb_female) out.
 */
const YOUNG_STOCK_RATIONS = ['lamb', 'fattening'];

const litter = z.union([z.literal(1), z.literal(2)]);
const choiceFields = {
  stage: z.enum(PREGNANCY_STAGES).optional(),
  litter: litter.optional(),
  gainG: z.number().positive().max(600).optional(),
};

/** The same choice, read from a query string. */
export const balanceQuery = z.object({
  stage: z.enum(PREGNANCY_STAGES).optional(),
  litter: z.coerce.number().pipe(litter).optional(),
  gainG: z.coerce.number().positive().max(600).optional(),
});

const draftLines = z.array(z.object({ itemId: z.uuid(), kgPerHeadDay: z.number().positive().max(100) })).min(1).max(30);

export const balancePreviewInput = z.object({
  /** The ration being edited, so that the herds it feeds set the requirement. Absent for a new ration. */
  rationId: z.uuid().optional(),
  state: z.enum(PHYSIOLOGICAL_STATES),
  lines: draftLines,
  ...choiceFields,
});

export const leastCostInput = z
  .object({
    herdId: z.uuid().optional(),
    state: z.enum(PHYSIOLOGICAL_STATES).optional(),
    weightKg: z.number().positive().max(200).optional(),
    ...choiceFields,
    minRoughageSharePct: z.number().min(0).max(100).optional(),
    feeds: z
      .array(z.object({ itemId: z.uuid(), maxKgPerHeadDay: z.number().positive().max(100).nullish() }))
      .min(1)
      .max(20),
  })
  .refine((v) => v.herdId !== undefined || (v.state !== undefined && v.weightKg !== undefined), {
    message: 'Give a herd, or a state and a weight',
    path: ['herdId'],
  });

type MissingField = FeedNutrientField | 'isRoughage' | 'price';

interface FeedRow {
  id: string;
  name: string;
  category: string;
  dryMatterPct: number | null;
  meMjPerKgDm: number | null;
  crudeProteinPctDm: number | null;
  calciumGPerKgDm: number | null;
  phosphorusGPerKgDm: number | null;
  isRoughage: boolean | null;
}

async function feedRows(itemIds: string[]): Promise<Map<string, FeedRow>> {
  if (itemIds.length === 0) return new Map();
  const rows = await tx()
    .select({
      id: items.id,
      name: items.name,
      category: items.category,
      dryMatterPct: items.dryMatterPct,
      meMjPerKgDm: items.meMjPerKgDm,
      crudeProteinPctDm: items.crudeProteinPctDm,
      calciumGPerKgDm: items.calciumGPerKgDm,
      phosphorusGPerKgDm: items.phosphorusGPerKgDm,
      isRoughage: items.isRoughage,
    })
    .from(items)
    .where(and(eq(items.farmId, ctx().farmId), inArray(items.id, itemIds)));
  return new Map(rows.map((row) => [row.id, row]));
}

const REASONS = ['no_animals', 'no_weight', 'mixed_species', 'species_not_covered', 'state_not_covered'] as const;
type NoRequirementReason = (typeof REASONS)[number];

interface HerdWeight {
  herdId: string;
  herdName: string;
  /** Species key when every animal that eats the ration is of one species. */
  species: string | null;
  mixedSpecies: boolean;
  /** Head that eat the ration: suckling lambs are left out of an adult ration. */
  head: number;
  weighedHead: number;
  avgWeightKg: number | null;
}

/**
 * Head and average recorded weight of the animals that eat each herd's ration. The average is over the
 * animals that have a weight; `weighedHead` says how many that is.
 */
async function herdWeights(herdRows: { herdId: string; herdName: string; rationState: string | null }[]): Promise<HerdWeight[]> {
  if (herdRows.length === 0) return [];
  const notLamb = sql`${animals.category} not in ('lamb_male', 'lamb_female')`;
  const rows = await tx()
    .select({
      herdId: animals.herdId,
      species: species.key,
      head: sql<number>`count(*)`.mapWith(Number),
      weighed: sql<number>`count(${animals.currentWeightKg})`.mapWith(Number),
      weightSum: sql<number>`coalesce(sum(${animals.currentWeightKg}), 0)`.mapWith(Number),
      grownHead: sql<number>`count(*) filter (where ${notLamb})`.mapWith(Number),
      grownWeighed: sql<number>`count(${animals.currentWeightKg}) filter (where ${notLamb})`.mapWith(Number),
      grownWeightSum: sql<number>`coalesce(sum(${animals.currentWeightKg}) filter (where ${notLamb}), 0)`.mapWith(Number),
    })
    .from(animals)
    .innerJoin(species, eq(species.id, animals.speciesId))
    .where(
      and(
        eq(animals.farmId, ctx().farmId),
        inArray(animals.status, [...ANIMAL_ON_FARM_STATUSES]),
        inArray(animals.herdId, herdRows.map((h) => h.herdId)),
      ),
    )
    .groupBy(animals.herdId, species.key);

  return herdRows.map((herd) => {
    const young = herd.rationState !== null && YOUNG_STOCK_RATIONS.includes(herd.rationState);
    const eating = rows
      .filter((row) => row.herdId === herd.herdId)
      .map((row) => (young ? { species: row.species, head: row.head, weighed: row.weighed, weightSum: row.weightSum } : { species: row.species, head: row.grownHead, weighed: row.grownWeighed, weightSum: row.grownWeightSum }))
      .filter((row) => row.head > 0);
    const kinds = [...new Set(eating.map((row) => row.species))];
    const head = eating.reduce((sum, row) => sum + row.head, 0);
    const weighedHead = eating.reduce((sum, row) => sum + row.weighed, 0);
    const weightSum = eating.reduce((sum, row) => sum + row.weightSum, 0);
    return {
      herdId: herd.herdId,
      herdName: herd.herdName,
      species: kinds.length === 1 ? kinds[0] : null,
      mixedSpecies: kinds.length > 1,
      head,
      weighedHead,
      avgWeightKg: weighedHead > 0 ? round(weightSum / weighedHead, 1) : null,
    };
  });
}

function roundAmounts(a: NutrientAmounts): NutrientAmounts {
  const at = (value: number | null, digits: number) => (value === null ? null : round(value, digits));
  return {
    dryMatter: at(a.dryMatter, 3),
    energy: at(a.energy, 2),
    protein: at(a.protein, 1),
    calcium: at(a.calcium, 2),
    phosphorus: at(a.phosphorus, 2),
  };
}

function roundLines(lines: BalanceLine[]): BalanceLine[] {
  return lines.map((line) => {
    const digits = line.nutrient === 'dryMatter' ? 3 : line.nutrient === 'protein' ? 1 : 2;
    return {
      ...line,
      supply: line.supply === null ? null : round(line.supply, digits),
      requirement: line.requirement === null ? null : round(line.requirement, digits),
      coveredPct: line.coveredPct === null ? null : round(line.coveredPct, 1),
    };
  });
}

function requirementView(r: DailyRequirement) {
  return {
    dryMatterKg: round(r.dryMatterKg, 3),
    meMj: round(r.meMj, 2),
    crudeProteinG: round(r.crudeProteinG, 1),
    calciumG: round(r.calciumG, 2),
    phosphorusG: round(r.phosphorusG, 2),
    weightUsedKg: r.weightUsedKg,
    weightClamped: r.weightClamped,
    gainG: round(r.gainG, 0),
    gainClamped: r.gainClamped,
    rows: r.rows,
  };
}

/** The requirement of one animal, or the plain reason there is none. */
function requirementOf(
  state: string,
  choice: RequirementChoice,
  subject: { species: string | null; mixedSpecies: boolean; head: number | null; weightKg: number | null },
): { requirement: DailyRequirement | null; reason: NoRequirementReason | null } {
  if (subject.head === 0) return { requirement: null, reason: 'no_animals' };
  if (subject.mixedSpecies) return { requirement: null, reason: 'mixed_species' };
  if (subject.weightKg === null) return { requirement: null, reason: 'no_weight' };
  const input = requirementInputFor(state, choice);
  if (!input) return { requirement: null, reason: 'state_not_covered' };
  const requirement = dailyRequirement({ ...input, species: subject.species, weightKg: subject.weightKg });
  return requirement ? { requirement, reason: null } : { requirement: null, reason: 'species_not_covered' };
}

async function balanceOf(input: { rationId?: string; state: string; lines: { itemId: string; kgPerHeadDay: number }[] } & RequirementChoice) {
  const feeds = await feedRows([...new Set(input.lines.map((line) => line.itemId))]);
  const fed = input.lines.map((line) => {
    const feed = feeds.get(line.itemId);
    if (!feed) throw notFound('Item');
    return { ...feed, kgPerHeadDay: line.kgPerHeadDay };
  });

  const supply = rationNutrientSupply(fed);
  const missing = fed
    .map((line) => ({ itemId: line.id, itemName: line.name, fields: missingFeedNutrients(line) }))
    .filter((line) => line.fields.length > 0);

  const herdRows = input.rationId
    ? await tx()
        .select({ herdId: herds.id, herdName: herds.name })
        .from(herds)
        .where(and(eq(herds.farmId, ctx().farmId), eq(herds.rationId, input.rationId), eq(herds.status, 'active')))
        .orderBy(asc(herds.name))
    : [];
  const weights = await herdWeights(herdRows.map((herd) => ({ ...herd, rationState: input.state })));
  const choice: RequirementChoice = { stage: input.stage, litter: input.litter, gainG: input.gainG };

  return {
    state: input.state,
    stage: input.state === 'pregnant' ? (input.stage ?? 'late') : null,
    litter: input.state === 'lactating' || (input.state === 'pregnant' && input.stage !== 'early') ? (input.litter ?? 1) : null,
    supply: roundAmounts(supply),
    roughageSharePct: (() => {
      const share = roughageSharePct(fed);
      return share === null ? null : round(share, 1);
    })(),
    /** Feeds whose composition is incomplete, and which figures they lack. */
    missing,
    herds: weights.map((herd) => {
      const { requirement, reason } = requirementOf(input.state, choice, { ...herd, weightKg: herd.avgWeightKg });
      return {
        herdId: herd.herdId,
        herdName: herd.herdName,
        species: herd.species,
        head: herd.head,
        weighedHead: herd.weighedHead,
        avgWeightKg: herd.avgWeightKg,
        reason,
        requirement: requirement ? requirementView(requirement) : null,
        lines: roundLines(nutrientBalance(supply, requirement)),
      };
    }),
  };
}

/** Nutrient balance of a saved ration, for each herd it feeds. */
export async function rationBalance(rationId: string, choice: z.infer<typeof balanceQuery>) {
  const [ration] = await tx()
    .select({ id: rations.id, state: rations.state })
    .from(rations)
    .where(and(eq(rations.id, rationId), eq(rations.farmId, ctx().farmId)));
  if (!ration) throw notFound('Ration');
  const lines = await tx()
    .select({ itemId: rationLines.itemId, kgPerHeadDay: rationLines.kgPerHeadDay })
    .from(rationLines)
    .where(and(eq(rationLines.rationId, rationId), eq(rationLines.farmId, ctx().farmId)));
  return balanceOf({ rationId, state: ration.state, lines, ...choice });
}

/** The same balance for lines that are not saved yet, while a ration is being edited. */
export async function previewBalance(input: z.infer<typeof balancePreviewInput>) {
  return balanceOf(input);
}

/**
 * The cheapest mix of the chosen feeds for a herd, or for a state and a weight. Prices are the value of
 * a kg in stock, as the ration cost uses. Nothing is saved: the person saves the result as a ration.
 */
export async function leastCostMix(input: z.infer<typeof leastCostInput>) {
  if (!canSeeMoney('feed.approve')) throw forbidden(undefined, 'FORBIDDEN', { required: 'feed.approve' });

  const ids = input.feeds.map((feed) => feed.itemId);
  if (new Set(ids).size !== ids.length) throw badRequest('DUPLICATE_RATION_ITEM', 'Each feed can appear only once in a ration');
  const feeds = await feedRows(ids);
  if (feeds.size !== ids.length) throw notFound('Item');
  if ([...feeds.values()].some((feed) => feed.category !== 'feed')) throw badRequest('NOT_A_FEED_ITEM', 'A ration can only contain feed items');

  let herd: HerdWeight | null = null;
  let state: string | null = input.state ?? null;
  if (input.herdId) {
    const [row] = await tx()
      .select({ herdId: herds.id, herdName: herds.name, herdState: herds.state, rationState: rations.state })
      .from(herds)
      .leftJoin(rations, eq(rations.id, herds.rationId))
      .where(and(eq(herds.id, input.herdId), eq(herds.farmId, ctx().farmId)));
    if (!row) throw notFound('Herd');
    // The state asked for, else the state of the ration the herd is on, else the herd's own.
    state = state ?? row.rationState ?? row.herdState;
    [herd] = await herdWeights([{ herdId: row.herdId, herdName: row.herdName, rationState: state }]);
  }
  if (!state) throw badRequest('VALIDATION_ERROR', 'Give a herd, or a state and a weight');

  const weightKg = input.weightKg ?? herd?.avgWeightKg ?? null;
  const choice: RequirementChoice = { stage: input.stage, litter: input.litter, gainG: input.gainG };
  const { requirement, reason } = requirementOf(state, choice, {
    // Without a herd the table's own species is meant: NRC 1985 is a sheep table.
    species: herd ? herd.species : 'sheep',
    mixedSpecies: herd?.mixedSpecies ?? false,
    // A weight typed in stands on its own; the herd's head only matters when its average is used.
    head: input.weightKg === undefined && herd ? herd.head : null,
    weightKg,
  });

  const costs = await unitCostsPerKg(ids);
  const missing = ids
    .map((id) => {
      const feed = feeds.get(id)!;
      const fields: MissingField[] = [...missingFeedNutrients(feed)];
      if (feed.isRoughage === null) fields.push('isRoughage');
      if (!costs.has(id)) fields.push('price');
      return { itemId: id, itemName: feed.name, fields };
    })
    .filter((feed) => feed.fields.length > 0);

  const minRoughageSharePct = input.minRoughageSharePct ?? LEAST_COST_DEFAULTS.minRoughageSharePct;
  const base = {
    herd: herd && {
      herdId: herd.herdId,
      herdName: herd.herdName,
      species: herd.species,
      head: herd.head,
      weighedHead: herd.weighedHead,
      avgWeightKg: herd.avgWeightKg,
    },
    state,
    stage: state === 'pregnant' ? (input.stage ?? 'late') : null,
    litter: state === 'lactating' || (state === 'pregnant' && input.stage !== 'early') ? (input.litter ?? 1) : null,
    weightKg,
    requirement: requirement ? requirementView(requirement) : null,
    reason,
    minRoughageSharePct,
    missing,
    seasonDays: ctx().settings.feed.winterDays,
  };
  const empty = { lines: [], costPerHeadDay: null, costPerSeason: null, balance: [] as BalanceLine[], roughageSharePct: null, shortfalls: [] };

  if (!requirement) return { status: 'no_requirement' as const, ...base, ...empty };
  if (missing.length > 0) return { status: 'missing_data' as const, ...base, ...empty };

  const candidates: MixFeed[] = input.feeds.map((asked) => {
    const feed = feeds.get(asked.itemId)!;
    return {
      id: feed.id,
      dryMatterPct: feed.dryMatterPct!,
      meMjPerKgDm: feed.meMjPerKgDm!,
      crudeProteinPctDm: feed.crudeProteinPctDm!,
      calciumGPerKgDm: feed.calciumGPerKgDm!,
      phosphorusGPerKgDm: feed.phosphorusGPerKgDm!,
      isRoughage: feed.isRoughage!,
      costPerKg: costs.get(feed.id)!,
      maxKgPerHeadDay: asked.maxKgPerHeadDay ?? null,
    };
  });
  const mix = leastCostRation(candidates, requirement, { minRoughageSharePct });
  if (!mix || mix.status === 'infeasible') {
    return {
      status: 'infeasible' as const,
      ...base,
      ...empty,
      shortfalls: (mix?.shortfalls ?? []).map((s) => ({ ...s, required: round(s.required, 2), best: round(s.best, 2) })),
    };
  }

  // Amounts go to the gram, as a ration stores them; the balance and the cost are of the rounded mix.
  const lines = mix.lines
    .map((line) => {
      const feed = feeds.get(line.id)!;
      const kgPerHeadDay = round(line.kgPerHeadDay, 3);
      const unitCostPerKg = costs.get(line.id)!;
      return {
        itemId: feed.id,
        itemName: feed.name,
        isRoughage: feed.isRoughage!,
        kgPerHeadDay,
        dryMatterKg: round((kgPerHeadDay * feed.dryMatterPct!) / 100, 3),
        unitCostPerKg: round(unitCostPerKg, 2),
        costPerHeadDay: round(kgPerHeadDay * unitCostPerKg, 2),
      };
    })
    .filter((line) => line.kgPerHeadDay > 0)
    .sort((a, b) => b.kgPerHeadDay - a.kgPerHeadDay);
  const fed = lines.map((line) => ({ ...feeds.get(line.itemId)!, kgPerHeadDay: line.kgPerHeadDay }));
  const costPerHeadDay = round(lines.reduce((sum, line) => sum + line.kgPerHeadDay * costs.get(line.itemId)!, 0), 2);
  const share = roughageSharePct(fed);

  return {
    status: 'optimal' as const,
    ...base,
    lines,
    costPerHeadDay,
    costPerSeason: round(costPerHeadDay * base.seasonDays, 2),
    balance: roundLines(nutrientBalance(rationNutrientSupply(fed), requirement)),
    roughageSharePct: share === null ? null : round(share, 1),
    shortfalls: [],
  };
}
