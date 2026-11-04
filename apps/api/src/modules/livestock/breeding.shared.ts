/** Helpers shared by the breeding and health services. */
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '../../db/client';
import { tx } from '../../core/context';

const { breedingRecords, healthRecords } = schema;

/**
 * The status an animal settles into when a temporary state ends. An animal has one status, so
 * these overlap: a pregnant ewe can be sick, and in quarantine too. Most urgent wins.
 */
export async function restingStatus(animalId: string): Promise<'quarantine' | 'sick' | 'pregnant' | 'active'> {
  const [quarantine] = await tx()
    .select({ id: healthRecords.id })
    .from(healthRecords)
    .where(and(eq(healthRecords.animalId, animalId), eq(healthRecords.type, 'quarantine'), isNull(healthRecords.endedOn)))
    .limit(1);
  if (quarantine) return 'quarantine';

  const [sick] = await tx()
    .select({ id: healthRecords.id })
    .from(healthRecords)
    .where(and(eq(healthRecords.animalId, animalId), eq(healthRecords.reportStatus, 'open')))
    .limit(1);
  if (sick) return 'sick';

  const [pregnant] = await tx()
    .select({ id: breedingRecords.id })
    .from(breedingRecords)
    .where(and(eq(breedingRecords.eweId, animalId), eq(breedingRecords.status, 'pregnant')))
    .limit(1);
  return pregnant ? 'pregnant' : 'active';
}

/** Monday of the week containing a date. */
export function weekStart(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const fromMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - fromMonday);
  return d.toISOString().slice(0, 10);
}
