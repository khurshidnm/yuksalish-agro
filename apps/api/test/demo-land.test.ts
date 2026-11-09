import { addDays, todayIso } from '@yap/shared';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ctx, tx } from '../src/core/context';
import { schema } from '../src/db/client';
import { evaluateRules } from '../src/modules/alerts/rules';
import { createFixture, type Fixture } from './helpers';

const HOUR = 3_600_000;
const day = (offset: number) => addDays(todayIso(), offset);
const base = () => ({ tenantId: ctx().tenantId, farmId: ctx().farmId });
const localHour = (time: Date) => (time.getUTCHours() + 5) % 24;
const localDate = (time: Date) => todayIso('Asia/Tashkent', time);

/** A field with a spraying planned for tomorrow, and 64 hours of forecast from now. */
async function plannedSpraying(f: Fixture, calmTempC: number) {
  return f.run(async () => {
    const [field] = await tx().insert(schema.fields).values({ ...base(), number: 'S-1', areaHa: 10 }).returning();
    const [op] = await tx()
      .insert(schema.fieldOperations)
      .values({ ...base(), type: 'protection', status: 'planned', date: day(1), fieldId: field.id })
      .returning();
    // Tomorrow from 10:00 to 14:00 the air is calm; every other hour is too windy to spray.
    const from = Math.floor(Date.now() / HOUR) * HOUR;
    const rows = [];
    for (let i = 0; i < 64; i++) {
      const time = new Date(from + i * HOUR);
      const calm = localDate(time) === day(1) && localHour(time) >= 10 && localHour(time) < 14;
      rows.push({ ...base(), time, periodHours: 1, tempC: calm ? calmTempC : 15, rhPct: 60, windMs: calm ? 2 : 8, precipMm: 0 });
    }
    await tx().insert(schema.weatherHourly).values(rows);
    return { field, op };
  });
}

async function sprayAlerts(f: Fixture) {
  return f.run(() => tx().select().from(schema.alerts).where(and(eq(schema.alerts.ruleKey, 'spray_window'), sql`status <> 'resolved'`)));
}

describe('spraying advice and the cold', () => {
  it('does not offer calm hours below 8 °C as a time to spray', async () => {
    const f = await createFixture();
    const { field, op } = await plannedSpraying(f, 4);
    await f.run(() => evaluateRules());
    const [alert] = await sprayAlerts(f);
    expect(alert).toMatchObject({ dedupKey: `spray_window:${op.id}`, entityId: op.id });
    // No good hours anywhere, so no "best time" is named.
    expect(alert.data).toEqual({ field: field.number, date: day(1), textKey: 'spray_window_none' });
  });

  it('stays quiet when the same calm hours are warm enough', async () => {
    const f = await createFixture();
    await plannedSpraying(f, 12);
    await f.run(() => evaluateRules());
    expect(await sprayAlerts(f)).toEqual([]);
  });
});
