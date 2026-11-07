/**
 * Keeps an employee record and a login together. Staff often come in through Excel and get their
 * login separately, so the phone is what ties them: dismissal and check-in both rely on this link.
 */
import { and, eq, isNotNull, isNull, like, ne } from 'drizzle-orm';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { subscriberNumber } from '../../core/phone';

const { employees: t, memberships, users } = schema;

/**
 * The farm's login with this phone that no employee record holds yet. Two people sharing a number
 * link nobody: that is a guess, and a wrong guess would block the wrong person.
 */
export async function loginForPhone(phone: string | null | undefined): Promise<string | null> {
  const number = subscriberNumber(phone ?? '');
  if (number.length < 9) return null;
  const { farmId } = ctx();
  const rows = await tx()
    .select({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(t, and(eq(t.userId, memberships.userId), eq(t.farmId, farmId)))
    .where(and(eq(memberships.farmId, farmId), like(users.phone, `%${number}`), isNull(t.id)));
  return rows.length === 1 ? rows[0].userId : null;
}

/** Call when a login joins this farm: it finds the employee record already waiting for it. */
export async function linkEmployeeByPhone(userId: string, phone: string): Promise<void> {
  const { farmId } = ctx();
  const number = subscriberNumber(phone);
  const rows = await tx()
    .select({ id: t.id, phone: t.phone, userId: t.userId })
    .from(t)
    .where(and(eq(t.farmId, farmId), isNotNull(t.phone), ne(t.status, 'terminated')));
  if (rows.some((row) => row.userId === userId)) return;
  const matches = rows.filter((row) => !row.userId && subscriberNumber(row.phone!) === number);
  if (matches.length !== 1) return;
  await tx().update(t).set({ userId }).where(eq(t.id, matches[0].id));
}
