import { schema } from '../db/client';
import { ctx, tx } from '../core/context';
import { recordEvent } from '../core/journal';
import { findFacility } from './lookup';
import { SEED } from './names';
import type { SeedContext } from './types';

type Zone = 'barn' | 'feed_store' | 'gate' | 'pump';

/** The camera plan from spec 25.3: 10 cameras, within the planned 9 to 11. */
const CAMERAS: { name: string; zone: Zone; facility: string }[] = [
  { name: 'Molxona ichi — 1', zone: 'barn', facility: SEED.facility.barn },
  { name: 'Molxona ichi — 2', zone: 'barn', facility: SEED.facility.barn },
  { name: 'Molxona ichi — 3', zone: 'barn', facility: SEED.facility.barn },
  { name: 'Molxona ichi — 4', zone: 'barn', facility: SEED.facility.barn },
  { name: 'Molxona ichi — 5', zone: 'barn', facility: SEED.facility.barn },
  { name: 'Ozuqa ombori — kirish', zone: 'feed_store', facility: SEED.facility.feedStore },
  { name: 'Ozuqa ombori — ichki', zone: 'feed_store', facility: SEED.facility.feedStore },
  { name: 'Asosiy darvoza', zone: 'gate', facility: SEED.facility.gate },
  { name: 'Hovli', zone: 'gate', facility: SEED.facility.gate },
  { name: 'Suv va nasos inshooti', zone: 'pump', facility: SEED.facility.well },
];

/**
 * Cameras are `planned`: none are installed yet (spec section 16, phase 2). The one sensor is a
 * test device, and its events carry `sample: true` so nobody mistakes them for real readings.
 */
export async function seedDevices(s: SeedContext): Promise<void> {
  await s.run(async () => {
    const c = ctx();
    const base = { tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId };

    const facilityIds = new Map<string, string>();
    for (const name of new Set(CAMERAS.map((cam) => cam.facility))) {
      facilityIds.set(name, (await findFacility(name)).id);
    }

    await tx()
      .insert(schema.devices)
      .values(
        CAMERAS.map((cam) => ({
          ...base,
          type: 'camera',
          name: cam.name,
          facilityId: facilityIds.get(cam.facility),
          status: 'planned',
          config: { zone: cam.zone },
        })),
      );

    const lastSeenAt = new Date(Date.now() - 2 * 60_000);
    const [sensor] = await tx()
      .insert(schema.devices)
      .values({
        ...base,
        type: 'sensor',
        name: 'Molxona harorat datchigi (sinov)',
        facilityId: facilityIds.get(SEED.facility.barn),
        status: 'online',
        lastSeenAt,
        config: { zone: 'barn', offlineAfterMinutes: 60 },
        notes: "Sinov qurilmasi: ma'lumotlar namuna uchun.",
      })
      .returning();

    const reading = (type: string, data: Record<string, unknown>, hoursAgo: number) =>
      recordEvent({
        type,
        source: 'sensor',
        entityType: 'device',
        entityId: sensor.id,
        deviceId: sensor.id,
        occurredAt: new Date(Date.now() - hoursAgo * 3_600_000),
        data: { ...data, sample: true, deviceName: sensor.name },
      });

    await reading('sensor.temperature', { celsius: 11.4, humidity: 62 }, 3);
    await reading('sensor.temperature', { celsius: 10.8, humidity: 64 }, 1);
  });
}
