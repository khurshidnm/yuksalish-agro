/**
 * Writes docs/erd.md from the Drizzle schema, so the diagram cannot drift from the code.
 * Run after a schema change: pnpm --filter @yap/api exec tsx src/db/erd.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as ai from './schema/ai';
import * as assets from './schema/assets';
import * as cash from './schema/cash';
import * as core from './schema/core';
import * as devices from './schema/devices';
import * as tracking from './schema/tracking';
import * as finance from './schema/finance';
import * as hr from './schema/hr';
import * as inventory from './schema/inventory';
import * as land from './schema/land';
import * as livestock from './schema/livestock';
import * as platform from './schema/platform';
import * as reports from './schema/reports';
import * as sales from './schema/sales';
import * as tasks from './schema/tasks';

const DOMAINS: [string, Record<string, unknown>][] = [
  ['Platform and identity', platform],
  ['Core: journal, audit, files, reference data', core],
  ['Land and crops', land],
  ['Livestock and veterinary', livestock],
  ['Inventory and feed', inventory],
  ['Finance', finance],
  ['Cash held by people', cash],
  ['HR and payroll', hr],
  ['Machinery', assets],
  ['Sales and purchasing', sales],
  ['Tasks, alerts, notifications', tasks],
  ['Devices', devices],
  ['Animal tracking', tracking],
  ['AI', ai],
  ['Reports and import', reports],
];

/** On nearly every table. Drawing them would bury the real relationships. */
const IMPLICIT = new Set(['tenants', 'farms', 'users']);

const snake = (name: string) => name.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
const mermaidType = (sqlType: string) => sqlType.replace(/\(.*$/, '').replace(/\s+/g, '_');

function diagram(tables: PgTable[]): string {
  const lines = ['erDiagram'];
  const relations = new Set<string>();

  for (const table of tables) {
    const config = getTableConfig(table);
    const foreign = new Set<string>();
    for (const fk of config.foreignKeys) {
      const { columns, foreignTable } = fk.reference();
      const target = getTableConfig(foreignTable).name;
      foreign.add(columns[0].name);
      if (!IMPLICIT.has(target)) relations.add(`  ${target} ||--o{ ${config.name} : "${snake(columns[0].name)}"`);
    }
    lines.push(`  ${config.name} {`);
    for (const column of Object.values(getTableColumns(table))) {
      const key = column.primary ? ' PK' : foreign.has(column.name) ? ' FK' : '';
      lines.push(`    ${mermaidType(column.getSQLType())} ${snake(column.name)}${key}`);
    }
    lines.push('  }');
  }
  return [...lines, ...[...relations].sort()].join('\n');
}

const sections: string[] = [];
let total = 0;
for (const [title, module] of DOMAINS) {
  const tables = Object.values(module).filter((value): value is PgTable => is(value, PgTable));
  if (tables.length === 0) continue;
  total += tables.length;
  sections.push(`## ${title}\n\n\`\`\`mermaid\n${diagram(tables)}\n\`\`\``);
}

const header = `# Data model

Generated from \`apps/api/src/db/schema\` by \`apps/api/src/db/erd.ts\`. Do not edit by hand; run
\`pnpm --filter @yap/api exec tsx src/db/erd.ts\` after a schema change. ${total} tables.

Links to \`tenants\`, \`farms\` and \`users\` (\`tenant_id\`, \`farm_id\`, \`created_by\`) are on almost every
table and are left out of the lines to keep the diagrams readable. A table from another domain appears
as an empty box. Beyond the Drizzle schema, \`post-schema.sql\` adds PostGIS \`geom\` columns on \`fields\`
and \`facilities\`, row-level security, audit triggers, and a composite \`(tenant_id, id)\` twin for every
foreign key between tenant tables.
`;

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, '..', '..', '..', '..', 'docs', 'erd.md'), `${header}\n${sections.join('\n\n')}\n`);
console.log(`docs/erd.md: ${total} tables in ${sections.length} domains`);
