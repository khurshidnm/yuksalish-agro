/**
 * Outgoing webhooks (spec 19.1). Subscriptions read the event journal through a cursor, so every
 * module's recordEvent() is covered without touching the kernel. Two steps, both driven by the
 * jobs in ./jobs.ts: collect new events into deliveries, then send what is due.
 */
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { and, asc, desc, eq, gt, lte, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { isProd } from '../../config';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { randomToken, seal, unseal } from '../../core/crypto';
import { badRequest, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { dnsResolver, isPrivateAddress, requestPublic, type Resolver } from '../../core/outbound';
import { listQuery, paged } from '../../core/query';

const { events, webhookDeliveries, webhookSubscriptions } = schema;

/** Minutes to wait before attempt 2, 3, 4... After the last one the delivery is `failed`. */
export const RETRY_MINUTES = [1, 5, 30, 120, 360];
const SEND_TIMEOUT_MS = 5_000;
const BATCH_SIZE = 20;
/** Skip the newest events, so a transaction that commits late is not stepped over by the cursor. */
const COMMIT_LAG_SECONDS = 30;

const eventPattern = z.string().regex(/^(\*|[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?)$/).max(60);

export const webhookInput = z.object({
  url: z.url({ protocol: /^https?$/ }).max(500),
  description: z.string().trim().max(200).nullish(),
  eventTypes: z.array(eventPattern).min(1).max(30),
});

export const webhookUpdate = webhookInput.partial().extend({ active: z.boolean().optional() });
export const deliveryQuery = listQuery.extend({ status: z.enum(['pending', 'delivered', 'failed']).optional() });

const publicColumns = {
  id: webhookSubscriptions.id,
  url: webhookSubscriptions.url,
  description: webhookSubscriptions.description,
  eventTypes: webhookSubscriptions.eventTypes,
  active: webhookSubscriptions.active,
  createdAt: webhookSubscriptions.createdAt,
};

/** "sale.created" matches "sale.created", "sale.*" and "*". */
export function matchesEvent(patterns: string[], type: string): boolean {
  return patterns.some(
    (p) => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))),
  );
}

/**
 * A subscriber URL is tenant input. Checked when saving, so a mistake shows up at once, and again before
 * each send, because DNS can change after the URL was accepted. requestPublic() checks once more, for the
 * connection itself, so an answer that changes after this check gets nowhere either.
 */
export async function assertSafeUrl(raw: string, resolve: Resolver = dnsResolver): Promise<void> {
  const url = new URL(raw);
  if (isProd && url.protocol !== 'https:') {
    throw badRequest('WEBHOOK_URL_NOT_ALLOWED', 'Webhook addresses must use https');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    throw badRequest('WEBHOOK_URL_NOT_ALLOWED', 'This address could not be resolved');
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw badRequest('WEBHOOK_URL_NOT_ALLOWED', 'Webhook addresses must be public');
  }
}

export async function listWebhooks() {
  return tx()
    .select(publicColumns)
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.farmId, ctx().farmId))
    .orderBy(desc(webhookSubscriptions.createdAt));
}

/** The signing secret is returned here once. */
export async function createWebhook(input: z.infer<typeof webhookInput>, resolve?: Resolver) {
  await assertSafeUrl(input.url, resolve);
  const c = ctx();
  const secret = `whsec_${randomToken(32)}`;
  const [row] = await tx()
    .insert(webhookSubscriptions)
    .values({
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      url: input.url,
      description: input.description,
      eventTypes: input.eventTypes,
      secret: seal(secret),
      // A new subscriber gets events from now on, not the farm's whole history.
      cursor: uuidv7(),
    })
    .returning(publicColumns);
  await recordEvent({ type: 'webhook.created', severity: 'attention', entityType: 'webhook', entityId: row.id, data: { url: row.url } });
  return { ...row, secret };
}

