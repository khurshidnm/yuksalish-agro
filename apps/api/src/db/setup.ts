/**
 * Creates the schema in the development database.
 *   tsx src/db/setup.ts          fails if tables already exist
 *   tsx src/db/setup.ts --reset  DROPS everything first (refuses to run in production)
 */
import pg from 'pg';
import { config, isProd } from '../config';
import { applySchema } from './apply-schema';

const reset = process.argv.includes('--reset');

async function main() {
  if (reset) {
    if (isProd) throw new Error('Refusing to reset a production database');
    const client = new pg.Client({ connectionString: config.DATABASE_OWNER_URL });
    await client.connect();
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC;');
    await client.end();
    console.log('Dropped existing schema.');
  }
  await applySchema(config.DATABASE_OWNER_URL);
  console.log('Schema, row-level security and audit triggers applied.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
