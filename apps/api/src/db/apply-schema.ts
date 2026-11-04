import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(here, '..', '..');

/**
 * DDL for the current Drizzle schema. Uses `drizzle-kit generate` into a temp folder
 * because `drizzle-kit export` ignores the snake_case casing option.
 */
export function generateSchemaSql(): string {
  const out = mkdtempSync(join(tmpdir(), 'yap-schema-'));
  try {
    execFileSync(
      join(apiRoot, 'node_modules', '.bin', 'drizzle-kit'),
      ['generate', '--dialect=postgresql', '--schema=./src/db/schema/index.ts', '--casing=snake_case', `--out=${out}`, '--name=init'],
      { cwd: apiRoot, stdio: 'pipe' },
    );
    const file = readdirSync(out).find((f) => f.endsWith('.sql'));
    if (!file) throw new Error('drizzle-kit produced no SQL');
    return readFileSync(join(out, file), 'utf8');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export function postSchemaSql(): string {
  return readFileSync(join(here, 'post-schema.sql'), 'utf8');
}

/** Apply schema + RLS + audit to an empty database, connected as the owner role. */
export async function applySchema(ownerUrl: string, ddl = generateSchemaSql()): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await client.query(ddl.replaceAll('--> statement-breakpoint', ''));
    await client.query(postSchemaSql());
  } finally {
    await client.end();
  }
}