export async function updateWebhook(id: string, input: z.infer<typeof webhookUpdate>, resolve?: Resolver) {
  if (input.url) await assertSafeUrl(input.url, resolve);
  if (Object.keys(input).length === 0) throw badRequest('NOTHING_TO_UPDATE', 'No changes were sent');
  const [row] = await tx()
    .update(webhookSubscriptions)
    .set(input)
    .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.farmId, ctx().farmId)))
    .returning(publicColumns);
  if (!row) throw notFound('Webhook');
  return row;
}

export async function deleteWebhook(id: string) {
  const [row] = await tx()
    .delete(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.farmId, ctx().farmId)))
    .returning({ id: webhookSubscriptions.id });
  if (!row) throw notFound('Webhook');
  await recordEvent({ type: 'webhook.deleted', entityType: 'webhook', entityId: id });
  return row;
}

export async function listDeliveries(subscriptionId: string, q: z.infer<typeof deliveryQuery>) {
  const where = and(
    eq(webhookDeliveries.farmId, ctx().farmId),
    eq(webhookDeliveries.subscriptionId, subscriptionId),
    q.status ? eq(webhookDeliveries.status, q.status) : undefined,
  );
  return paged(q, webhookDeliveries, where, (limit, offset) =>
    tx()
      .select({
        id: webhookDeliveries.id,
        eventType: webhookDeliveries.eventType,
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        nextAttemptAt: webhookDeliveries.nextAttemptAt,
        lastStatusCode: webhookDeliveries.lastStatusCode,
        lastError: webhookDeliveries.lastError,
        deliveredAt: webhookDeliveries.deliveredAt,
        createdAt: webhookDeliveries.createdAt,
      })
      .from(webhookDeliveries)
      .where(where)
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(limit)
      .offset(offset),
  );
}

/** Queue a delivery again now, e.g. after the subscriber fixed their endpoint. */
export async function retryDelivery(subscriptionId: string, deliveryId: string) {
  const [row] = await tx()
    .update(webhookDeliveries)
    .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null })
    .where(
      and(
        eq(webhookDeliveries.id, deliveryId),
        eq(webhookDeliveries.subscriptionId, subscriptionId),
        eq(webhookDeliveries.farmId, ctx().farmId),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  if (!row) throw notFound('Delivery');
  return row;
}

/** Queue a test event straight away, so a subscriber can check their endpoint. */
export async function queueTest(subscriptionId: string) {
  const c = ctx();
  const [sub] = await tx()
    .select({ id: webhookSubscriptions.id })
    .from(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.id, subscriptionId), eq(webhookSubscriptions.farmId, c.farmId)));
  if (!sub) throw notFound('Webhook');
  const id = uuidv7();
  await tx().insert(webhookDeliveries).values({
    id,
    tenantId: c.tenantId,
    farmId: c.farmId,
    createdBy: c.userId,
    subscriptionId,
    eventType: 'webhook.test',
    payload: { id, type: 'webhook.test', occurredAt: new Date().toISOString(), farmId: c.farmId, data: { test: true } },
  });
  return { id };
}

/** Step 1: turn new journal events into deliveries. */
export async function collectEvents(): Promise<number> {
  const c = ctx();
  const subscriptions = await tx()
    .select()
    .from(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.farmId, c.farmId), eq(webhookSubscriptions.active, true)))
    .for('update', { skipLocked: true });

  let queued = 0;
  for (const sub of subscriptions) {
    const rows = await tx()
      .select()
      .from(events)
      .where(
        and(
          eq(events.farmId, c.farmId),
          gt(events.id, sub.cursor),
          sql`${events.createdAt} < now() - make_interval(secs => ${COMMIT_LAG_SECONDS})`,
        ),
      )
      .orderBy(asc(events.id))
      .limit(500);
    if (rows.length === 0) continue;

    const matching = rows.filter((e) => matchesEvent(sub.eventTypes, e.type));
    if (matching.length > 0) {
      await tx()
        .insert(webhookDeliveries)
        .values(
          matching.map((e) => ({
            tenantId: c.tenantId,
            farmId: c.farmId,
            subscriptionId: sub.id,
            eventId: e.id,
            eventType: e.type,
            payload: {
              id: e.id,
              type: e.type,
              occurredAt: e.occurredAt.toISOString(),
              farmId: e.farmId,
              severity: e.severity,
              entityType: e.entityType,
              entityId: e.entityId,
              data: e.data,
            },
          })),
        );
      queued += matching.length;
    }
    await tx()
      .update(webhookSubscriptions)
      .set({ cursor: rows[rows.length - 1].id })
      .where(eq(webhookSubscriptions.id, sub.id));
  }
  return queued;
}

