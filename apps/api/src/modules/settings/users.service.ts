import { randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ACTIONS, FINANCE_SUMMARY_VIEW, MODULES, PII_VIEW } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, hasPermission, tx, withPlatform } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { hidePii } from '../../core/privacy';
import { listQuery, paged, searchAny, sortBy, type ListQuery } from '../../core/query';
import { clearTwoFactor, issuedPassword, normalizePhone, revokeAllSessions, revokeFarmSessions } from '../auth/auth.service';
import { unlockPhone } from '../auth/lockout.service';
import { linkEmployeeByPhone } from '../hr/login-link.service';
import { inviteNotice, notifyAccount, PASSWORD_NOTICE, TWO_FACTOR_NOTICE } from '../notifications/notifications.service';
import { notifyUser } from '../notifications/notify.service';

const { invitations, memberships, roles, tenants, users } = schema;

const INVITATION_DAYS = 14;

export const ALL_PERMISSIONS: string[] = [
  ...MODULES.flatMap((m) => ACTIONS.map((a) => `${m}.${a}`)),
  PII_VIEW,
  FINANCE_SUMMARY_VIEW,
];

export const permissionList = z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).max(ALL_PERMISSIONS.length);

export const memberListQuery = listQuery.extend({
  roleId: z.uuid().optional(),
  status: z.enum(['active', 'blocked']).optional(),
});

export const memberInput = z.object({
  phone: z.string().trim().min(9).max(20),
  fullName: z.string().trim().min(2).max(120),
  email: z.email().nullish(),
  roleId: z.uuid(),
  locale: z.enum(['uz', 'uz-Cyrl', 'ru', 'en']).default('uz'),
});

export const roleInput = z.object({
  name: z.string().trim().min(2).max(80),
  permissions: permissionList,
});

const memberColumns = {
  id: memberships.id,
  userId: memberships.userId,
  status: memberships.status,
  createdAt: memberships.createdAt,
  fullName: users.fullName,
  phone: users.phone,
  email: users.email,
  lastLoginAt: users.lastLoginAt,
  totpEnabled: users.totpEnabled,
  roleId: roles.id,
  roleKey: roles.key,
  roleName: roles.name,
};

function membersQuery() {
  return tx()
    .select(memberColumns)
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(roles, eq(roles.id, memberships.roleId));
}

/** Filters on `users` go through a subquery, so the count in paged() can stay on memberships. */
function usersMatching(search: string) {
  return inArray(
    memberships.userId,
    tx().select({ id: users.id }).from(users).where(searchAny(search, [users.fullName, users.phone, users.email])),
  );
}

export async function listMembers(q: z.infer<typeof memberListQuery>) {
  const where = and(
    eq(memberships.farmId, ctx().farmId),
    q.roleId ? eq(memberships.roleId, q.roleId) : undefined,
    q.status ? eq(memberships.status, q.status) : undefined,
    q.search ? usersMatching(q.search) : undefined,
  );
  const page = await paged(q, memberships, where, (limit, offset) =>
    membersQuery()
      .where(where)
      .orderBy(...sortBy(q.sort, { fullName: users.fullName, createdAt: memberships.createdAt, status: memberships.status }, asc(users.fullName), memberships.id))
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: hidePii(page.data, ['phone', 'email']) };
}

/** Names for assignee dropdowns (docs/contracts.md). */
export async function lookupMembers(search: string | undefined) {
  // Read-only outsiders such as investors hold neither permission and must not get staff names.
  if (!hasPermission(PII_VIEW) && !hasPermission('tasks.view')) return [];
  const rows = await membersQuery()
    .where(
      and(
        eq(memberships.farmId, ctx().farmId),
        eq(memberships.status, 'active'),
        search ? usersMatching(search) : undefined,
      ),
    )
    .orderBy(asc(users.fullName))
    .limit(50);
  return rows.map((m) => ({ id: m.userId, name: m.fullName, fullName: m.fullName, roleKey: m.roleKey }));
}

async function getMember(id: string) {
  const [member] = await membersQuery().where(and(eq(memberships.id, id), eq(memberships.farmId, ctx().farmId)));
  if (!member) throw notFound('Member');
  return member;
}

async function getRole(id: string) {
  const [role] = await tx()
    .select()
    .from(roles)
    .where(and(eq(roles.id, id), eq(roles.tenantId, ctx().tenantId)));
  if (!role) throw notFound('Role');
  return role;
}

/** Whoever sees the books sees the summary of them, without holding it as a separate right. */
function holds(permission: string): boolean {
  const held = ctx().permissions;
  return held.has(permission) || (permission === FINANCE_SUMMARY_VIEW && held.has('finance.view'));
}

