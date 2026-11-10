import { randomBytes } from 'node:crypto';
import { and, asc, count, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { generateSecret, generateURI, verify as verifyOtp } from 'otplib';
import { v7 as uuidv7 } from 'uuid';
import { PRODUCT_NAME, ROLES_REQUIRING_2FA, type RoleKey } from '@yap/shared';
import { config } from '../../config';
import { db, schema, type Tx } from '../../db/client';
import { tx, withPlatform, withTenant } from '../../core/context';
import { randomToken, seal, sha256, unseal } from '../../core/crypto';
import { AppError, badRequest, conflict, forbidden, unauthorized } from '../../core/errors';
import { recordEvent, type EventInput } from '../../core/journal';
import { passwordProblem } from '../../core/passwords';
import { normalizePhone } from '../../core/phone';
import { mergeSettings } from '../../core/settings';
import { signAccessToken, signChallengeToken, verifyChallengeToken } from '../../core/tokens';
import { notifyAccount, PASSWORD_NOTICE, TWO_FACTOR_NOTICE } from '../notifications/notifications.service';
import { acceptInvitation as joinFarm, declineInvitation as refuseFarm, pendingInvitations } from './invitations.service';
import { assertNotLocked, clearFailures, CODE_STEP, recordFailure, unlockPhone } from './lockout.service';

export { normalizePhone };

const { farms, memberships, platformAudit, recoveryCodes, refreshTokens, roles, telegramLinkCodes, tenants, users } = schema;

type User = typeof users.$inferSelect;
export interface ClientMeta {
  ip: string;
  device: string;
}

/** A rotated token still works this long, without a second look: two tabs can refresh together. */
const REFRESH_REUSE_GRACE_MS = 120_000;

// Compared when the phone is unknown, at the cost of a real hash, so response time reveals nothing.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.BCRYPT_ROUNDS);

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 16;
/** 32 letters and digits, without 0, O, 1 and I: these get read off paper. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function loadMemberships(userId: string) {
  return withPlatform((trx) =>
    trx
      .select({
        id: memberships.id,
        tenantId: memberships.tenantId,
        tenantName: tenants.name,
        tenantCurrency: tenants.currency,
        tenantModules: tenants.modules,
        tenantSettings: tenants.settings,
        farmId: memberships.farmId,
        farmName: farms.name,
        roleId: roles.id,
        roleKey: roles.key,
        roleName: roles.name,
        permissions: roles.permissions,
      })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .innerJoin(farms, eq(farms.id, memberships.farmId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active'), eq(tenants.status, 'active')))
      .orderBy(asc(memberships.createdAt)),
  );
}

function pickMembership<T extends { id: string }>(rows: T[], preferred: string | null | undefined): T | null {
  return rows.find((m) => m.id === preferred) ?? rows[0] ?? null;
}

export async function buildSession(user: User, membershipId: string | null | undefined) {
  const rows = await loadMemberships(user.id);
  const active = pickMembership(rows, membershipId);
  const settings = mergeSettings(active?.tenantSettings);
  return {
    user: {
      id: user.id,
      fullName: user.fullName,
      phone: user.phone,
      email: user.email,
      locale: user.locale,
      totpEnabled: user.totpEnabled,
      recoveryCodesLeft: user.totpEnabled ? await unusedRecoveryCodes(user.id) : null,
      isPlatformAdmin: user.isPlatformAdmin,
    },
    tenant: active
      ? { id: active.tenantId, name: active.tenantName, currency: active.tenantCurrency, modules: active.tenantModules }
      : null,
    farm: active ? { id: active.farmId, name: active.farmName } : null,
    role: active ? { id: active.roleId, key: active.roleKey, name: active.roleName } : null,
    permissions: active?.permissions ?? [],
    memberships: rows.map((m) => ({
      id: m.id,
      tenantId: m.tenantId,
      tenantName: m.tenantName,
      farmId: m.farmId,
      farmName: m.farmName,
      roleKey: m.roleKey,
      roleName: m.roleName,
    })),
    invitations: await pendingInvitations(user.phone),
    mustChangePassword: user.mustChangePassword,
    mustEnroll2fa: !user.totpEnabled && needsTwoFactor(user, active?.roleKey, settings.security.enforce2fa),
    settings,
  };
}

/** The platform admin outranks every role that must use it, so no tenant setting can excuse them. */
function needsTwoFactor(user: User, roleKey: string | undefined, enforced: boolean): boolean {
  return user.isPlatformAdmin || (enforced && ROLES_REQUIRING_2FA.includes(roleKey as RoleKey));
}

export type Session = Awaited<ReturnType<typeof buildSession>>;

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  session: Session;
}

