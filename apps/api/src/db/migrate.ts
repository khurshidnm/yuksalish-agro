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
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { ensurePlatformAdmin } from './platform-admin';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '..', '..', 'drizzle');
const MIGRATION_LOCK_TIMEOUT = '60s';

async function main() {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) throw new Error('DATABASE_OWNER_URL is required');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // Waiting for a table behind a long read also stops everyone queued behind the migration.
    await client.query(`set lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);
    await migrate(drizzle(client), { migrationsFolder });
    console.log('Migrations applied.');
    await client.query(readFileSync(join(here, 'post-schema.sql'), 'utf8'));
    console.log('Row-level security, audit triggers and grants applied.');
    await ensurePlatformAdmin(client, process.env.PLATFORM_ADMIN_PHONE, process.env.PLATFORM_ADMIN_PASSWORD);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