/** Nobody gives out rights they do not hold themselves. This also closes self-escalation. */
function assertCanGrant(permissions: string[]): void {
  const missing = permissions.filter((p) => !holds(p));
  if (missing.length > 0) {
    throw forbidden('You cannot grant a permission you do not have', 'CANNOT_GRANT_PERMISSION', { missing });
  }
}

/** Nobody manages a colleague who can do more than they can. */
function assertCanManage(targetPermissions: string[]): void {
  const missing = targetPermissions.filter((p) => !holds(p));
  if (missing.length > 0) {
    throw forbidden('This person has more rights than you do', 'CANNOT_MANAGE_HIGHER_ROLE', { missing });
  }
}

/** Refuse to take the workspace's last active owner out of service. Locks the rows it counts. */
async function assertNotLastOwner(member: { userId: string; roleKey: string; status: string }): Promise<void> {
  if (member.roleKey !== 'owner' || member.status !== 'active') return;
  const owners = await tx()
    .select({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(memberships.tenantId, ctx().tenantId), eq(roles.key, 'owner'), eq(memberships.status, 'active')))
    .for('update', { of: memberships });
  if (!owners.some((o) => o.userId !== member.userId)) {
    throw conflict('LAST_OWNER', 'The workspace must keep at least one active owner');
  }
}

/**
 * A login is global, so its password and two-factor reach every farm the person works on. A
 * workspace may touch them only when the whole account is its own: not someone who also works
 * elsewhere, not a platform admin who joined, and not someone who outranks the caller on another
 * of its farms. An invitation waiting from elsewhere counts too: whoever holds the password can
 * accept it. Everything else stops at this workspace's door.
 */
async function assertOwnsAccount(member: { id: string; userId: string; phone: string }): Promise<void> {
  const c = ctx();
  if (member.userId === c.userId) throw forbidden('Use your own profile for your own account', 'CANNOT_RESET_SELF');

  const held = await tx()
    .select({ permissions: roles.permissions })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(eq(memberships.userId, member.userId));
  assertCanManage(held.flatMap((role) => role.permissions));

  const [account] = await tx().select({ admin: users.isPlatformAdmin }).from(users).where(eq(users.id, member.userId));
  const elsewhere = await withPlatform(async (trx) => {
    const [joined] = await trx
      .select({ n: count() })
      .from(memberships)
      .where(and(eq(memberships.userId, member.userId), ne(memberships.tenantId, c.tenantId)));
    const [invited] = await trx
      .select({ n: count() })
      .from(invitations)
      .where(
        and(
          eq(invitations.phone, member.phone),
          ne(invitations.tenantId, c.tenantId),
          eq(invitations.status, 'pending'),
          gt(invitations.expiresAt, new Date()),
        ),
      );
    return joined.n + invited.n;
  });
  if (account.admin || elsewhere > 0) {
    throw conflict('USER_HAS_OTHER_WORKSPACES', 'This account also reaches beyond this workspace, so only the person or the platform administrator can do this');
  }
}

const invitationColumns = {
  id: invitations.id,
  phone: invitations.phone,
  fullName: invitations.fullName,
  roleId: invitations.roleId,
  roleKey: roles.key,
  roleName: roles.name,
  expiresAt: invitations.expiresAt,
  createdAt: invitations.createdAt,
};

async function getInvitation(id: string) {
  const [row] = await tx()
    .select(invitationColumns)
    .from(invitations)
    .innerJoin(roles, eq(roles.id, invitations.roleId))
    .where(and(eq(invitations.id, id), eq(invitations.farmId, ctx().farmId)));
  if (!row) throw notFound('Invitation');
  return row;
}

/** Holds only what the inviter typed, so nothing here describes the account behind the phone. */
async function invite(input: { phone: string; fullName: string; roleId: string; userId: string }) {
  const c = ctx();
  const expiresAt = new Date(Date.now() + INVITATION_DAYS * 86_400_000);
  const details = { fullName: input.fullName, roleId: input.roleId, expiresAt, createdBy: c.userId };
  const [open] = await tx()
    .select({ id: invitations.id, expiresAt: invitations.expiresAt })
    .from(invitations)
    .where(and(eq(invitations.farmId, c.farmId), eq(invitations.phone, input.phone), eq(invitations.status, 'pending')));
  if (open && open.expiresAt > new Date()) throw conflict('ALREADY_INVITED', 'This person has already been invited');

  const [row] = open
    ? await tx().update(invitations).set(details).where(eq(invitations.id, open.id)).returning({ id: invitations.id })
    : await tx()
        .insert(invitations)
        .values({ ...details, tenantId: c.tenantId, farmId: c.farmId, phone: input.phone })
        .returning({ id: invitations.id });

  await recordEvent({ type: 'user.invited', entityType: 'invitation', entityId: row.id, data: { roleId: input.roleId } });
  const [tenant] = await tx().select({ name: tenants.name }).from(tenants).where(eq(tenants.id, c.tenantId));
  // Through the person's own workspace: a row in this one would give this workspace their user id.
  await notifyAccount(input.userId, inviteNotice(tenant.name));
  return getInvitation(row.id);
}