async function issueTokens(
  user: User,
  membershipId: string | null | undefined,
  meta: ClientMeta,
  familyId: string = uuidv7(),
): Promise<IssuedTokens> {
  const session = await buildSession(user, membershipId);
  const active = session.memberships.find((m) => m.id === membershipId) ?? session.memberships[0] ?? null;
  const refreshToken = randomToken();
  await db.insert(refreshTokens).values({
    userId: user.id,
    membershipId: active?.id,
    tokenHash: sha256(refreshToken),
    familyId,
    expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    userAgent: meta.device,
    ip: meta.ip,
  });
  const accessToken = await signAccessToken({
    userId: user.id,
    membershipId: active?.id ?? null,
    tenantId: active?.tenantId ?? null,
    farmId: active?.farmId ?? null,
  });
  return { accessToken, refreshToken, session };
}

async function getUser(userId: string): Promise<User> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw unauthorized();
  if (user.status !== 'active') throw unauthorized('ACCOUNT_BLOCKED', 'This account is blocked');
  return user;
}

/** Account news goes to the journal of every farm the person works on, or the platform's if there is none. */
export async function recordAccountEvent(userId: string, event: EventInput): Promise<void> {
  const homes = await withPlatform((trx) =>
    trx
      .select({ tenantId: memberships.tenantId, farmId: memberships.farmId })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active'))),
  );
  for (const home of homes) await withTenant({ userId: null, ...home, source: 'system' }, () => recordEvent(event));
  if (homes.length === 0) await db.insert(platformAudit).values({ action: event.type, targetId: userId });
}

/** The failure that starts a lock is refused as locked, and the person's farms get to see it. */
async function countFailure(phone: string, address: string, user: User | undefined): Promise<void> {
  const locked = await recordFailure(phone, address);
  if (!locked) return;
  if (user) {
    await recordAccountEvent(user.id, {
      type: 'auth.locked',
      severity: 'attention',
      entityType: 'user',
      entityId: user.id,
      data: { step: address === CODE_STEP ? 'code' : 'password' },
    });
  }
  throw locked;
}

export async function login(phone: string, password: string, meta: ClientMeta) {
  const number = normalizePhone(phone);
  await assertNotLocked(number, meta.ip);
  const [user] = await db.select().from(users).where(eq(users.phone, number));
  const passwordOk = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !passwordOk) {
    await countFailure(number, meta.ip, user);
    throw unauthorized('INVALID_CREDENTIALS', 'Wrong phone number or password');
  }
  await clearFailures(number, meta.ip);
  if (user.status !== 'active') throw unauthorized('ACCOUNT_BLOCKED', 'This account is blocked');

  if (user.totpEnabled) return { twoFactorRequired: true as const, challengeToken: await signChallengeToken(user.id) };

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  return issueTokens(user, null, meta);
}

/** True once per code: the step it belongs to is claimed atomically, so a replay finds it taken. */
async function acceptTotp(user: User, code: string): Promise<boolean> {
  if (!user.totpSecret) throw badRequest('TWO_FACTOR_NOT_SET', 'Two-factor authentication is not set up');
  if (!/^\d{6}$/.test(code)) return false;
  const result = await verifyOtp({ secret: unseal(user.totpSecret), token: code, epochTolerance: 30 });
  if (!result.valid) return false;
  const { timeStep } = result as { timeStep: number };
  const claimed = await db
    .update(users)
    .set({ totpLastStep: timeStep })
    .where(and(eq(users.id, user.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, timeStep))))
    .returning({ id: users.id });
  return claimed.length > 0;
}

/** Not a 401, which the client reads as an expired session and retries: the retry would count as a second guess. */
const wrongCode = () => badRequest('INVALID_CODE', 'Wrong code');

const recoveryHash = (userId: string, code: string) => sha256(`${userId}:${code}`);

function newRecoveryCode(): string {
  return [...randomBytes(RECOVERY_CODE_LENGTH)].map((byte) => RECOVERY_ALPHABET[byte % 32]).join('');
}

async function unusedRecoveryCodes(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  return row.n;
}

