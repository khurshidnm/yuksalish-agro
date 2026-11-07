interface PriceValues {
  rented: boolean;
  purchasePrice?: number | null;
  purchaseCurrency: string;
  purchaseFxRate?: number | null;
}

/**
 * The form has one price box. In the base currency it is purchasePrice; in another it is the amount
 * paid, and the server works out purchasePrice from it, so the form must not send one.
 */
export function priceBody({ rented, purchasePrice, purchaseCurrency, purchaseFxRate }: PriceValues, baseCurrency: string) {
  if (rented || !purchasePrice || purchaseCurrency === baseCurrency) {
    return { purchasePrice: purchasePrice ?? null, purchaseAmount: null, purchaseCurrency: null, purchaseFxRate: null };
  }
  return { purchasePrice: undefined, purchaseAmount: purchasePrice, purchaseCurrency, purchaseFxRate: purchaseFxRate ?? null };
}