/**
 * A new phone gets an account here. Someone with an account is only invited, and this workspace
 * learns nothing about them unless they accept. Someone it already holds, on another of its farms,
 * joins this one directly.
 */
export async function addMember(input: z.infer<typeof memberInput>) {
  const c = ctx();
  const phone = normalizePhone(input.phone);
  if (!/^\+\d{9,15}$/.test(phone)) throw badRequest('INVALID_PHONE', 'This phone number is not valid');

  const role = await getRole(input.roleId);
  assertCanGrant(role.permissions);

  const [existing] = await tx().select({ id: users.id }).from(users).where(eq(users.phone, phone));
  if (existing) {
    const held = await tx().select({ farmId: memberships.farmId }).from(memberships).where(eq(memberships.userId, existing.id));
    if (held.some((m) => m.farmId === c.farmId)) throw conflict('ALREADY_MEMBER', 'This person already works on this farm');
    if (held.length === 0) {
      return {
        member: null,
        invitation: await invite({ phone, fullName: input.fullName, roleId: role.id, userId: existing.id }),
        oneTimePassword: null,
      };
    }
  }

  let oneTimePassword: string | null = null;
  let userId = existing?.id;
  if (!existing) {
    const issued = await issuedPassword();
    oneTimePassword = issued.oneTimePassword;
    const [created] = await tx()
      .insert(users)
      .values({ phone, fullName: input.fullName, email: input.email, locale: input.locale, ...issued.stored })
      .returning({ id: users.id });
    userId = created.id;
  }

  const [membership] = await tx()
    .insert(memberships)
    .values({ tenantId: c.tenantId, farmId: c.farmId, userId: userId!, roleId: role.id })
    .returning({ id: memberships.id });
  await linkEmployeeByPhone(userId!, phone);

  await recordEvent({
    type: 'user.added',
    entityType: 'membership',
    entityId: membership.id,
    data: { role: role.key, existingUser: !!existing },
  });
  return { member: await getMember(membership.id), invitation: null, oneTimePassword };
}

/** Those still waiting for an answer. */
export async function listInvitations() {
  const rows = await tx()
    .select(invitationColumns)
    .from(invitations)
    .innerJoin(roles, eq(roles.id, invitations.roleId))
    .where(and(eq(invitations.farmId, ctx().farmId), eq(invitations.status, 'pending'), gt(invitations.expiresAt, new Date())))
    .orderBy(desc(invitations.createdAt));
  return hidePii(rows, ['phone']);
}

export async function cancelInvitation(id: string) {
  await getInvitation(id);
  const [row] = await tx()
    .update(invitations)
    .set({ status: 'cancelled' })
    .where(and(eq(invitations.id, id), eq(invitations.status, 'pending')))
    .returning({ id: invitations.id });
  if (!row) throw conflict('INVITATION_CLOSED', 'This invitation has already been answered');
  await recordEvent({ type: 'user.invitation_cancelled', entityType: 'invitation', entityId: id });
  return { id };
}

export async function changeRole(membershipId: string, roleId: string) {
  const c = ctx();
  const member = await getMember(membershipId);
  if (member.userId === c.userId) throw forbidden('You cannot change your own role', 'CANNOT_CHANGE_OWN_ROLE');

  const [currentRole, nextRole] = [await getRole(member.roleId), await getRole(roleId)];
  assertCanManage(currentRole.permissions);
  assertCanGrant(nextRole.permissions);
  if (nextRole.key !== 'owner') await assertNotLastOwner(member);

  await tx().update(memberships).set({ roleId }).where(eq(memberships.id, membershipId));
  await recordEvent({
    type: 'user.role_changed',
    severity: 'attention',
    entityType: 'membership',
    entityId: membershipId,
    data: { from: currentRole.key, to: nextRole.key },
  });
  return getMember(membershipId);
}

/**
 * Block a member (spec 5.1: the account stops, the records they entered stay). The guard reads
 * the status on every request, so an access token already in hand stops working at once.
 */
export async function blockMember(membershipId: string) {
  const c = ctx();
  const member = await getMember(membershipId);
  if (member.userId === c.userId) throw forbidden('You cannot block yourself', 'CANNOT_BLOCK_SELF');
  assertCanManage((await getRole(member.roleId)).permissions);
  await assertNotLastOwner(member);

  await tx().update(memberships).set({ status: 'blocked' }).where(eq(memberships.id, membershipId));
  await recordEvent({ type: 'user.blocked', severity: 'attention', entityType: 'membership', entityId: membershipId });
  await revokeFarmSessions(member.userId, membershipId);
  return getMember(membershipId);
}