/** Replaces any earlier set. The only moment these codes exist in readable form. */
async function issueRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await db.transaction(async (trx) => {
    await trx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    await trx.insert(recoveryCodes).values(codes.map((code) => ({ userId, codeHash: recoveryHash(userId, code) })));
  });
  return codes.map((code) => code.match(/.{4}/g)!.join('-'));
}

async function acceptRecoveryCode(user: User, typed: string): Promise<boolean> {
  const code = typed.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== RECOVERY_CODE_LENGTH) return false;
  const used = await db
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(recoveryCodes.codeHash, recoveryHash(user.id, code)), isNull(recoveryCodes.usedAt)))
    .returning({ id: recoveryCodes.id });
  if (used.length === 0) return false;
  await recordAccountEvent(user.id, { type: 'auth.recovery_code_used', severity: 'attention', entityType: 'user', entityId: user.id });
  await notifyAccount(user.id, TWO_FACTOR_NOTICE);
  return true;
}

/** A code from the app or a recovery code. Wrong tries lock this step for the account, whatever the address. */
async function proveSecondFactor(user: User, code: string): Promise<'app' | 'recovery'> {
  await assertNotLocked(user.phone, CODE_STEP);
  const method = (await acceptTotp(user, code)) ? 'app' : (await acceptRecoveryCode(user, code)) ? 'recovery' : null;
  if (method) {
    await clearFailures(user.phone, CODE_STEP);
    return method;
  }
  await countFailure(user.phone, CODE_STEP, user);
  throw wrongCode();
}

export async function verifyTwoFactor(challengeToken: string, code: string, meta: ClientMeta) {
  const user = await getUser(await verifyChallengeToken(challengeToken));
  const method = await proveSecondFactor(user, code);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  return { ...(await issueTokens(user, null, meta)), recoveryCodeUsed: method === 'recovery' };
}

const revokeFamily = (writer: Tx | typeof db, familyId: string) =>
  writer
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));

/**
 * Whether this token may be exchanged, decided one at a time per family. A token replayed after its
 * grace is a lost reply or a theft, and what happened next tells which. While nothing newer has been
 * used, the phone never got its answer: the tokens it never saw die, and it gets a new one. Once
 * something newer has been used, two parties hold this session, and all of it ends.
 *
 * That leaves a thief who replays before the owner's next refresh looking like a lost reply. The owner
 * then arrives with a token this revoked, and a revoked token ends the family, the thief's part too.
 * So logout has to end the family as well: a rotated token left alive would bring the session back.
 *
 * Refusals are returned, not thrown, because a throw would roll back the revocation.
 */
async function claimRefresh(tokenHash: string) {
  return db.transaction(async (trx) => {
    await trx.execute(sql`select pg_advisory_xact_lock(hashtextextended('refresh:' || family_id, 0)) from refresh_tokens where token_hash = ${tokenHash}`);
    const [row] = await trx.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
    if (!row) return unauthorized('NO_SESSION', 'Please sign in');

    const now = new Date();
    const pastGrace = row.rotatedAt !== null && now.getTime() - row.rotatedAt.getTime() > REFRESH_REUSE_GRACE_MS;
    const [newerUsed] = pastGrace
      ? await trx
          .select({ id: refreshTokens.id })
          .from(refreshTokens)
          .where(and(eq(refreshTokens.familyId, row.familyId), gt(refreshTokens.rotatedAt, row.rotatedAt!)))
          .limit(1)
      : [];
    if (row.revokedAt || newerUsed) {
      await revokeFamily(trx, row.familyId);
      return unauthorized('SESSION_REVOKED', 'Please sign in again');
    }
    if (row.expiresAt < now) return unauthorized('SESSION_EXPIRED', 'Please sign in again');

    if (pastGrace) {
      await trx
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.rotatedAt), isNull(refreshTokens.revokedAt)));
    }
    // A replay restarts the grace, so a second tab replaying alongside it does not cancel the first.
    if (pastGrace || !row.rotatedAt) await trx.update(refreshTokens).set({ rotatedAt: now }).where(eq(refreshTokens.id, row.id));
    return row;
  });
}

