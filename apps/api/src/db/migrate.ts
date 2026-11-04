/**
 * Production schema path: applies the committed migrations in apps/api/drizzle, then the
 * idempotent post-schema.sql (extensions, RLS, audit triggers, grants, tenant foreign keys).
 * Needs neither drizzle-kit nor a dev dependency. Run it as the owner role, before the API starts.
 *
 * On a first deploy, PLATFORM_ADMIN_PHONE and PLATFORM_ADMIN_PASSWORD create the platform admin,
 * who then creates tenants. The demo seed refuses to run in production, so nothing else can.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '..', '..', 'drizzle');

async function ensurePlatformAdmin(client: pg.Client): Promise<void> {
  const phone = process.env.PLATFORM_ADMIN_PHONE;
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!phone || !password) return;
  if (password.length < 12) throw new Error('PLATFORM_ADMIN_PASSWORD must be at least 12 characters');

  const passwordHash = await bcrypt.hash(password, Number(process.env.BCRYPT_ROUNDS) || 10);
  // Never touches an existing user, so a password changed later survives the next deploy.
  const created = await client.query(
    `insert into users (id, phone, full_name, password_hash, is_platform_admin)
     values (gen_random_uuid(), $1, 'Platform Admin', $2, true)
     on conflict (phone) do nothing`,
    [phone, passwordHash],
  );
  console.log(created.rowCount ? `Platform admin created: ${phone}` : 'Platform admin already exists.');
}

async function main() {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) throw new Error('DATABASE_OWNER_URL is required');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(drizzle(client), { migrationsFolder });
    console.log('Migrations applied.');
    await client.query(readFileSync(join(here, 'post-schema.sql'), 'utf8'));
    console.log('Row-level security, audit triggers and grants applied.');
    await ensurePlatformAdmin(client);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
