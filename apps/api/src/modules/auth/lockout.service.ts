/**
 * The brake on guessing. Passwords are counted per phone and address together, so a stranger
 * elsewhere cannot lock the real person out, and no lock outlasts LOCK_MINUTES. Unknown phones
 * are counted the same way, so a lock says nothing about which phones have accounts.
 */
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { db, schema } from '../../db/client';
import { AppError } from '../../core/errors';

const { signInFailures } = schema;

export const MAX_FAILURES = 10;
export const LOCK_MINUTES = 15;

/** Who holds the password alone reaches the code step, so its tries are counted across all addresses. */
export const CODE_STEP = 'code-step';

function lockedError(until: Date): AppError {
  const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
  return new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${minutes} min.`, { minutes });
}

export async function assertNotLocked(phone: string, address: string): Promise<void> {
  const [row] = await db
    .select({ lockedUntil: signInFailures.lockedUntil })
    .from(signInFailures)
    .where(and(eq(signInFailures.phone, phone), eq(signInFailures.address, address), gt(signInFailures.lockedUntil, new Date())));
  if (row?.lockedUntil) throw lockedError(row.lockedUntil);
}

/**
 * Count one failure. Returns the error to throw when this one starts a lock, and only that one
 * does: counting is atomic, so parallel guesses cannot start two locks or journal one twice.
 */
export async function recordFailure(phone: string, address: string): Promise<AppError | null> {
  const stale = sql`${signInFailures.windowStartedAt} < now() - make_interval(mins => ${LOCK_MINUTES})`;
  const [row] = await db
    .insert(signInFailures)
    .values({ phone, address, failures: 1 })
    .onConflictDoUpdate({
      target: [signInFailures.phone, signInFailures.address],
      set: {
        failures: sql`case when ${stale} then 1 else ${signInFailures.failures} + 1 end`,
        windowStartedAt: sql`case when ${stale} then now() else ${signInFailures.windowStartedAt} end`,
        // A lock ends with its window, so a guess already in flight cannot lift one.
        lockedUntil: sql`case when ${stale} then null else ${signInFailures.lockedUntil} end`,
      },
    })
    .returning({ failures: signInFailures.failures });
  await db.delete(signInFailures).where(lt(signInFailures.windowStartedAt, new Date(Date.now() - 86_400_000)));
  if (row.failures !== MAX_FAILURES) return null;

  const until = new Date(Date.now() + LOCK_MINUTES * 60_000);
  await db
    .update(signInFailures)
    .set({ lockedUntil: until, failures: 0, windowStartedAt: new Date() })
    .where(and(eq(signInFailures.phone, phone), eq(signInFailures.address, address)));
  return lockedError(until);
}

export async function clearFailures(phone: string, address: string): Promise<void> {
  await db.delete(signInFailures).where(and(eq(signInFailures.phone, phone), eq(signInFailures.address, address)));
}

/** A person given a new way in must not wait out a lock on the old one. */
export async function unlockPhone(phone: string): Promise<void> {
  await db.delete(signInFailures).where(eq(signInFailures.phone, phone));
}