export async function refresh(refreshToken: string | undefined, meta: ClientMeta) {
  if (!refreshToken) throw unauthorized('NO_SESSION', 'Please sign in');
  const claimed = await claimRefresh(sha256(refreshToken));
  if (claimed instanceof AppError) throw claimed;
  const issued = await issueTokens(await getUser(claimed.userId), claimed.membershipId, meta, claimed.familyId);

  // Another claim may have ended the family while this token was being made, and the end covers it too.
  // Looked at under the family's lock: a claim that is ending the family right now did not see the new
  // token, and has not committed yet, so without the wait this would read "still alive" and leave it live.
  const ended = await db.transaction(async (trx) => {
    await trx.execute(sql`select pg_advisory_xact_lock(hashtextextended('refresh:' || family_id, 0)) from refresh_tokens where id = ${claimed.id}`);
    const [source] = await trx.select({ revokedAt: refreshTokens.revokedAt }).from(refreshTokens).where(eq(refreshTokens.id, claimed.id));
    if (!source?.revokedAt) return false;
    await revokeFamily(trx, claimed.familyId);
    return true;
  });
  if (ended) throw unauthorized('SESSION_REVOKED', 'Please sign in again');
  return issued;
}

export async function logout(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  const [row] = await db.select({ familyId: refreshTokens.familyId }).from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(refreshToken)));
  if (row) await revokeFamily(db, row.familyId);
}

export async function me(userId: string, membershipId: string | null) {
  return buildSession(await getUser(userId), membershipId);
}

/** Lands the person on the new farm, which also gives someone with no farm yet a token that works. */
export async function acceptInvitation(userId: string, id: string, meta: ClientMeta) {
  const user = await getUser(userId);
  return issueTokens(user, await joinFarm(user, id), meta);
}

export async function declineInvitation(userId: string, membershipId: string | null, id: string) {
  const user = await getUser(userId);
  await refuseFarm(user, id);
  return buildSession(user, membershipId);
}

export async function switchFarm(userId: string, membershipId: string, meta: ClientMeta) {
  const user = await getUser(userId);
  const rows = await loadMemberships(userId);
  if (!rows.some((m) => m.id === membershipId)) throw forbidden('You do not belong to this farm', 'NOT_A_MEMBER');
  return issueTokens(user, membershipId, meta);
}

function assertUsablePassword(password: string, phone: string): void {
  const problem = passwordProblem(password, phone);
  if (problem) throw badRequest(problem, 'Choose a different password');
}

/** A hash and a flag to store for a password someone else will hand over: it must be replaced at first sign-in. */
export async function issuedPassword() {
  const oneTimePassword = randomToken(9);
  return { oneTimePassword, stored: { passwordHash: await bcrypt.hash(oneTimePassword, config.BCRYPT_ROUNDS), mustChangePassword: true } };
}

/** Every other device is signed out. This one gets a new session, so the person is not dropped later, in the field. */
export async function changePassword(
  userId: string,
  membershipId: string | null,
  current: string,
  next: string,
  meta: ClientMeta,
): Promise<IssuedTokens> {
  const user = await getUser(userId);
  await assertNotLocked(user.phone, meta.ip);
  if (!(await bcrypt.compare(current, user.passwordHash))) {
    await countFailure(user.phone, meta.ip, user);
    throw badRequest('WRONG_PASSWORD', 'Current password is wrong');
  }
  assertUsablePassword(next, user.phone);
  if (await bcrypt.compare(next, user.passwordHash)) throw badRequest('PASSWORD_UNCHANGED', 'Choose a different password');
  const passwordHash = await bcrypt.hash(next, config.BCRYPT_ROUNDS);
  const [updated] = await db.update(users).set({ passwordHash, mustChangePassword: false }).where(eq(users.id, userId)).returning();
  await revokeAllSessions(userId);
  await notifyAccount(userId, PASSWORD_NOTICE);
  return issueTokens(updated, membershipId, meta);
}

/** Null also when the key it was sealed with has changed: that person simply scans a new one. */
function readableSecret(sealed: string | null): string | null {
  if (!sealed) return null;
  try {
    return unseal(sealed);
  } catch {
    return null;
  }
}

/**
 * The same secret until 2FA is on, so a reload cannot break the entry already in the phone's app.
 * The row lock is for two tabs asking at once, which must not each show a different one.
 */
