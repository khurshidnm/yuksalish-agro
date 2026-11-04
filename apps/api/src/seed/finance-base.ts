import { schema } from '../db/client';
import { ctx, tx } from '../core/context';
import { SEED } from './names';
import type { SeedContext } from './types';

const { accounts, counterparties } = schema;

/** Accounts and counterparties come first: most other domains refer to them. */
export async function seedFinanceBase(s: SeedContext): Promise<void> {
  await s.run(async () => {
    const c = ctx();
    const columns = { tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId };
    const p = SEED.counterparty;

    // Opening amounts are placeholders. seedFinance sets them once all postings are known.
    await tx()
      .insert(accounts)
      .values([
        { ...columns, name: SEED.account.cash, type: 'cash', openingDate: '2026-08-01' },
        {
          ...columns,
          name: SEED.account.bank,
          type: 'bank',
          openingDate: '2026-08-01',
          bankName: 'Agrobank',
          accountNumber: '2020 8000 7000 1234 5001',
        },
      ]);

    await tx()
      .insert(counterparties)
      .values([
        {
          ...columns,
          name: p.sheepSeller,
          tin: '305114872',
          type: 'supplier',
          phone: '+998 76 225 14 80',
          address: 'Surxondaryo viloyati, Sherobod tumani',
          contactPerson: 'Olim Sharipov',
          bankDetails: { bankName: 'Xalq banki', account: '2020 8000 3000 4411 1002', mfo: '00421' },
        },
        {
          ...columns,
          name: p.feedSupplier,
          tin: '304882156',
          type: 'supplier',
          phone: '+998 65 221 33 10',
          address: 'Buxoro shahri, Sanoat ko\'chasi 14',
          contactPerson: 'Farhod Nazarov',
          bankDetails: { bankName: 'Asakabank', account: '2020 8000 5000 7712 3004', mfo: '00873' },
        },
        {
          ...columns,
          name: p.seedSupplier,
          tin: '306240917',
          type: 'supplier',
          phone: '+998 71 203 40 55',
          address: 'Toshkent shahri, Chilonzor tumani',
          contactPerson: 'Malika Umarova',
          bankDetails: { bankName: 'Agrobank', account: '2020 8000 7000 9931 4008', mfo: '00394' },
        },
        {
          ...columns,
          name: p.fuelSupplier,
          tin: '302915543',
          type: 'supplier',
          phone: '+998 65 512 07 22',
          address: 'Buxoro viloyati, Qorovulbozor tumani',
          contactPerson: 'Ravshan Hakimov',
          bankDetails: { bankName: 'Agrobank', account: '2020 8000 7000 2207 5010', mfo: '00394' },
        },
        {
          ...columns,
          name: p.vetSupplier,
          tin: '307338201',
          type: 'supplier',
          phone: '+998 71 150 62 18',
          address: 'Toshkent shahri, Yunusobod tumani',
          contactPerson: 'Dilfuza Qosimova',
          bankDetails: { bankName: 'Kapitalbank', account: '2020 8000 1000 3318 6003', mfo: '00974' },
        },
        {
          ...columns,
          name: p.bank,
          tin: '200242936',
          type: 'bank',
          phone: '+998 65 512 11 00',
          address: 'Buxoro viloyati, Qorovulbozor tumani',
          bankDetails: { bankName: 'Agrobank', mfo: '00394' },
        },
        {
          ...columns,
          name: p.buyer,
          tin: '303770418',
          type: 'buyer',
          phone: '+998 65 224 51 90',
          address: 'Buxoro shahri, Kogon yo\'li 3',
          contactPerson: 'Akbar Ismoilov',
          bankDetails: { bankName: 'Ipoteka bank', account: '2020 8000 9000 4127 7006', mfo: '00419' },
        },
        {
          ...columns,
          name: p.grainBuyer,
          tin: '301556329',
          type: 'buyer',
          phone: '+998 65 223 18 47',
          address: 'Buxoro viloyati, Kogon tumani',
          contactPerson: 'Shuhrat Rahmatov',
          bankDetails: { bankName: 'Agrobank', account: '2020 8000 7000 6650 8009', mfo: '00394' },
        },
        {
          ...columns,
          name: p.tax,
          type: 'government',
          address: 'Buxoro viloyati, Qorovulbozor tumani',
        },
      ]);
  }, 'accountant');
}
