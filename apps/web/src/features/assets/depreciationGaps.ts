interface Depreciable {
  rented: boolean;
  purchasePrice?: number | null;
  purchaseDate?: string | null;
  depreciationMethod: string;
  usefulLifeMonths?: number | null;
  totalUnits?: number | null;
}

export type DepreciationGap = 'usefulLifeMonths' | 'totalUnits' | 'purchaseDate';

/** What keeps a machine with a price out of every monthly run. The run skips it without a word. */
export function depreciationGaps(asset: Depreciable): DepreciationGap[] {
  if (asset.rented || !asset.purchasePrice) return [];
  const measure = asset.depreciationMethod === 'units' ? 'totalUnits' : 'usefulLifeMonths';
  return ([measure, 'purchaseDate'] as const).filter((field) => !asset[field]);
}
