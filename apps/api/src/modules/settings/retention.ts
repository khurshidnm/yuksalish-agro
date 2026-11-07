/**
 * The one place rows go because of their age. docs/retention.md gives the reason for each table.
 * Nothing here touches the books, the journal, the audit log or stored files, which stay for ever.
 */
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { recordEvent } from '../../core/journal';
import type { FarmJob } from '../../jobs/types';

const { aiConversations, aiMessages, idempotencyKeys, importJobs, notifications, refreshTokens, telegramLinkCodes, trackerReadings, webhookDeliveries } = schema;

const DAY_MS = 86_400_000;
/** Global tables, so not a farm's to set. A dead session is kept a while for looking into a break-in. */
const DEAD_SESSION_DAYS = 30;
const DEAD_LINK_CODE_DAYS = 7;

const rowsIn = (result: { rowCount: number | null }) => result.rowCount ?? 0;

/** A delivery still waiting must go out, however old it is. */
const nothingWaiting = sql`not exists (select 1 from jsonb_each_text(${notifications.deliveries}) d where d.value = 'pending')`;

/**
 * Tables and charts are copies of figures the books still hold, and the rest shows how an answer was
 * reached. The words stay, and so do the tool names and cards: they are how a later reader who has
 * lost finance.view is kept from an answer that held money (heldMoney in modules/ai/conversations.ts).
 */
function clearToolData(olderThan: Date) {
  const { farmId } = ctx();
  return tx().execute(sql`
    update ${aiMessages} m
    set content = (m.content - 'sources' - 'usage') || jsonb_build_object(
      'toolCalls', coalesce((select jsonb_agg(call - 'input') from jsonb_array_elements(m.content -> 'toolCalls') call), '[]'::jsonb),
      'attachments', coalesce((select jsonb_agg(item) from jsonb_array_elements(m.content -> 'attachments') item
                               where item ->> 'type' not in ('table', 'chart')), '[]'::jsonb)
    )
    where m.role = 'assistant'
      and m.created_at < ${olderThan}
      and jsonb_exists(m.content, 'sources')
      and m.conversation_id in (select id from ${aiConversations} where farm_id = ${farmId})`);
}

export async function applyRetention(now = new Date()) {
  const { tenantId, farmId, settings } = ctx();
  const days = settings.retention;
  const ago = (n: number) => new Date(now.getTime() - n * DAY_MS);
  const importsBefore = lt(importJobs.createdAt, ago(days.importDays));

  const removed = {
    notifications: rowsIn(
      await tx()
        .delete(notifications)
        .where(
          and(
            eq(notifications.tenantId, tenantId),
            or(eq(notifications.farmId, farmId), isNull(notifications.farmId)),
            lt(notifications.createdAt, ago(days.notificationDays)),
            nothingWaiting,
          ),
        ),
    ),
    idempotencyKeys: rowsIn(
      await tx()
        .delete(idempotencyKeys)
        .where(and(eq(idempotencyKeys.tenantId, tenantId), lt(idempotencyKeys.createdAt, ago(days.idempotencyDays)))),
    ),
    webhookDeliveries: rowsIn(
      await tx()
        .delete(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.farmId, farmId),
            inArray(webhookDeliveries.status, ['delivered', 'failed']),
            lt(webhookDeliveries.createdAt, ago(days.webhookDeliveryDays)),
          ),
        ),
    ),
    aiToolData: rowsIn(await clearToolData(ago(days.aiToolDataDays))),
    abandonedImports: rowsIn(
      await tx()
        .delete(importJobs)
        .where(and(eq(importJobs.farmId, farmId), inArray(importJobs.status, ['preview', 'discarded']), importsBefore)),
    ),
    importedRows: rowsIn(
      await tx()
        .update(importJobs)
        .set({ rows: [], errors: [], warnings: [] })
        .where(
          and(
            eq(importJobs.farmId, farmId),
            eq(importJobs.status, 'confirmed'),
            importsBefore,
            sql`(${importJobs.rows} <> '[]'::jsonb or ${importJobs.errors} <> '[]'::jsonb or ${importJobs.warnings} <> '[]'::jsonb)`,
          ),
        ),
    ),
    // The tracking job has already kept each animal's day in animal_track_days.
    trackerReadings: rowsIn(
      await tx()
        .delete(trackerReadings)
        .where(and(eq(trackerReadings.farmId, farmId), lt(trackerReadings.recordedAt, ago(days.trackerReadingsDays)))),
    ),
    sessions: rowsIn(await tx().delete(refreshTokens).where(lt(refreshTokens.expiresAt, ago(DEAD_SESSION_DAYS)))),
    linkCodes: rowsIn(await tx().delete(telegramLinkCodes).where(lt(telegramLinkCodes.expiresAt, ago(DEAD_LINK_CODE_DAYS)))),
  };

  if (Object.values(removed).some((count) => count > 0)) {
    await recordEvent({ type: 'retention.applied', data: { removed, days } });
    console.info(`[retention] farm ${farmId}: ${JSON.stringify(removed)}`);
  }
  return removed;
}

/** After the last backup of the night and before the 04:30 reboot window. */
export const retentionJob: FarmJob = {
  name: 'settings.retention',
  cron: '45 3 * * *',
  run: async () => void (await applyRetention()),
};