export async function unblockMember(membershipId: string) {
  const member = await getMember(membershipId);
  assertCanManage((await getRole(member.roleId)).permissions);
  await tx().update(memberships).set({ status: 'active' }).where(eq(memberships.id, membershipId));
  await recordEvent({ type: 'user.unblocked', entityType: 'membership', entityId: membershipId });
  return getMember(membershipId);
}

/** Issue a one-time password, which the person must replace at their first sign-in. */
export async function resetPassword(membershipId: string) {
  const member = await getMember(membershipId);
  await assertOwnsAccount(member);

  const { oneTimePassword, stored } = await issuedPassword();
  await tx().update(users).set(stored).where(eq(users.id, member.userId));
  await recordEvent({ type: 'user.password_reset', severity: 'attention', entityType: 'membership', entityId: membershipId });
  await revokeAllSessions(member.userId);
  if (member.phone) await unlockPhone(member.phone);
  await notifyUser(member.userId, PASSWORD_NOTICE);
  return { oneTimePassword };
}

/** For a staff member who lost their authenticator and their recovery codes. They enrol again at sign-in. */
export async function resetTwoFactor(membershipId: string) {
  const member = await getMember(membershipId);
  await assertOwnsAccount(member);

  await clearTwoFactor(member.userId);
  await recordEvent({ type: 'user.two_factor_reset', severity: 'attention', entityType: 'membership', entityId: membershipId });
  await revokeAllSessions(member.userId);
  await notifyUser(member.userId, TWO_FACTOR_NOTICE);
  return { id: membershipId };
}

// ─── Roles ──────────────────────────────────────────────────────────────────

export async function listRoles(q?: Pick<ListQuery, 'search'>) {
  const members = tx()
    .select({ roleId: memberships.roleId, memberCount: count().as('member_count') })
    .from(memberships)
    .where(eq(memberships.farmId, ctx().farmId))
    .groupBy(memberships.roleId)
    .as('members');
  const rows = await tx()
    .select({
      id: roles.id,
      key: roles.key,
      name: roles.name,
      permissions: roles.permissions,
      isSystem: roles.isSystem,
      memberCount: sql<number>`coalesce(${members.memberCount}, 0)`.mapWith(Number),
    })
    .from(roles)
    .leftJoin(members, eq(members.roleId, roles.id))
    .where(and(eq(roles.tenantId, ctx().tenantId), searchAny(q?.search, [roles.name])))
    .orderBy(desc(roles.isSystem), asc(roles.createdAt));
  return rows;
}

export async function createRole(input: z.infer<typeof roleInput>) {
  const c = ctx();
  assertCanGrant(input.permissions);
  const [role] = await tx()
    .insert(roles)
    .values({
      tenantId: c.tenantId,
      key: `custom_${randomBytes(4).toString('hex')}`,
      name: input.name,
      permissions: input.permissions,
    })
    .returning();
  await recordEvent({ type: 'role.created', entityType: 'role', entityId: role.id, data: { name: role.name } });
  return role;
}

export async function updateRole(id: string, input: Partial<z.infer<typeof roleInput>>) {
  const role = await getRole(id);
  // Editing the owner role could lock everyone out of user management, so it is fixed.
  if (role.key === 'owner') throw conflict('OWNER_ROLE_LOCKED', 'The owner role cannot be changed');
  if (role.isSystem && input.name !== undefined && input.name !== role.name) {
    throw conflict('SYSTEM_ROLE', 'A system role keeps its name');
  }

  if (input.name === undefined && input.permissions === undefined) return role;
  if (input.permissions) {
    const held = new Set(role.permissions);
    assertCanGrant(input.permissions.filter((p) => !held.has(p)));
  }
  const [updated] = await tx()
    .update(roles)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.permissions ? { permissions: input.permissions } : {}),
    })
    .where(eq(roles.id, id))
    .returning();
  await recordEvent({
    type: 'role.updated',
    severity: 'attention',
    entityType: 'role',
    entityId: id,
    data: { key: role.key, permissions: input.permissions },
  });
  return updated;
}

export async function deleteRole(id: string) {
  const role = await getRole(id);
  if (role.isSystem) throw conflict('SYSTEM_ROLE', 'A system role cannot be deleted');
  const [{ n }] = await tx().select({ n: count() }).from(memberships).where(eq(memberships.roleId, id));
  if (n > 0) throw conflict('ROLE_IN_USE', 'This role is assigned to people', { members: n });
  await tx().delete(roles).where(eq(roles.id, id));
  await recordEvent({ type: 'role.deleted', entityType: 'role', entityId: id, data: { key: role.key } });
  return { id };
}
