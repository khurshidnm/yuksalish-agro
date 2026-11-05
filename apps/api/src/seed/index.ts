/**
 * Pilot tenant: Yuksalish Agro (spec section 2). `pnpm db:reset` rebuilds it from scratch.
 * Domain data lives in one file per domain, called in dependency order.
 */
import { DEFAULT_ROLE_PERMISSIONS, MODULES, ROLE_KEYS, type RoleKey } from '@yap/shared';
import bcrypt from 'bcryptjs';
import { config, isProd } from '../config';
import { closeDb, schema } from '../db/client';
import { withPlatform, withTenant } from '../core/context';
import { mergeSettings } from '../core/settings';
import { addMember, provisionTenant } from '../core/tenancy';
import { runStatistics } from '../modules/ai/analysis';
import { seedAssets } from './assets';
import { seedCrops } from './crops';
import { seedDevices } from './devices';
import { seedFinance } from './finance';
import { seedFinanceBase } from './finance-base';
import { seedHr, seedPayroll } from './hr';
import { seedInventory } from './inventory';
import { seedLand } from './land';
import { seedLivestock } from './livestock';
import { skipAudit } from './lookup';
import { SEED } from './names';
import { seedSales } from './sales';
import { seedTasks } from './tasks';
import { seedVet } from './vet';
import type { SeedContext } from './types';

/** Demo logins, one per role. */
export const DEMO_USERS: { role: RoleKey; phone: string; fullName: string }[] = [
  { role: 'owner', phone: '+998900000001', fullName: 'Anvar Egamov' },
  { role: 'director', phone: '+998900000002', fullName: 'Bahodir Rahimov' },
  { role: 'accountant', phone: '+998900000003', fullName: 'Nodira Karimova' },
  { role: 'agronomist', phone: '+998900000004', fullName: 'Sardor Toshev' },
  { role: 'zootechnician', phone: '+998900000005', fullName: 'Jasur Ergashev' },
  { role: 'veterinarian', phone: '+998900000006', fullName: 'Dilshod Olimov' },
  { role: 'storekeeper', phone: '+998900000007', fullName: 'Rustam Sobirov' },
  { role: 'mechanic', phone: '+998900000008', fullName: 'Akmal Qodirov' },
  { role: 'shepherd', phone: '+998900000009', fullName: 'Sherzod Boboyev' },
  { role: 'investor', phone: '+998900000010', fullName: 'Investor Demo' },
  { role: 'auditor', phone: '+998900000011', fullName: 'Auditor Demo' },
];

const PLATFORM_ADMIN_PHONE = '+998900000000';

/**
 * Last, in its own transaction: the AI role reads through a separate connection, so it only sees
 * data that earlier steps have already committed.
 */
async function seedAiInsights(s: SeedContext): Promise<void> {
  await s.run(async () => void (await runStatistics()));
}

async function main() {
  if (isProd) throw new Error('The demo seed must not run in production');

  const settings = {
    // Off for the demo so that sign-in works without an authenticator app.
    // Production tenants keep the default (on), as spec 20.1 requires.
    security: { enforce2fa: false },
  };

  const { tenantId, farmId, roleIds } = await provisionTenant({
    tenant: {
      name: 'Yuksalish Agro',
      legalName: '"Yuksalish Agro" fermer xo\'jaligi',
      legalForm: 'FX',
      settings,
      modules: [...MODULES],
    },
    farm: {
      name: 'Qorovulbozor fermasi',
      region: 'Buxoro viloyati',
      district: 'Qorovulbozor tumani',
      address: 'Buxoro viloyati, Qorovulbozor tumani',
      totalAreaHa: 210,
      lat: 39.5,
      lng: 64.8,
    },
  });

  const users = {} as Record<RoleKey, string>;
  for (const u of DEMO_USERS) {
    const { userId } = await addMember({
      tenantId,
      farmId,
      roleId: roleIds[u.role],
      phone: u.phone,
      fullName: u.fullName,
      password: SEED.password,
    });
    users[u.role] = userId;
  }

  const passwordHash = await bcrypt.hash(SEED.password, config.BCRYPT_ROUNDS);
  await withPlatform((trx) =>
    trx
      .insert(schema.users)
      .values({ phone: PLATFORM_ADMIN_PHONE, fullName: 'Platform Admin', passwordHash, isPlatformAdmin: true })
      .onConflictDoUpdate({ target: schema.users.phone, set: { isPlatformAdmin: true } }),
  );

  const merged = mergeSettings(settings);
  const allPermissions = [...new Set(ROLE_KEYS.flatMap((r) => DEFAULT_ROLE_PERMISSIONS[r]))];
  const seed: SeedContext = {
    tenantId,
    farmId,
    users,
    run: (fn, as = 'owner') =>
      withTenant(
        { userId: users[as], tenantId, farmId, source: 'import', permissions: allPermissions, settings: merged, roleKey: as },
        async () => {
          await skipAudit();
          return fn();
        },
      ),
  };

  const steps: [string, (s: SeedContext) => Promise<void>][] = [
    ['accounts and counterparties', seedFinanceBase],
    ['land', seedLand],
    ['employees', seedHr],
    ['machinery', seedAssets],
    ['warehouses, feed, rations', seedInventory],
    ['livestock', seedLivestock],
    ['payroll', seedPayroll],
    ['pregnancies and veterinary', seedVet],
    ['field operations', seedCrops],
    ['transactions and budget', seedFinance],
    ['sales', seedSales],
    // Devices come first: the task step ends by evaluating alert rules, including camera checks.
    ['cameras and devices', seedDevices],
    ['tasks and alerts', seedTasks],
    ['AI insights', seedAiInsights],
  ];
  for (const [label, step] of steps) {
    const started = Date.now();
    await step(seed);
    console.log(`  ${label} (${Date.now() - started} ms)`);
  }

  console.log(`\nSeeded "Yuksalish Agro". Password for every user: ${SEED.password}`);
  console.table(DEMO_USERS.map((u) => ({ role: u.role, phone: u.phone, name: u.fullName })));
  console.log(`Platform admin: ${PLATFORM_ADMIN_PHONE}`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
