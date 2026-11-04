/**
 * One fresh database per test run, named uniquely so that parallel runs (several agents,
 * CI shards) never share state. Dropped at the end.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { applySchema } from '../src/db/apply-schema';

const OWNER = 'postgres://yap:yap_dev@localhost:5434';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseName: string;
  }
}

export default async function setup(project: TestProject) {
  const name = `yap_test_${process.pid}_${randomBytes(3).toString('hex')}`;
  const admin = new pg.Client({ connectionString: `${OWNER}/postgres` });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  await applySchema(`${OWNER}/${name}`);
  project.provide('databaseName', name);

  return async () => {
    const client = new pg.Client({ connectionString: `${OWNER}/postgres` });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.end();
  };
}
