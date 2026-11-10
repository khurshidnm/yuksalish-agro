/**
 * The flock simulator (docs/tracking.md, "Simulating a sensored flock"). It invents readings:
 * run it on a demo farm only, never on one with real trackers.
 *
 *   tsx src/modules/tracking/simulator/cli.ts start    fit trackers, fill missing history, then run live
 *   tsx src/modules/tracking/simulator/cli.ts status   what is fitted and what arrived lately
 *   tsx src/modules/tracking/simulator/cli.ts remove   take every simulated tracker and reading away
 *
 * Options: --farm <id> (default: the farm with most sheep), --days <1-7> (history, default 7),
 * --url <api base> (default SIM_API_URL or http://localhost:4000), --tick <seconds> (default 30).
 * Needs the database settings the API uses (DATABASE_URL), because fitting trackers is the farmer's
 * work, done here through the same import the Trackers tab uses.
 */
import { parseArgs } from 'node:util';
import { and, eq, gte, like, sql } from 'drizzle-orm';
import { schema } from '../../../db/client';
import { tx, withTenant } from '../../../core/context';
import { evaluateHealth, summarizeDays } from '../health.service';
import { summarizeGrazing } from '../grazing.service';
import { SIM_PREFIX, loadFarm, pickFarm, removeSimulation, setupSimulation, simulatedSpan } from './farm';
import { backfill, httpTransport, live } from './runner';
import { World } from './world';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    farm: { type: 'string' },
    days: { type: 'string', default: process.env.SIM_HISTORY_DAYS ?? '7' },
    url: { type: 'string', default: process.env.SIM_API_URL ?? 'http://localhost:4000' },
    tick: { type: 'string', default: '30' },
  },
});

const command = positionals[0] ?? 'start';
const log = (line: string) => console.info(`${new Date().toISOString()} ${line}`);

async function main() {
  const farm = await pickFarm(values.farm);
  const inFarm = <T>(fn: () => Promise<T>) => withTenant(farm, fn);

  if (command === 'remove') {
    const removed = await inFarm(removeSimulation);
    log(`Removed ${removed.trackers} simulated trackers from ${removed.animals} animals, with their readings, and closed ${removed.alerts} alerts.`);
    return;
  }

  if (command === 'status') {
    const r = schema.trackerReadings;
    const counts = await inFarm(async () => {
      const [trackers] = await tx()
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(schema.devices)
        .where(and(eq(schema.devices.farmId, farm.farmId), like(schema.devices.externalId, `${SIM_PREFIX}%`)));
      const [lastHour] = await tx()
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(r)
        .where(and(eq(r.farmId, farm.farmId), gte(r.recordedAt, new Date(Date.now() - 60 * MIN))));
      return { trackers: trackers?.n ?? 0, lastHour: lastHour?.n ?? 0, span: await simulatedSpan() };
    });
    log(
      `Farm ${farm.farmId}: ${counts.trackers} simulated trackers, ${counts.lastHour} readings in the last hour, ` +
        `history ${counts.span.first?.toISOString() ?? 'none'} to ${counts.span.last?.toISOString() ?? 'none'}.`,
    );
    return;
  }

  const simFarm = await inFarm(loadFarm);
  const world = new World(simFarm);
  log(`Farm ${farm.farmId}: ${simFarm.sheep.length} sheep in ${simFarm.herds.length} herd(s), gateways ${simFarm.gateways.map((g) => g.id).join(', ')}.`);

  const { key, fitted, registered } = await inFarm(() => setupSimulation(simFarm));
  log(`Trackers: ${registered} registered, ${fitted} fitted in this run. Every sheep wears a collar and a bolus.`);
  if (command === 'setup') return;

  const transport = httpTransport(values.url, key);
  const now = Date.now();
  const days = Math.max(1, Math.min(7, Number(values.days) || 7));
  const span = await inFarm(simulatedSpan);
  // Fill what is missing: the whole history the first time, the gap after a pause otherwise.
  const from = span.last ? Math.max(span.last.getTime(), now - days * DAY) : now - days * DAY;
  if (now - from > 5 * MIN) {
    log(`Filling history from ${new Date(from).toISOString()}.`);
    const sent = await backfill(world, transport, from, now - MIN, log);
    log(`History done: ${sent} readings.`);
    await inFarm(async () => {
      const summaries = await summarizeDays();
      await summarizeGrazing();
      const health = await evaluateHealth(new Date(), true);
      log(`Daily summaries written: ${summaries}. Health rules: ${JSON.stringify(health)}.`);
    });
  }
  if (command === 'backfill') return;

  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop.abort());
  log(`Live: posting each uplink to ${values.url}/api/v1/tracking/ingest/chirpstack as it happens. Stop with Ctrl+C.`);
  await live(world, transport, now - MIN, { tickMs: Math.max(5, Number(values.tick) || 30) * 1000, applicationName: 'Yuksalish flock', log, signal: stop.signal });
  log('Stopped.');
}

if (!['start', 'setup', 'backfill', 'run', 'status', 'remove'].includes(command)) {
  console.error('usage: cli.ts start | setup | backfill | run | status | remove [--farm id] [--days 1-7] [--url base] [--tick seconds]');
  process.exit(2);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
