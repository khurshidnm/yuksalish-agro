import { describe, expect, it } from 'vitest';
import {
  dailyRequirement,
  leastCostRation,
  missingFeedNutrients,
  MJ_PER_MCAL,
  nutrientBalance,
  rationNutrientSupply,
  requirementInputFor,
  roughageSharePct,
  TYPICAL_FEED_KEYS,
  TYPICAL_FEEDS,
  type FeedingState,
  type LambRows,
  type MixFeed,
} from './nutrition';

const LB_PER_KG = 2.2046;
const G_PER_LB = 453.6;

describe('dailyRequirement (NRC 1985, Table 1)', () => {
  it('gives the printed row for a 70 kg ewe in each state', () => {
    // NRC 1985 Table 1, 70 kg rows: dry matter kg, ME Mcal, crude protein g, Ca g, P g.
    const printed: [FeedingState, 1 | 2, number, number, number, number, number][] = [
      ['maintenance', 1, 1.2, 2.4, 113, 2.5, 2.4],
      ['early_pregnancy', 1, 1.4, 2.8, 130, 3.5, 2.9],
      ['late_pregnancy', 1, 1.8, 3.8, 193, 6.2, 5.6],
      ['late_pregnancy', 2, 1.9, 4.4, 214, 7.6, 4.5],
      ['lactation', 1, 2.5, 5.9, 334, 9.3, 7.0],
      ['lactation', 2, 2.8, 6.6, 420, 11.0, 8.1],
    ];
    for (const [state, litter, dm, mcal, cp, ca, p] of printed) {
      const r = dailyRequirement({ species: 'sheep', weightKg: 70, state, litter })!;
      expect(r.dryMatterKg).toBeCloseTo(dm, 9);
      expect(r.meMj).toBeCloseTo(mcal * MJ_PER_MCAL, 9);
      expect(r.crudeProteinG).toBeCloseTo(cp, 9);
      expect(r.calciumG).toBeCloseTo(ca, 9);
      expect(r.phosphorusG).toBeCloseTo(p, 9);
      expect(r.weightClamped).toBe(false);
    }
    // 3.8 Mcal × 4.184 = 15.8992 MJ.
    expect(dailyRequirement({ species: 'sheep', weightKg: 70, state: 'late_pregnancy' })!.meMj).toBeCloseTo(15.8992, 4);
  });

  it('agrees with the pound figures printed by Oregon State University Extension', () => {
    // "Nutrient requirements of sheep", Oregon State University Extension, tables adapted from NRC (1985).
    // Weight lb, then as printed: dry matter lb, TDN lb, protein lb, calcium g, phosphorus g.
    const printed: [FeedingState, 1 | 2, LambRows | null, number, number, number, number, number, number][] = [
      ['maintenance', 1, null, 110, 2.2, 1.2, 0.21, 2.0, 1.8],
      ['maintenance', 1, null, 154, 2.6, 1.5, 0.25, 2.5, 2.4],
      ['maintenance', 1, null, 198, 3.1, 1.7, 0.29, 2.9, 3.1],
      ['early_pregnancy', 1, null, 110, 2.6, 1.5, 0.25, 2.9, 2.1],
      ['early_pregnancy', 1, null, 154, 3.1, 1.7, 0.29, 3.5, 2.9],
      ['early_pregnancy', 1, null, 198, 3.5, 1.9, 0.33, 4.1, 3.6],
      ['late_pregnancy', 1, null, 110, 3.5, 2.1, 0.38, 5.9, 4.8],
      ['late_pregnancy', 1, null, 154, 4.0, 2.3, 0.42, 6.2, 5.6],
      ['late_pregnancy', 1, null, 198, 4.4, 2.5, 0.47, 6.4, 6.5],
      ['late_pregnancy', 2, null, 110, 3.7, 2.4, 0.43, 6.2, 3.4],
      ['late_pregnancy', 2, null, 154, 4.2, 2.8, 0.47, 7.6, 4.5],
      ['late_pregnancy', 2, null, 198, 4.6, 3.0, 0.51, 8.9, 5.7],
      ['lactation', 1, null, 110, 4.6, 3.0, 0.67, 8.9, 6.1],
      ['lactation', 1, null, 154, 5.5, 3.6, 0.73, 9.3, 7.0],
      ['lactation', 1, null, 198, 5.9, 3.8, 0.78, 9.6, 7.8],
      ['lactation', 2, null, 110, 5.3, 3.4, 0.86, 10.5, 7.3],
      ['lactation', 2, null, 154, 6.2, 4.0, 0.92, 11.0, 8.1],
      ['lactation', 2, null, 198, 7.0, 4.6, 0.99, 11.4, 9.0],
      ['growing', 1, 'finishing_lamb', 66, 2.9, 2.1, 0.42, 6.6, 3.2],
      ['growing', 1, 'finishing_lamb', 88, 3.5, 2.7, 0.41, 6.6, 3.3],
      ['growing', 1, 'finishing_lamb', 110, 3.5, 2.7, 0.35, 5.6, 3.0],
      ['growing', 1, 'early_weaned_moderate', 66, 2.9, 2.2, 0.42, 6.7, 3.2],
      ['growing', 1, 'early_weaned_moderate', 88, 3.3, 2.6, 0.44, 7.7, 3.9],
      ['growing', 1, 'early_weaned_rapid', 22, 1.3, 1.1, 0.35, 4.9, 2.2],
      ['growing', 1, 'early_weaned_rapid', 110, 3.7, 2.8, 0.53, 9.4, 4.8],
    ];
    for (const [state, litter, lambRows, lb, dmLb, tdnLb, cpLb, ca, p] of printed) {
      const weightKg = Math.round(lb / LB_PER_KG);
      const r = dailyRequirement({ species: 'sheep', weightKg, state, litter, lambRows: lambRows ?? undefined })!;
      const label = `${state} ${litter} ${lambRows ?? ''} ${lb} lb`;
      // The page prints feed to 0.1 lb and protein to 0.01 lb. One row is cut rather than rounded
      // (334 g is 0.736 lb, printed 0.73), so protein is allowed 0.0075 lb, which is 3.4 g.
      expect(Math.abs(r.dryMatterKg * LB_PER_KG - dmLb), `${label} dry matter`).toBeLessThanOrEqual(0.06);
      expect(Math.abs(r.crudeProteinG / G_PER_LB - cpLb), `${label} protein`).toBeLessThanOrEqual(0.0075);
      expect(r.calciumG, `${label} calcium`).toBeCloseTo(ca, 9);
      expect(r.phosphorusG, `${label} phosphorus`).toBeCloseTo(p, 9);
      // Energy: NRC 1985 takes 1 kg TDN = 4.4 Mcal DE and ME = 0.82 DE, so 3.608 Mcal ME per kg TDN.
      // TDN is printed to 0.1 lb, which is ±0.08 Mcal; the NRC pound column itself is rounded loosely,
      // so 0.2 Mcal is allowed.
      const mcalFromTdn = (tdnLb / LB_PER_KG) * 3.608;
      expect(Math.abs(r.meMj / MJ_PER_MCAL - mcalFromTdn), `${label} energy`).toBeLessThanOrEqual(0.2);
    }
  });

  it('reads between two printed weights in a straight line', () => {
    // 65 kg maintenance, halfway between 60 kg (1.1, 2.2, 104, 2.3, 2.1) and 70 kg (1.2, 2.4, 113, 2.5, 2.4).
    const r = dailyRequirement({ species: 'sheep', weightKg: 65, state: 'maintenance' })!;
    expect(r.dryMatterKg).toBeCloseTo(1.15, 9);
    expect(r.meMj).toBeCloseTo(2.3 * 4.184, 9);
    expect(r.crudeProteinG).toBeCloseTo(108.5, 9);
    expect(r.calciumG).toBeCloseTo(2.4, 9);
    expect(r.phosphorusG).toBeCloseTo(2.25, 9);
    // 72.5 kg late pregnancy with twins, a quarter of the way from 70 kg (1.9, 4.4, 214, 7.6, 4.5) to 80 kg (2.0, 4.7, 223, 8.3, 5.1).
    const twins = dailyRequirement({ species: 'sheep', weightKg: 72.5, state: 'late_pregnancy', litter: 2 })!;
    expect(twins.dryMatterKg).toBeCloseTo(1.925, 9);
    expect(twins.meMj).toBeCloseTo(4.475 * 4.184, 9);
    expect(twins.crudeProteinG).toBeCloseTo(216.25, 9);
    expect(twins.calciumG).toBeCloseTo(7.775, 9);
    expect(twins.phosphorusG).toBeCloseTo(4.65, 9);
    expect(twins.rows).toEqual(['late_pregnancy_2']);
  });

  it('uses the nearest printed weight outside the table and says so', () => {
    const light = dailyRequirement({ species: 'sheep', weightKg: 42, state: 'maintenance' })!;
    expect(light.weightUsedKg).toBe(50);
    expect(light.weightClamped).toBe(true);
    expect(light.crudeProteinG).toBe(95);
    const heavy = dailyRequirement({ species: 'sheep', weightKg: 104, state: 'lactation', litter: 2 })!;
    expect(heavy.weightUsedKg).toBe(90);
    expect(heavy.weightClamped).toBe(true);
    expect(heavy.crudeProteinG).toBe(450);
  });

  it('is null without a weight and for a species the table does not cover', () => {
    expect(dailyRequirement({ species: 'sheep', weightKg: null, state: 'maintenance' })).toBeNull();
    expect(dailyRequirement({ species: 'sheep', weightKg: 0, state: 'maintenance' })).toBeNull();
    expect(dailyRequirement({ species: 'cattle', weightKg: 450, state: 'maintenance' })).toBeNull();
    expect(dailyRequirement({ species: 'goat', weightKg: 50, state: 'maintenance' })).toBeNull();
    expect(dailyRequirement({ species: 'horse', weightKg: 400, state: 'maintenance' })).toBeNull();
    expect(dailyRequirement({ species: null, weightKg: 60, state: 'maintenance' })).toBeNull();
  });

  it('reads a growing lamb from the printed class when no gain is asked for', () => {
    // Early weaned, moderate growth, 30 kg: gain 300 g, 1.3 kg, 3.6 Mcal, 191 g, 6.7 g, 3.2 g.
    const lamb = dailyRequirement({ species: 'sheep', weightKg: 30, state: 'growing' })!;
    expect(lamb.gainG).toBe(300);
    expect(lamb.dryMatterKg).toBe(1.3);
    expect(lamb.meMj).toBeCloseTo(3.6 * 4.184, 9);
    expect(lamb.crudeProteinG).toBe(191);
    // Finishing, 45 kg: halfway between 40 kg (275, 1.6, 4.4, 185, 6.6, 3.3) and 50 kg (205, 1.6, 4.4, 160, 5.6, 3.0).
    const finishing = dailyRequirement({ species: 'sheep', weightKg: 45, state: 'growing', lambRows: 'finishing_lamb' })!;
    expect(finishing.gainG).toBeCloseTo(240, 9);
    expect(finishing.crudeProteinG).toBeCloseTo(172.5, 9);
    expect(finishing.calciumG).toBeCloseTo(6.1, 9);
    expect(finishing.phosphorusG).toBeCloseTo(3.15, 9);
  });

  it('goes between the printed classes for a target gain', () => {
    // At 30 kg the classes print gains of 227 (replacement), 295 (finishing), 300 (moderate) and 325 (rapid).
    // 311 g is 0.44 of the way from moderate (1.3, 3.6, 191, 6.7, 3.2) to rapid (1.4, 4.0, 216, 7.2, 3.4).
    const r = dailyRequirement({ species: 'sheep', weightKg: 30, state: 'growing', gainG: 311 })!;
    expect(r.rows).toEqual(['early_weaned_moderate', 'early_weaned_rapid']);
    expect(r.gainG).toBeCloseTo(311, 9);
    expect(r.gainClamped).toBe(false);
    expect(r.dryMatterKg).toBeCloseTo(1.344, 9);
    expect(r.meMj).toBeCloseTo(3.776 * 4.184, 9);
    expect(r.crudeProteinG).toBeCloseTo(202, 9);
    expect(r.calciumG).toBeCloseTo(6.92, 9);
    expect(r.phosphorusG).toBeCloseTo(3.288, 9);
  });

  it('brings a gain the table does not print to the nearest printed one', () => {
    const slow = dailyRequirement({ species: 'sheep', weightKg: 30, state: 'growing', gainG: 100 })!;
    expect(slow.gainG).toBe(227);
    expect(slow.gainClamped).toBe(true);
    expect(slow.rows).toEqual(['replacement_ewe_lamb']);
    const fast = dailyRequirement({ species: 'sheep', weightKg: 30, state: 'growing', gainG: 500 })!;
    expect(fast.gainG).toBe(325);
    expect(fast.gainClamped).toBe(true);
    // Only replacement ewe lambs are printed at 65 kg: 100 g, 1.5 kg, 3.2 Mcal, 133 g, 4.55 g, 2.65 g.
    const heavy = dailyRequirement({ species: 'sheep', weightKg: 65, state: 'growing', gainG: 100 })!;
    expect(heavy.gainClamped).toBe(false);
    expect(heavy.crudeProteinG).toBeCloseTo(133, 9);
    expect(heavy.calciumG).toBeCloseTo(4.55, 9);
    expect(heavy.phosphorusG).toBeCloseTo(2.65, 9);
  });
});