/** Header value receivers verify: HMAC-SHA256 of "<timestamp>.<body>". See docs/device-events.md. */
export function signPayload(secret: string, timestamp: number, body: string): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

type Sender = (
  url: string,
  init: { method: 'POST'; signal: AbortSignal; headers: Record<string, string>; body: string },
) => Promise<{ status: number }>;

export interface SendOptions {
  fetchImpl?: Sender;
  resolve?: Resolver;
  now?: Date;
}

interface SendResult {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
}

async function send(
  delivery: typeof webhookDeliveries.$inferSelect,
  sub: { url: string; secret: string },
  { fetchImpl = (url, init) => requestPublic(url, init, resolve), resolve }: SendOptions,
): Promise<SendResult> {
  try {
    await assertSafeUrl(sub.url, resolve);
    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetchImpl(sub.url, {
      method: 'POST',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'YAP-Webhooks/1.0',
        'x-yap-event': delivery.eventType,
        'x-yap-delivery': delivery.id,
        'x-yap-signature': signPayload(unseal(sub.secret), timestamp, body),
      },
      body,
    });
    const ok = response.status >= 200 && response.status < 300;
    return { ok, statusCode: response.status, error: ok ? null : `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, statusCode: null, error: err instanceof Error ? err.message.slice(0, 300) : 'Send failed' };
  }
}

/** Step 2: send what is due. Requests run side by side, so the job holds its transaction briefly. */
export async function deliverDue(options: SendOptions = {}): Promise<{ delivered: number; failed: number; retried: number }> {
  const now = options.now ?? new Date();
  const due = await tx()
    .select({ delivery: webhookDeliveries, url: webhookSubscriptions.url, secret: webhookSubscriptions.secret })
    .from(webhookDeliveries)
    .innerJoin(webhookSubscriptions, eq(webhookSubscriptions.id, webhookDeliveries.subscriptionId))
    .where(
      and(
        eq(webhookDeliveries.farmId, ctx().farmId),
        eq(webhookDeliveries.status, 'pending'),
        lte(webhookDeliveries.nextAttemptAt, now),
        eq(webhookSubscriptions.active, true),
      ),
    )
    .orderBy(asc(webhookDeliveries.nextAttemptAt))
    .limit(BATCH_SIZE)
    .for('update', { of: webhookDeliveries, skipLocked: true });

  const results = await Promise.all(due.map((row) => send(row.delivery, row, options)));

  const tally = { delivered: 0, failed: 0, retried: 0 };
  for (const [index, row] of due.entries()) {
    const result = results[index];
    const attempts = row.delivery.attempts + 1;
    const wait = RETRY_MINUTES[attempts - 1];
    const giveUp = !result.ok && wait === undefined;
    tally[result.ok ? 'delivered' : giveUp ? 'failed' : 'retried'] += 1;
    await tx()
      .update(webhookDeliveries)
      .set({
        status: result.ok ? 'delivered' : giveUp ? 'failed' : 'pending',
        attempts,
        lastStatusCode: result.statusCode,
        lastError: result.error,
        deliveredAt: result.ok ? now : null,
        ...(result.ok || giveUp ? {} : { nextAttemptAt: new Date(now.getTime() + wait * 60_000) }),
      })
      .where(eq(webhookDeliveries.id, row.delivery.id));
  }
  return tally;
}
