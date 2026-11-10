/**
 * The field worker's home screen, and everything their phone needs to keep working offline.
 * One compact response, so a bad connection only has to survive one request.
 *
 * This payload is stored on the device, so it carries no money for any role, and no personal data
 * beyond the caller's own attendance.
 */
import { and, asc, eq, inArray, min, ne } from 'drizzle-orm';
import { z } from 'zod';
import { ANIMAL_ON_FARM_STATUSES, type Permission } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, hasPermission, today, tx } from '../../core/context';
import { notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { isoDate } from '../../core/query';
import { raiseAlert } from '../alerts/alerts.service';
import { myDay } from '../hr/timesheets.service';
import { lookup as lookupItems } from '../inventory/items.service';
import { lookup as lookupWarehouses } from '../inventory/warehouses.service';
import { dayOverview, getDailyLog, getPlan } from '../livestock/daily-logs.service';
import { list as listTasks } from '../tasks/tasks.service';

const { animalIdentifiers, animals, breedingRecords, dailyLogs, herds, items } = schema;

/** Enough for any phone to search instantly. Larger farms still get the rest from the server. */
const ANIMAL_DIRECTORY_LIMIT = 20_000;

/**
 * Quick actions on the home screen (spec 18.1). Derived from permissions, not role names, so a
 * tenant's custom role gets the buttons its permissions allow.
 */
const QUICK_ACTIONS: { key: string; anyOf: Permission[] }[] = [
  { key: 'daily_log', anyOf: ['livestock.create'] },
  { key: 'report_sick', anyOf: ['health.create'] },
  { key: 'record_death', anyOf: ['livestock.create'] },
  { key: 'weight', anyOf: ['livestock.update'] },
  { key: 'lambing', anyOf: ['livestock.create', 'health.update'] },
  { key: 'night_watch', anyOf: ['livestock.create'] },
  { key: 'animals', anyOf: ['livestock.view'] },
  { key: 'health', anyOf: ['health.update'] },
  { key: 'field_operation', anyOf: ['crops.create'] },
  { key: 'field_map', anyOf: ['farm.view'] },
  { key: 'machinery', anyOf: ['assets.view'] },
  { key: 'stock', anyOf: ['inventory.view'] },
  { key: 'rations', anyOf: ['feed.view'] },
];

function quickActions(): string[] {
  return QUICK_ACTIONS.filter((a) => a.anyOf.some(hasPermission)).map((a) => a.key);
}

/** Open tasks assigned to me that are due by today, overdue ones first. Undated tasks count as due. */
async function myTasks(date: string) {
  if (!hasPermission('tasks.view')) return [];
  const { data } = await listTasks({ page: 1, pageSize: 50, mine: true, active: true });
  return data
    .filter((task) => task.dueDate === null || task.dueDate <= date)
    .map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      dueDate: task.dueDate,
      priority: task.priority,
      status: task.status,
      requiresPhoto: task.requiresPhoto,
      requiresRecord: task.requiresRecord,
      entityLabel: task.entityLabel,
    }));
}

async function attendance() {
  const day = await myDay();
  if (!day.employee) return null;
  return {
    status: day.today?.status ?? null,
    checkIn: day.today?.checkIn ?? null,
    checkOut: day.today?.checkOut ?? null,
    openShift: Boolean(day.openShift),
  };
}

/** Today's record of a herd, for correcting it. Lines without their cost. */
async function loggedDay(logId: string) {
  const log = await getDailyLog(logId);
  return {
    id: log.id,
    updatedAt: log.updatedAt,
    createdBy: log.createdBy,
    headCount: log.headCount,
    waterL: log.waterL,
    condition: log.condition,
    notes: log.notes,
    lines: log.lines.map((line) => ({ itemId: line.itemId, actualQty: line.actualQty })),
  };
}

async function herdReference(date: string) {
  if (!hasPermission('livestock.create')) return [];
  const { herds: rows } = await dayOverview(date);
  const result = [];
  for (const herd of rows) {
    const plan = await getPlan(herd.id, date);
    result.push({
      id: herd.id,
      name: herd.name,
      state: herd.state,
      headCount: herd.headCount,
      lines: plan.lines.map((line) => ({
        itemId: line.itemId,
        itemName: line.itemName,
        unit: line.unit,
        plannedQty: line.plannedQty,
        qtyOnHand: line.qtyOnHand,
      })),
      log: herd.logId ? await loggedDay(herd.logId) : null,
    });
  }
  return result;
}

async function feedReference() {
  if (!hasPermission('livestock.create')) return { feedItems: [], warehouses: [] };
  const feedItems = await lookupItems({ category: ['feed'] });
  const warehouses = await lookupWarehouses({ type: 'feed' });
  return {
    feedItems: feedItems.map((i) => ({
      id: i.id,
      name: i.name,
      unit: i.unit,
      qtyOnHand: i.qtyOnHand,
      defaultWarehouseId: i.defaultWarehouseId,
    })),
    warehouses,
  };
}

export async function overview() {
  const date = today();
  return {
    date,
    generatedAt: new Date().toISOString(),
    tasks: await myTasks(date),
    attendance: await attendance(),
    actions: quickActions(),
    herds: await herdReference(date),
    ...(await feedReference()),
  };
}

/**
 * Every animal on the farm, for finding one by tag with no connection. Kept separate from the
 * overview because it is the one large response, and it changes far less often.
 */