describe('requirementInputFor', () => {
  it('reads a ration state as rows of the table', () => {
    expect(requirementInputFor('maintenance')).toEqual({ state: 'maintenance' });
    // "Pregnant" alone is the heavier demand: the last four weeks, one foetus.
    expect(requirementInputFor('pregnant')).toEqual({ state: 'late_pregnancy', litter: 1 });
    expect(requirementInputFor('pregnant', { litter: 2 })).toEqual({ state: 'late_pregnancy', litter: 2 });
    expect(requirementInputFor('pregnant', { stage: 'early', litter: 2 })).toEqual({ state: 'early_pregnancy' });
    expect(requirementInputFor('lactating')).toEqual({ state: 'lactation', litter: 1 });
    expect(requirementInputFor('lactating', { litter: 2 })).toEqual({ state: 'lactation', litter: 2 });
    expect(requirementInputFor('lamb')).toEqual({ state: 'growing', gainG: null, lambRows: 'early_weaned_moderate' });
    expect(requirementInputFor('fattening', { gainG: 250 })).toEqual({ state: 'growing', gainG: 250, lambRows: 'finishing_lamb' });
  });

  it('is null for a state the table has no rows for', () => {
    expect(requirementInputFor('dry')).toBeNull();
    expect(requirementInputFor('')).toBeNull();
  });

  it('leads to the printed row: a fattening ration for a 40 kg lamb is "lambs finishing"', () => {
    // NRC 1985 Table 1, lambs finishing, 40 kg: 1.6 kg DM, 4.4 Mcal ME, 185 g protein, 6.6 g Ca, 3.3 g P.
    const r = dailyRequirement({ species: 'sheep', weightKg: 40, ...requirementInputFor('fattening')! })!;
    expect(r.dryMatterKg).toBe(1.6);
    expect(r.meMj).toBeCloseTo(4.4 * MJ_PER_MCAL, 9);
    expect([r.crudeProteinG, r.calciumG, r.phosphorusG]).toEqual([185, 6.6, 3.3]);
  });
});

