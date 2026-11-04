export interface RationLine {
  id: string;
  itemId: string;
  itemName: string;
  unit: string;
  kgPerHeadDay: number;
  unitCostPerKg: number | null;
  costPerHeadDay: number | null;
}

export interface Ration {
  id: string;
  name: string;
  state: string;
  notes: string | null;
  lines: RationLine[];
  totalKgPerHeadDay: number;
  costPerHeadDay: number | null;
  costPerSeason: number | null;
  seasonDays: number;
}

export interface FeedBalanceRow {
  itemId: string;
  name: string;
  unit: string;
  stockQty: number;
  plannedDaily: number | null;
  actualDaily: number | null;
  daysByPlan: number | null;
  daysByActual: number | null;
  days: number | null;
  basis: 'actual' | 'plan' | null;
  actualDaysCovered: number | null;
  minDays: number;
  belowMinimum: boolean;
}

export interface FeedPlan {
  herds: {
    herdId: string;
    herdName: string;
    state: string;
    head: number;
    rationId: string;
    rationName: string | null;
    lines: { itemId: string; itemName: string; unit: string; kgPerHeadDay: number; dailyKg: number }[];
    dailyKg: number;
    costPerDay: number | null;
  }[];
  withoutRation: { herdId: string; herdName: string; head: number }[];
}

export interface WinterRow {
  itemId: string;
  name: string;
  unit: string;
  requiredKg: number;
  stockKg: number | null;
  shortageKg: number | null;
  surplusKg: number | null;
  dailyKg: number;
  coverageDays: number | null;
  runsOutOn: string | null;
  unitCostPerKg: number | null;
  purchaseCost: number | null;
  cropId: string | null;
  cropName: { uz: string; ru: string; en: string } | null;
  yieldTHa: number | null;
  hectares: number | null;
}

export interface WinterPlan {
  days: number;
  head: number;
  basis: 'herds' | 'scenario';
  rows: WinterRow[];
  totals: { requiredKg: number; shortageKg: number; purchaseCost: number | null; shortItems: number };
}
