import { describe, expect, it } from 'vitest';
import {
  cropRemoval,
  fertiliserNeed,
  fertiliserProducts,
  soilTestIsStale,
  TYPICAL_REMOVAL_KG_T,
  type FertiliserProduct,
} from './fertiliser';

const none = { n: null, p2o5: null, k2o: null };

describe('fertiliserNeed', () => {
  it('winter wheat at 5 t/ha on a soil with 28 mg/kg P2O5 and 230 mg/kg K2O (worked by hand)', () => {
    const need = fertiliserNeed({
      cropKey: 'wheat',
      family: 'cereal',
      targetYieldTHa: 5,
      removal: TYPICAL_REMOVAL_KG_T.wheat!,
      soil: { n: 21, p2o5: 28, k2o: 230 },
    });
    // P2O5: uptake 5 × 10.4 = 52; stock 28 × 3 = 84; soil gives 84 × 0.15 = 12.6;
    // rate (52 − 12.6) / 0.2 = 197.
    expect(need.p2o5).toEqual({
      removalPerT: 10.4,
      uptakeKgHa: 52,
      soilMgKg: 28,
      soilStockKgHa: 84,
      soilUse: 0.15,
      soilSupplyKgHa: 12.6,
      fertiliserUse: 0.2,
      rateKgHa: 197,
      reason: null,
    });
    // K2O: uptake 5 × 21.7 = 108.5; stock 230 × 3 = 690; soil gives 690 × 0.05 = 34.5;
    // rate (108.5 − 34.5) / 0.7 = 105.71.
    expect(need.k2o.uptakeKgHa).toBe(108.5);
    expect(need.k2o.soilStockKgHa).toBe(690);
    expect(need.k2o.soilSupplyKgHa).toBe(34.5);
    expect(need.k2o.rateKgHa).toBe(105.7);
    // Nitrogen: the uptake is shown (5 × 33 = 165), the rate is not guessed from nitrate.
    expect(need.n.uptakeKgHa).toBe(165);
    expect(need.n.rateKgHa).toBeNull();
    expect(need.n.reason).toBe('nitrate_not_supported');
  });

  it('a rich soil gives a rate of 0, never a negative one', () => {
    const need = fertiliserNeed({
      cropKey: 'wheat',
      family: 'cereal',
      targetYieldTHa: 2,
      removal: TYPICAL_REMOVAL_KG_T.wheat!,
      // Uptake 2 × 10.4 = 20.8; soil gives 60 × 3 × 0.15 = 27.
      soil: { n: null, p2o5: 60, k2o: 400 },
    });
    expect(need.p2o5.rateKgHa).toBe(0);
    expect(need.p2o5.reason).toBeNull();
  });

  it('says why there is no rate instead of returning 0', () => {
    const wheat = { cropKey: 'wheat', family: 'cereal' as const, removal: TYPICAL_REMOVAL_KG_T.wheat!, soil: { n: 20, p2o5: 28, k2o: 230 } };
    expect(fertiliserNeed({ ...wheat, targetYieldTHa: null }).p2o5).toMatchObject({ rateKgHa: null, reason: 'no_yield' });
    expect(fertiliserNeed({ ...wheat, targetYieldTHa: 5, removal: none }).k2o).toMatchObject({ rateKgHa: null, reason: 'no_removal' });
    expect(fertiliserNeed({ ...wheat, targetYieldTHa: 5, soil: { n: 20, p2o5: null, k2o: 230 } }).p2o5).toMatchObject({
      rateKgHa: null,
      reason: 'no_soil_value',
    });
  });

  it('gives no rate for a row crop: the published soil shares on serozems cover cereals and grasses only', () => {
    const need = fertiliserNeed({
      cropKey: 'cotton',
      family: 'row_crop',
      targetYieldTHa: 3,
      removal: TYPICAL_REMOVAL_KG_T.cotton!,
      soil: { n: 20, p2o5: 28, k2o: 230 },
    });
    expect(need.p2o5).toMatchObject({ uptakeKgHa: 60, soilStockKgHa: 84, soilUse: null, rateKgHa: null, reason: 'no_soil_coefficient' });
    expect(need.k2o).toMatchObject({ uptakeKgHa: 150, rateKgHa: null, reason: 'no_soil_coefficient' });
  });

  it('lucerne fixes its nitrogen, and gets phosphorus and potassium as a perennial grass', () => {
    const need = fertiliserNeed({
      cropKey: 'alfalfa',
      family: 'perennial_grass',
      targetYieldTHa: 10,
      removal: TYPICAL_REMOVAL_KG_T.alfalfa!,
      soil: { n: 20, p2o5: 20, k2o: 200 },
    });
    expect(need.n).toMatchObject({ rateKgHa: null, reason: 'fixes_nitrogen' });
    // P2O5: (10 × 6.5 − 20 × 3 × 0.15) / 0.2 = (65 − 9) / 0.2 = 280.
    expect(need.p2o5.rateKgHa).toBe(280);
    // K2O: (10 × 15 − 200 × 3 × 0.05) / 0.7 = 120 / 0.7 = 171.43.
    expect(need.k2o.rateKgHa).toBe(171.4);
  });
});

