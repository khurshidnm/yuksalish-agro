/**
 * Every account on the platform, across tenants. Identity data only: password hashes and 2FA secrets
 * are never selected, and business data stays out of reach through withPlatform().
 */
import bcrypt from 'bcryptjs';
import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config';
import { schema } from '../../db/client';
import { withPlatform } from '../../core/context';
import { randomToken } from '../../core/crypto';
import { conflict, forbidden, notFound } from '../../core/errors';
import { listQuery } from '../../core/query';
import { revokeAllSessions } from '../auth/auth.service';
import { dropTelegramLink, notifyAccount, PASSWORD_NOTICE } from '../notifications/notifications.service';

const { users } = schema;

export const userListQuery = listQuery.extend({ status: z.enum(['active', 'blocked']).optional() });

const userColumns = {
  id: users.id,
  fullName: users.fullName,
  phone: users.phone,
  email: users.email,
  status: users.status,
  isPlatformAdmin: users.isPlatformAdmin,
  totpEnabled: users.totpEnabled,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  memberships: sql<{ tenant: string; farm: string; role: string; status: string }[]>`coalesce((
    select json_agg(json_build_object('tenant', t.name, 'farm', f.name, 'role', r.key, 'status', m.status) order by t.name, f.name)
    from memberships m
    join tenants t on t.id = m.tenant_id
    join farms f on f.id = m.farm_id
    join roles r on r.id = m.role_id
    where m.user_id = "users"."id"
  ), '[]'::json)`,
};

export async function listUsers(q: z.infer<typeof userListQuery>) {
  const term = q.search ? `%${q.search.replace(/[\\%_]/g, '\\$&')}%` : null;
  const where = and(
    q.status ? eq(users.status, q.status) : undefined,
    term ? or(ilike(users.fullName, term), ilike(users.phone, term), ilike(users.email, term)) : undefined,
  );
  return withPlatform(async (trx) => {
    const data = await trx
      .select(userColumns)
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ total }] = await trx.select({ total: count() }).from(users).where(where);
    return { data, meta: { page: q.page, pageSize: q.pageSize, total } };
  });
}

/** Blocks the account everywhere, for every tenant, and signs it out of every device. */
export async function setUserStatus(id: string, status: 'active' | 'blocked', adminId: string | undefined) {
  if (id === adminId) throw forbidden('You cannot block yourself', 'CANNOT_BLOCK_SELF');
  const updated = await withPlatform(async (trx) => {
    const [user] = await trx.select({ status: users.status }).from(users).where(eq(users.id, id)).for('update');
    if (!user) throw notFound('User');
    if (user.status === status) throw conflict('USER_STATUS_UNCHANGED', `The user is already ${status}`);
    const [row] = await trx.update(users).set({ status }).where(eq(users.id, id)).returning({ id: users.id, status: users.status });
    return row;
  });
  if (status === 'blocked') {
    await revokeAllSessions(id);
    await dropTelegramLink(id);
  }
  return updated;
}

/** A new one-time password, shown once. Every device has to sign in again with it. */
export async function resetUserPassword(id: string, adminId: string | undefined) {
  if (id === adminId) throw forbidden('Change your own password from your profile', 'CANNOT_RESET_SELF');
  const oneTimePassword = randomToken(9);
  const passwordHash = await bcrypt.hash(oneTimePassword, config.BCRYPT_ROUNDS);
  await withPlatform(async (trx) => {
    const [row] = await trx.update(users).set({ passwordHash }).where(eq(users.id, id)).returning({ id: users.id });
    if (!row) throw notFound('User');
  });
  await revokeAllSessions(id);
  await notifyAccount(id, PASSWORD_NOTICE);
  return { oneTimePassword };
}