describe('typical feeds', () => {
  it('has a complete composition for every feed in the list', () => {
    for (const key of TYPICAL_FEED_KEYS) expect(missingFeedNutrients(TYPICAL_FEEDS[key]), key).toEqual([]);
  });
});

describe('rationNutrientSupply and nutrientBalance', () => {
  const hay = { ...TYPICAL_FEEDS.lucerne_hay, kgPerHeadDay: 1.5 };
  const barley = { ...TYPICAL_FEEDS.barley_grain, kgPerHeadDay: 0.4 };

  it('adds up a ration worked by hand', () => {
    // Lucerne hay 1.5 kg at 89.4 % DM = 1.341 kg DM; barley 0.4 kg at 87.1 % = 0.3484 kg DM.
    // Energy 1.341 × 8.4 + 0.3484 × 12.4 = 11.2644 + 4.32016 = 15.58456 MJ.
    // Protein 1.341 × 182 + 0.3484 × 118 = 244.062 + 41.1112 = 285.1732 g.
    // Calcium 1.341 × 16.8 + 0.3484 × 0.8 = 22.5288 + 0.27872 = 22.80752 g.
    // Phosphorus 1.341 × 2.6 + 0.3484 × 3.9 = 3.4866 + 1.35876 = 4.84536 g.
    const supply = rationNutrientSupply([hay, barley]);
    expect(supply.dryMatter).toBeCloseTo(1.6894, 9);
    expect(supply.energy).toBeCloseTo(15.58456, 9);
    expect(supply.protein).toBeCloseTo(285.1732, 9);
    expect(supply.calcium).toBeCloseTo(22.80752, 9);
    expect(supply.phosphorus).toBeCloseTo(4.84536, 9);
  });

  it('compares it with a 70 kg ewe in late pregnancy', () => {
    // Requirement 1.8 kg, 15.8992 MJ, 193 g, 6.2 g, 5.6 g.
    const balance = nutrientBalance(rationNutrientSupply([hay, barley]), dailyRequirement({ species: 'sheep', weightKg: 70, state: 'late_pregnancy' }));
    const by = Object.fromEntries(balance.map((line) => [line.nutrient, line]));
    expect(by.dryMatter.coveredPct).toBeCloseTo(93.856, 2); // 1.6894 / 1.8
    expect(by.dryMatter.flag).toBe('enough');
    expect(by.energy.coveredPct).toBeCloseTo(98.021, 2); // 15.58456 / 15.8992
    expect(by.energy.flag).toBe('enough');
    expect(by.protein.coveredPct).toBeCloseTo(147.758, 2); // 285.1732 / 193
    expect(by.protein.flag).toBe('over');
    expect(by.calcium.coveredPct).toBeCloseTo(367.863, 2); // 22.80752 / 6.2
    expect(by.calcium.flag).toBe('over');
    expect(by.phosphorus.coveredPct).toBeCloseTo(86.524, 2); // 4.84536 / 5.6
    expect(by.phosphorus.flag).toBe('short');
  });

  it('leaves a nutrient null when one feed lacks it, and everything null without dry matter', () => {
    const noEnergy = rationNutrientSupply([hay, { ...barley, meMjPerKgDm: null }]);
    expect(noEnergy.energy).toBeNull();
    expect(noEnergy.protein).toBeCloseTo(285.1732, 9);
    expect(noEnergy.dryMatter).toBeCloseTo(1.6894, 9);

    const noDm = rationNutrientSupply([hay, { ...barley, dryMatterPct: null }]);
    expect(noDm).toEqual({ dryMatter: null, energy: null, protein: null, calcium: null, phosphorus: null });
    expect(rationNutrientSupply([])).toEqual({ dryMatter: null, energy: null, protein: null, calcium: null, phosphorus: null });

    const lines = nutrientBalance(noEnergy, dailyRequirement({ species: 'sheep', weightKg: 70, state: 'late_pregnancy' }));
    expect(lines.find((l) => l.nutrient === 'energy')).toEqual({ nutrient: 'energy', supply: null, requirement: 3.8 * 4.184, coveredPct: null, flag: null });
    expect(lines.find((l) => l.nutrient === 'protein')!.flag).toBe('over');
  });

  it('has no percent and no flag without a requirement', () => {
    const lines = nutrientBalance(rationNutrientSupply([hay, barley]), null);
    expect(lines.every((l) => l.requirement === null && l.coveredPct === null && l.flag === null)).toBe(true);
    expect(lines.find((l) => l.nutrient === 'energy')!.supply).toBeCloseTo(15.58456, 9);
  });

  it('counts a zero as known, so salt does not blank the ration', () => {
    const salt = { kgPerHeadDay: 0.01, dryMatterPct: 99, meMjPerKgDm: 0, crudeProteinPctDm: 0, calciumGPerKgDm: 0, phosphorusGPerKgDm: 0 };
    expect(missingFeedNutrients(salt)).toEqual([]);
    expect(rationNutrientSupply([hay, barley, salt]).energy).toBeCloseTo(15.58456, 9);
    expect(missingFeedNutrients({ dryMatterPct: 0, meMjPerKgDm: null, crudeProteinPctDm: 12, calciumGPerKgDm: undefined, phosphorusGPerKgDm: 3 })).toEqual([
      'dryMatterPct',
      'meMjPerKgDm',
      'calciumGPerKgDm',
    ]);
  });

  it('gives the roughage share of dry matter', () => {
    // 1.341 of 1.6894 kg DM is hay: 79.377 %.
    expect(roughageSharePct([hay, barley])).toBeCloseTo(79.377, 2);
    expect(roughageSharePct([hay, { ...barley, isRoughage: null }])).toBeNull();
    expect(roughageSharePct([])).toBeNull();
  });
});