export async function animalDirectory() {
  const { farmId } = ctx();
  const onFarm = and(eq(animals.farmId, farmId), inArray(animals.status, [...ANIMAL_ON_FARM_STATUSES]));
  const rows = await tx()
    .select({
      id: animals.id,
      tag: animals.tag,
      sex: animals.sex,
      category: animals.category,
      status: animals.status,
      herdId: animals.herdId,
    })
    .from(animals)
    .where(onFarm)
    .orderBy(asc(animals.tag))
    .limit(ANIMAL_DIRECTORY_LIMIT + 1);

  /** Other codes on the animal, for matching a scanned RFID or QR value. */
  const extraCodes = await tx()
    .select({ animalId: animalIdentifiers.animalId, value: animalIdentifiers.value })
    .from(animalIdentifiers)
    .innerJoin(animals, eq(animals.id, animalIdentifiers.animalId))
    .where(and(onFarm, eq(animalIdentifiers.active, true), ne(animalIdentifiers.value, animals.tag)));
  const codes = new Map<string, string[]>();
  for (const { animalId, value } of extraCodes) codes.set(animalId, [...(codes.get(animalId) ?? []), value]);

  /** Open pregnancies, so the lambing form can offer the right ewes. */
  const pregnancies = await tx()
    .select({ eweId: breedingRecords.eweId, expectedDate: min(breedingRecords.expectedDate) })
    .from(breedingRecords)
    .where(and(eq(breedingRecords.farmId, farmId), eq(breedingRecords.status, 'pregnant')))
    .groupBy(breedingRecords.eweId);
  const expected = new Map(pregnancies.map((p) => [p.eweId, p.expectedDate]));

  return {
    truncated: rows.length > ANIMAL_DIRECTORY_LIMIT,
    animals: rows.slice(0, ANIMAL_DIRECTORY_LIMIT).map((row) => ({
      ...row,
      codes: codes.get(row.id) ?? [],
      expectedDate: expected.get(row.id) ?? null,
    })),
  };
}

export const conflictReportInput = z.object({
  /** The outbox record's id: the same conflict reported twice is one alert. */
  id: z.uuid(),
  herdId: z.uuid(),
  date: isoDate,
  /** Null when the record was refused outright, such as for short stock: nothing is saved to compare it with. */
  serverLogId: z.uuid().nullish(),
  mine: z.object({
    headCount: z.number().int().min(0).nullish(),
    waterL: z.number().min(0).nullish(),
    condition: z.string().max(20).nullish(),
    notes: z.string().max(1000).nullish(),
    lines: z.array(z.object({ itemId: z.uuid(), actualQty: z.number().min(0) })).max(30),
  }),
});

/**
 * A shepherd cannot overwrite a colleague's record for the day, or get a refused one in, and must not
 * lose their own. This keeps their version in the journal and asks someone who may change the record to decide.
 */
export async function reportConflict(input: z.infer<typeof conflictReportInput>) {
  const { farmId } = ctx();
  const [herd] = await tx()
    .select({ id: herds.id, name: herds.name })
    .from(herds)
    .where(and(eq(herds.id, input.herdId), eq(herds.farmId, farmId)));
  if (!herd) throw notFound('Herd');
  if (input.serverLogId) {
    const [log] = await tx()
      .select({ id: dailyLogs.id })
      .from(dailyLogs)
      .where(and(eq(dailyLogs.id, input.serverLogId), eq(dailyLogs.farmId, farmId)));
    if (!log) throw notFound('Daily log');
  }

  const names = await tx()
    .select({ id: items.id, name: items.name, unit: items.unit })
    .from(items)
    .where(and(eq(items.farmId, farmId), inArray(items.id, input.mine.lines.map((l) => l.itemId))));
  const lines = input.mine.lines.map((line) => {
    const item = names.find((n) => n.id === line.itemId);
    return { ...line, itemName: item?.name ?? null, unit: item?.unit ?? null };
  });

  await recordEvent({
    type: 'herd.daily_log_conflict',
    entityType: 'herd',
    entityId: herd.id,
    severity: 'attention',
    occurredAt: input.date,
    data: { outboxId: input.id, serverLogId: input.serverLogId, mine: { ...input.mine, lines } },
  });

  const summary = lines.map((l) => `${l.itemName ?? l.itemId}: ${l.actualQty} ${l.unit ?? ''}`.trim()).join(', ');
  await raiseAlert({
    ruleKey: 'offline_conflict',
    dedupKey: `offline_conflict:${input.id}`,
    severity: 'attention',
    title: input.serverLogId ? `${herd.name}: ${input.date} kuni uchun ikki xil yozuv` : `${herd.name}: ${input.date} kungi yozuv qabul qilinmadi`,
    body: `${input.serverLogId ? 'Oflayn kiritilgan yozuv saqlangan yozuvga mos kelmadi.' : "Oflayn kiritilgan yozuv rad etildi, uni qo'lda kiritish kerak."} Oflayn yozuv: ${summary || "ozuqa ko'rsatilmagan"}.`,
    link: '/livestock/daily-logs',
    entityType: 'herd',
    entityId: herd.id,
    notify: ['zootechnician', 'director'],
    data: {
      herd: herd.name,
      date: input.date,
      summary: summary || (input.serverLogId ? '' : '—'),
      ...(input.serverLogId ? (summary ? {} : { textKey: 'offline_conflict_empty' }) : { textKey: 'offline_refused' }),
    },
  });
  return { reported: true };
}
