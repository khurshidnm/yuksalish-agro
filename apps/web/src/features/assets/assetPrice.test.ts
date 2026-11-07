import { describe, expect, it } from 'vitest';
import { priceBody } from './assetPrice';

const tractor = { rented: false, purchasePrice: 48_000, purchaseCurrency: 'USD', purchaseFxRate: 12_650 };

describe('priceBody', () => {
  it('sends a dollar price as the amount paid, and leaves purchasePrice to the server', () => {
    expect(priceBody(tractor, 'UZS')).toEqual({ purchasePrice: undefined, purchaseAmount: 48_000, purchaseCurrency: 'USD', purchaseFxRate: 12_650 });
  });

  it('leaves the rate empty for the server to find', () => {
    expect(priceBody({ ...tractor, purchaseFxRate: null }, 'UZS').purchaseFxRate).toBeNull();
  });

  it('sends a price in the base currency as it is, and clears any dollar figures', () => {
    expect(priceBody({ ...tractor, purchasePrice: 600_000_000, purchaseCurrency: 'UZS' }, 'UZS')).toEqual({
      purchasePrice: 600_000_000,
      purchaseAmount: null,
      purchaseCurrency: null,
      purchaseFxRate: null,
    });
  });

  it('asks for no rate when nothing was typed, or the machine is rented', () => {
    expect(priceBody({ ...tractor, purchasePrice: null }, 'UZS').purchaseCurrency).toBeNull();
    expect(priceBody({ ...tractor, rented: true }, 'UZS').purchaseCurrency).toBeNull();
  });
});