describe('leastCostRation', () => {
  const hay: MixFeed = { id: 'hay', dryMatterPct: 90, meMjPerKgDm: 8, crudeProteinPctDm: 15, calciumGPerKgDm: 0, phosphorusGPerKgDm: 0, isRoughage: true, costPerKg: 900 };
  const grain: MixFeed = { id: 'grain', dryMatterPct: 90, meMjPerKgDm: 13, crudeProteinPctDm: 11, calciumGPerKgDm: 0, phosphorusGPerKgDm: 0, isRoughage: false, costPerKg: 2250 };
  const need = { dryMatterKg: 2, meMj: 20, crudeProteinG: 200, calciumG: 0, phosphorusG: 0 };

  it('finds the mix worked by hand', () => {
    // In kg of dry matter, h of hay and g of grain; a kg of dry matter costs 1000 and 2500.
    //   h + g ≤ 2, 8h + 13g ≥ 20, 150h + 110g ≥ 200, h ≥ g (half the dry matter is roughage).
    // Hay is cheaper per MJ (125 against 192), so as much hay as possible: hay alone would need 2.5 kg,
    // over the limit, so the limit binds: 8h + 13(2 − h) = 20 gives h = 1.2 and g = 0.8.
    // Protein 180 + 88 = 268 ≥ 200; roughage 60 %. Cost 1200 + 2000 = 3200.
    // As fed: 1.2 / 0.9 = 1.3333 kg hay and 0.8 / 0.9 = 0.8889 kg grain.
    const result = leastCostRation([hay, grain], need)!;
    expect(result.status).toBe('optimal');
    expect(result.lines.find((l) => l.id === 'hay')!.kgPerHeadDay).toBeCloseTo(1.33333, 5);
    expect(result.lines.find((l) => l.id === 'grain')!.kgPerHeadDay).toBeCloseTo(0.88889, 5);
    expect(result.costPerHeadDay).toBeCloseTo(3200, 6);
    expect(result.shortfalls).toEqual([]);
  });

  it('respects a maximum on one feed', () => {
    // Hay capped at 1.08 kg as fed (0.972 kg DM). Energy then needs 13g ≥ 20 − 7.776, g = 0.940308 kg DM,
    // which is under the hay (roughage 50.8 %) and inside the intake limit (1.9123 kg).
    // Cost 972 + 2350.769 = 3322.769. Grain as fed 0.940308 / 0.9 = 1.044786 kg.
    const result = leastCostRation([{ ...hay, maxKgPerHeadDay: 1.08 }, grain], need)!;
    expect(result.status).toBe('optimal');
    expect(result.lines.find((l) => l.id === 'hay')!.kgPerHeadDay).toBeCloseTo(1.08, 6);
    expect(result.lines.find((l) => l.id === 'grain')!.kgPerHeadDay).toBeCloseTo(1.044786, 5);
    expect(result.costPerHeadDay).toBeCloseTo(3322.769, 2);
  });

  it('names the requirement that is out of reach on its own', () => {
    // Hay capped at 0.9 kg as fed (0.81 kg DM) and grain no more than the hay: at most
    // 0.81 × 8 + 0.81 × 13 = 17.01 MJ against 20.
    const result = leastCostRation([{ ...hay, maxKgPerHeadDay: 0.9 }, grain], need)!;
    expect(result.status).toBe('infeasible');
    expect(result.lines).toEqual([]);
    expect(result.costPerHeadDay).toBeNull();
    expect(result.shortfalls).toHaveLength(1);
    expect(result.shortfalls[0]).toMatchObject({ nutrient: 'energy', required: 20, alone: true });
    expect(result.shortfalls[0].best).toBeCloseTo(17.01, 6);
  });

  it('names the requirements that cannot be met together', () => {
    // A is pure energy (10 MJ/kg), B pure protein (100 g/kg); one kg of dry matter in all.
    // Energy needs 0.8 kg of A, protein 0.5 kg of B: 1.3 kg. Each alone is within reach.
    // With protein met (0.5 B) only 0.5 A fits: 5 MJ of 8. With energy met (0.8 A) only 0.2 B fits: 20 g of 50.
    const a: MixFeed = { id: 'a', dryMatterPct: 100, meMjPerKgDm: 10, crudeProteinPctDm: 0, calciumGPerKgDm: 0, phosphorusGPerKgDm: 0, isRoughage: true, costPerKg: 1 };
    const b: MixFeed = { id: 'b', dryMatterPct: 100, meMjPerKgDm: 0, crudeProteinPctDm: 10, calciumGPerKgDm: 0, phosphorusGPerKgDm: 0, isRoughage: true, costPerKg: 1 };
    const result = leastCostRation([a, b], { dryMatterKg: 1, meMj: 8, crudeProteinG: 50, calciumG: 0, phosphorusG: 0 })!;
    expect(result.status).toBe('infeasible');
    expect(result.shortfalls.map((s) => [s.nutrient, s.alone])).toEqual([
      ['energy', false],
      ['protein', false],
    ]);
    expect(result.shortfalls[0].best).toBeCloseTo(5, 6);
    expect(result.shortfalls[1].best).toBeCloseTo(20, 6);
  });

  it('cannot feed a ewe in late pregnancy on straw and barley: protein fails', () => {
    // 70 kg, one foetus: 1.8 kg DM, 15.8992 MJ, 193 g protein, 6.2 g Ca, 5.6 g P.
    // Most protein within the limits is half straw, half barley: 0.9 × 42 + 0.9 × 118 = 144 g.
    const straw: MixFeed = { id: 'straw', ...TYPICAL_FEEDS.cereal_straw, costPerKg: 300 };
    const barley: MixFeed = { id: 'barley', ...TYPICAL_FEEDS.barley_grain, costPerKg: 2800 };
    const requirement = dailyRequirement({ species: 'sheep', weightKg: 70, state: 'late_pregnancy' })!;
    const result = leastCostRation([straw, barley], requirement)!;
    expect(result.status).toBe('infeasible');
    const protein = result.shortfalls.find((s) => s.nutrient === 'protein')!;
    expect(protein.alone).toBe(true);
    expect(protein.best).toBeCloseTo(144, 6);
    expect(protein.required).toBe(193);
  });

  it('balances the same ewe once lucerne hay and bran are on offer', () => {
    const feeds: MixFeed[] = [
      { id: 'lucerne', ...TYPICAL_FEEDS.lucerne_hay, costPerKg: 1500 },
      { id: 'straw', ...TYPICAL_FEEDS.cereal_straw, costPerKg: 300 },
      { id: 'barley', ...TYPICAL_FEEDS.barley_grain, costPerKg: 2800 },
      { id: 'bran', ...TYPICAL_FEEDS.wheat_bran, costPerKg: 1800 },
    ];
    const requirement = dailyRequirement({ species: 'sheep', weightKg: 70, state: 'late_pregnancy' })!;
    const result = leastCostRation(feeds, requirement)!;
    expect(result.status).toBe('optimal');
    // Whatever the mix, it must hold every rule it was given.
    const lines = result.lines.map((line) => ({ ...feeds.find((f) => f.id === line.id)!, kgPerHeadDay: line.kgPerHeadDay }));
    const supply = rationNutrientSupply(lines);
    expect(supply.dryMatter!).toBeLessThanOrEqual(requirement.dryMatterKg + 1e-6);
    expect(supply.energy!).toBeGreaterThanOrEqual(requirement.meMj - 1e-6);
    expect(supply.protein!).toBeGreaterThanOrEqual(requirement.crudeProteinG - 1e-6);
    expect(supply.calcium!).toBeGreaterThanOrEqual(requirement.calciumG - 1e-6);
    expect(supply.phosphorus!).toBeGreaterThanOrEqual(requirement.phosphorusG - 1e-6);
    expect(roughageSharePct(lines)!).toBeGreaterThanOrEqual(50 - 1e-6);
    expect(result.costPerHeadDay).toBeCloseTo(lines.reduce((sum, l) => sum + l.kgPerHeadDay * l.costPerKg, 0), 6);
    // And no cheaper: lucerne and barley alone, which also balance, cost more.
    const dearer = leastCostRation(feeds.filter((f) => f.id === 'lucerne' || f.id === 'barley'), requirement)!;
    expect(dearer.status).toBe('optimal');
    expect(result.costPerHeadDay!).toBeLessThanOrEqual(dearer.costPerHeadDay! + 1e-6);
  });

  it('is null with no feeds to choose from', () => {
    expect(leastCostRation([], need)).toBeNull();
  });
});
