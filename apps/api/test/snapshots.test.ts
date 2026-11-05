import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tx } from '../src/core/context';
import { signFileToken } from '../src/core/tokens';
import { schema } from '../src/db/client';
import { createFixture, getApp } from './helpers';

/** Stands in for a camera gateway: nothing on this machine counts as a public address. */
const gateway = vi.hoisted(() => ({ answer: null as null | ((url: string) => Promise<{ status: number; body: Buffer }>) }));

vi.mock('../src/core/outbound', async (original) => {
  const real = await original<typeof import('../src/core/outbound')>();
  return { ...real, requestPublic: (...args: Parameters<typeof real.requestPublic>) => gateway.answer?.(args[0]) ?? real.requestPublic(...args) };
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

function gatewayAnswers(status: number, body: Buffer) {
  gateway.answer = vi.fn(async () => ({ status, body }));
  return gateway.answer;
}

afterEach(() => {
  gateway.answer = null;
});

/** A camera event and the link the feed gives for it. */
async function setup(snapshotUrl?: string) {
  const f = await createFixture();
  const owner = await f.as('owner');
  const [row] = await f.run(() =>
    tx()
      .insert(schema.events)
      .values({ tenantId: f.tenantId, farmId: f.farmId, type: 'camera.smoke', source: 'camera', severity: 'urgent', data: snapshotUrl ? { snapshotUrl } : {} })
      .returning({ id: schema.events.id }),
  );
  const feed = await owner.get('/devices/events');
  return { f, owner, id: row.id, link: feed.data.find((e: { id: string }) => e.id === row.id).snapshotLink as string | null };
}

async function open(link: string) {
  const app = await getApp();
  return app.inject({ url: link });
}

describe('camera snapshots', () => {
  it.each([
    ['image/jpeg', JPEG],
    ['image/png', PNG],
    ['image/webp', WEBP],
  ])('shows a %s frame from our own address, by what its bytes are', async (type, frame) => {
    const answer = gatewayAnswers(200, frame);
    const { link } = await setup('http://nvr.example/s.jpg');

    expect(link).toMatch(/^\/api\/v1\/devices\/events\/[0-9a-f-]+\/snapshot\?token=/);
    const res = await open(link!);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(type);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(res.rawPayload.equals(frame)).toBe(true);
    expect(answer).toHaveBeenCalledWith('http://nvr.example/s.jpg');
  });

  it('gives no link for an event without a frame', async () => {
    expect((await setup()).link).toBeNull();
  });

  it.each([
    ['a web page, which on our origin would run', 200, Buffer.from('<script>alert(1)</script>')],
    ['an SVG, which can carry a script', 200, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
    ['a redirect', 302, JPEG],
    ['an error', 500, JPEG],
  ])('passes on nothing when the gateway answers with %s', async (_what, status, body) => {
    gatewayAnswers(status, body);
    const { link } = await setup('http://nvr.example/s.jpg');

    const res = await open(link!);

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('SNAPSHOT_UNAVAILABLE');
  });

  it('says so when the gateway cannot be reached', async () => {
    gateway.answer = vi.fn(async () => {
      throw new Error('connect ETIMEDOUT');
    });
    const { link } = await setup('http://nvr.example/s.jpg');

    expect((await open(link!)).statusCode).toBe(502);
  });

  it('will not reach inside the server network, whatever a device claims', async () => {
    const { link } = await setup('http://169.254.169.254/latest/meta-data/');

    const res = await open(link!);

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('SNAPSHOT_UNAVAILABLE');
  });

  it('needs a link for that event, on that farm', async () => {
    const answer = gatewayAnswers(200, JPEG);
    const first = await setup('http://nvr.example/1.jpg');
    const second = await setup('http://nvr.example/2.jpg');
    const url = (id: string, token: string) => `/api/v1/devices/events/${id}/snapshot?token=${token}`;
    const [, token] = first.link!.split('token=');

    expect((await open(url(second.id, token))).statusCode).toBe(404);
    expect((await open(url(first.id, 'nonsense'))).statusCode).toBe(401);
    const wrongFarm = await signFileToken(first.id, second.f.tenantId, second.f.farmId);
    expect((await open(url(first.id, wrongFarm))).statusCode).toBe(404);
    expect((await open(`/api/v1/devices/events/${first.id}/snapshot`)).statusCode).toBe(400);
    expect(answer).not.toHaveBeenCalled();

    const rows = await first.f.run(() => tx().select().from(schema.events).where(and(eq(schema.events.id, first.id))));
    expect(rows).toHaveLength(1);
  });

  it('gives the feed to those who can see cameras, and no one else', async () => {
    const { f } = await setup('http://nvr.example/s.jpg');
    const accountant = await f.as('accountant');
    expect((await accountant.get('/devices/events')).status).toBe(403);
  });
});
