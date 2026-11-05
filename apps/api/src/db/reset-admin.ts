/**
 * For a platform admin who lost their password or authenticator. Runs on the server:
 *
 *   tsx src/db/reset-admin.ts [+998901234567]
 *
 * The phone can be left out when there is only one admin. docs/deployment.md has the full command.
 */
import pg from 'pg';
import { resetPlatformAdmin } from './platform-admin';

async function main() {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) throw new Error('DATABASE_OWNER_URL is required');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { phone, oneTimePassword } = await resetPlatformAdmin(client, process.argv[2]);
    console.log(`Platform admin ${phone} has been reset, and every device signed out.`);
    console.log(`One-time password, shown only now: ${oneTimePassword}`);
    console.log('Sign in with it. You will choose a new password, then enrol two-factor sign-in again.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