describe('cropRemoval', () => {
  it("prefers the farm's own figures, then the typical ones, then nothing", () => {
    expect(cropRemoval('wheat', none)).toEqual({ removal: TYPICAL_REMOVAL_KG_T.wheat, source: 'typical' });
    expect(cropRemoval('wheat', { n: 30, p2o5: 11, k2o: null })).toEqual({ removal: { n: 30, p2o5: 11, k2o: null }, source: 'farm' });
    // Corn is cut as grain or as green mass; the two differ eightfold, so there is no typical figure.
    expect(cropRemoval('corn', none)).toEqual({ removal: none, source: null });
    expect(cropRemoval('quinoa', none).source).toBeNull();
  });
});

describe('fertiliserProducts', () => {
  const ammophos: FertiliserProduct = { id: 'a', name: 'Ammophos', nPct: 12, p2o5Pct: 52, k2oPct: null };
  const urea: FertiliserProduct = { id: 'u', name: 'Urea', nPct: 46, p2o5Pct: null, k2oPct: null };
  const kcl: FertiliserProduct = { id: 'k', name: 'Potassium chloride', nPct: null, p2o5Pct: null, k2oPct: 60 };

  it('turns rates into kilograms of product, counting what each product brings besides (worked by hand)', () => {
    const plan = fertiliserProducts({ n: 100, p2o5: 104, k2o: 60 }, [urea, ammophos, kcl]);
    // P2O5 104 from ammophos at 52 %: 200 kg, which also brings 200 × 0.12 = 24 kg N.
    // K2O 60 from potassium chloride at 60 %: 100 kg.
    // N left 100 − 24 = 76 from urea at 46 %: 165.2 kg.
    expect(plan.uncovered).toEqual([]);
    expect(plan.products).toEqual([
      { id: 'a', name: 'Ammophos', kgHa: 200, gives: { n: 24, p2o5: 104, k2o: 0 } },
      { id: 'k', name: 'Potassium chloride', kgHa: 100, gives: { n: 0, p2o5: 0, k2o: 60 } },
      { id: 'u', name: 'Urea', kgHa: 165.2, gives: { n: 76, p2o5: 0, k2o: 0 } },
    ]);
  });

  it('names a nutrient no stocked product holds, and plans nothing for a nutrient without a rate', () => {
    const plan = fertiliserProducts({ n: null, p2o5: 52, k2o: 60 }, [urea, ammophos]);
    expect(plan.uncovered).toEqual(['k2o']);
    // No nitrogen rate: urea is not planned; the nitrogen that comes with ammophos is still shown.
    expect(plan.products).toEqual([{ id: 'a', name: 'Ammophos', kgHa: 100, gives: { n: 12, p2o5: 52, k2o: 0 } }]);
  });

  it('plans nothing when every rate is zero or the products have no percentages', () => {
    expect(fertiliserProducts({ n: 0, p2o5: 0, k2o: null }, [urea, ammophos])).toEqual({ products: [], uncovered: [] });
    const blank: FertiliserProduct = { id: 'x', name: 'Unknown', nPct: null, p2o5Pct: null, k2oPct: null };
    expect(fertiliserProducts({ n: null, p2o5: 50, k2o: null }, [blank])).toEqual({ products: [], uncovered: ['p2o5'] });
  });
});

describe('soilTestIsStale', () => {
  it('is stale once more than three years old, to the day', () => {
    expect(soilTestIsStale('2023-11-10', '2026-11-10')).toBe(false);
    expect(soilTestIsStale('2023-11-10', '2026-11-11')).toBe(true);
    expect(soilTestIsStale('2025-03-01', '2026-11-10')).toBe(false);
    expect(soilTestIsStale('2020-05-05', '2026-11-10')).toBe(true);
  });
});