export async function setupTwoFactor(userId: string) {
  const user = await getUser(userId);
  const secret = await db.transaction(async (trx) => {
    const [row] = await trx.select({ on: users.totpEnabled, sealed: users.totpSecret }).from(users).where(eq(users.id, userId)).for('update');
    if (row.on) throw conflict('TWO_FACTOR_ALREADY_ENABLED', 'Two-factor authentication is already on');
    const unconfirmed = readableSecret(row.sealed);
    if (unconfirmed) return unconfirmed;
    const fresh = generateSecret();
    await trx.update(users).set({ totpSecret: seal(fresh), totpLastStep: null }).where(eq(users.id, userId));
    return fresh;
  });
  return { secret, otpauthUrl: generateURI({ issuer: PRODUCT_NAME, label: user.phone, secret }) };
}

/** Returns the recovery codes, which are never available again. */
export async function enableTwoFactor(userId: string, code: string): Promise<string[]> {
  const user = await getUser(userId);
  if (user.totpEnabled) throw conflict('TWO_FACTOR_ALREADY_ENABLED', 'Two-factor authentication is already on');
  if (!(await acceptTotp(user, code))) throw wrongCode();
  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, userId));
  return issueRecoveryCodes(userId);
}

export async function disableTwoFactor(userId: string, membershipId: string | null, code: string): Promise<void> {
  const user = await getUser(userId);
  const session = await buildSession(user, membershipId);
  if (needsTwoFactor(user, session.role?.key, session.settings.security.enforce2fa)) {
    throw forbidden('Your role requires two-factor authentication', 'TWO_FACTOR_REQUIRED_BY_POLICY');
  }
  await proveSecondFactor(user, code);
  await clearTwoFactor(userId);
}

/** A new set for someone who lost theirs or used them up. The old set stops working. */
export async function regenerateRecoveryCodes(userId: string, code: string): Promise<string[]> {
  await proveSecondFactor(await getUser(userId), code);
  return issueRecoveryCodes(userId);
}

/**
 * Moving to a new phone. Unlike turning it off, every role may do this, because whoever must have
 * two-factor is sent straight to enrol again. Other devices are signed out, in case the old phone was stolen.
 */
export async function replaceTwoFactor(userId: string, membershipId: string | null, code: string, meta: ClientMeta): Promise<IssuedTokens> {
  const user = await getUser(userId);
  if (!user.totpEnabled) throw badRequest('TWO_FACTOR_NOT_SET', 'Two-factor authentication is not set up');
  await proveSecondFactor(user, code);
  await clearTwoFactor(userId);
  await revokeAllSessions(userId);
  await recordAccountEvent(userId, { type: 'auth.two_factor_replaced', severity: 'attention', entityType: 'user', entityId: userId });
  await notifyAccount(userId, TWO_FACTOR_NOTICE);
  return issueTokens(await getUser(userId), membershipId, meta);
}

/** For whoever may reset someone else: the person enrols again at their next sign-in. */
export async function clearTwoFactor(userId: string): Promise<void> {
  const [user] = await requestTx()
    .update(users)
    .set({ totpEnabled: false, totpSecret: null, totpLastStep: null })
    .where(eq(users.id, userId))
    .returning({ phone: users.phone });
  await requestTx().delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  if (user) await unlockPhone(user.phone);
}

/** Inside a request the codes burn with it, and roll back with it. */
function requestTx() {
  try {
    return tx();
  } catch {
    return db;
  }
}

/**
 * Sign out every device, e.g. when an employee leaves (spec 5.1). A linked Telegram chat stays: each
 * update checks the memberships, and it may be how a fire on their other farm reaches them. Only
 * unlinking it themselves, or blocking the account, ends it (dropTelegramLink).
 */
export async function revokeAllSessions(userId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  await requestTx()
    .update(telegramLinkCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(telegramLinkCodes.userId, userId), isNull(telegramLinkCodes.usedAt)));
}

/**
 * Sign someone out of one farm. A farm's reach ends at its own door: blocking someone here must not
 * sign them out of their job elsewhere, and on someone with no other farm this ends everything anyway.
 * A platform admin's session is not the farm's to end. The guard already refuses them on this farm,
 * and their next refresh takes them off it.
 */
export async function revokeFarmSessions(userId: string, membershipId: string): Promise<void> {
  const [account] = await db.select({ admin: users.isPlatformAdmin }).from(users).where(eq(users.id, userId));
  if (account.admin) return;
  const active = await withPlatform((trx) =>
    trx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active'))),
  );
  if (active.every((m) => m.id === membershipId)) return revokeAllSessions(userId);
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.membershipId, membershipId), isNull(refreshTokens.revokedAt)));
}
