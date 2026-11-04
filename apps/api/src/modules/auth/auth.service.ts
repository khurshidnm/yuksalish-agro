import { and, asc, eq, isNull } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { generateSecret, generateURI, verify as verifyOtp } from 'otplib';
import { v7 as uuidv7 } from 'uuid';
import { ROLES_REQUIRING_2FA, type RoleKey } from '@yap/shared';
import { config } from '../../config';
import { db, schema } from '../../db/client';
import { withPlatform } from '../../core/context';
import { randomToken, seal, sha256, unseal } from '../../core/crypto';
import { badRequest, conflict, forbidden, unauthorized } from '../../core/errors';
import { mergeSettings } from '../../core/settings';
import { signAccessToken, signChallengeToken, verifyChallengeToken } from '../../core/tokens';

const { farms, memberships, refreshTokens, roles, tenants, users } = schema;

type User = typeof users.$inferSelect;
export interface ClientMeta {
  ip: string;
  device: string;
}

/**
 * A rotated token still works this long. Two tabs can refresh together, and on the farm's weak
 * connection a refresh response can be lost after the server has already rotated the token.
 */
const REFRESH_REUSE_GRACE_MS = 120_000;

/** Accepts 901234567, 998901234567, +998 90 123-45-67. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 9 ? `+998${digits}` : `+${digits}`;
}

// Compared when the phone is unknown, so response time does not reveal which phones exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 4);

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
    mustEnroll2fa:
      !!active &&
      settings.security.enforce2fa &&
      !user.totpEnabled &&
      ROLES_REQUIRING_2FA.includes(active.roleKey as RoleKey),
    settings,
  };
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

export async function login(phone: string, password: string, meta: ClientMeta) {
  const [user] = await db.select().from(users).where(eq(users.phone, normalizePhone(phone)));
  const passwordOk = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !passwordOk) throw unauthorized('INVALID_CREDENTIALS', 'Wrong phone number or password');
  if (user.status !== 'active') throw unauthorized('ACCOUNT_BLOCKED', 'This account is blocked');

  if (user.totpEnabled) return { twoFactorRequired: true as const, challengeToken: await signChallengeToken(user.id) };

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  return issueTokens(user, null, meta);
}

async function checkOtp(user: User, code: string): Promise<void> {
  if (!user.totpSecret) throw badRequest('TWO_FACTOR_NOT_SET', 'Two-factor authentication is not set up');
  const result = await verifyOtp({ secret: unseal(user.totpSecret), token: code, epochTolerance: 30 });
  if (!result.valid) throw unauthorized('INVALID_CODE', 'Wrong code');
}

export async function verifyTwoFactor(challengeToken: string, code: string, meta: ClientMeta) {
  const user = await getUser(await verifyChallengeToken(challengeToken));
  await checkOtp(user, code);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  return issueTokens(user, null, meta);
}

/** Rotate the refresh token. Reusing a rotated token revokes its whole family (theft signal). */
export async function refresh(refreshToken: string | undefined, meta: ClientMeta) {
  if (!refreshToken) throw unauthorized('NO_SESSION', 'Please sign in');
  const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(refreshToken)));
  if (!row) throw unauthorized('NO_SESSION', 'Please sign in');

  if (row.revokedAt) throw unauthorized('SESSION_REVOKED', 'Please sign in again');

  if (row.rotatedAt && Date.now() - row.rotatedAt.getTime() > REFRESH_REUSE_GRACE_MS) {
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
    throw unauthorized('SESSION_REVOKED', 'Please sign in again');
  }
  if (row.expiresAt < new Date()) throw unauthorized('SESSION_EXPIRED', 'Please sign in again');

  const user = await getUser(row.userId);
  await db.update(refreshTokens).set({ rotatedAt: row.rotatedAt ?? new Date() }).where(eq(refreshTokens.id, row.id));
  return issueTokens(user, row.membershipId, meta, row.familyId);
}

export async function logout(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokens.tokenHash, sha256(refreshToken)));
}

export async function me(userId: string, membershipId: string | null) {
  return buildSession(await getUser(userId), membershipId);
}

export async function switchFarm(userId: string, membershipId: string, meta: ClientMeta) {
  const user = await getUser(userId);
  const rows = await loadMemberships(userId);
  if (!rows.some((m) => m.id === membershipId)) throw forbidden('You do not belong to this farm', 'NOT_A_MEMBER');
  return issueTokens(user, membershipId, meta);
}

export async function changePassword(userId: string, current: string, next: string): Promise<void> {
  const user = await getUser(userId);
  if (!(await bcrypt.compare(current, user.passwordHash))) {
    throw badRequest('WRONG_PASSWORD', 'Current password is wrong');
  }
  const passwordHash = await bcrypt.hash(next, config.BCRYPT_ROUNDS);
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  // Other devices must sign in again.
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

export async function setupTwoFactor(userId: string) {
  const user = await getUser(userId);
  if (user.totpEnabled) throw conflict('TWO_FACTOR_ALREADY_ENABLED', 'Two-factor authentication is already on');
  const secret = generateSecret();
  await db.update(users).set({ totpSecret: seal(secret) }).where(eq(users.id, userId));
  return { secret, otpauthUrl: generateURI({ issuer: 'Yuksalish Agro', label: user.phone, secret }) };
}

export async function enableTwoFactor(userId: string, code: string): Promise<void> {
  await checkOtp(await getUser(userId), code);
  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, userId));
}

export async function disableTwoFactor(userId: string, membershipId: string | null, code: string): Promise<void> {
  const user = await getUser(userId);
  const session = await buildSession(user, membershipId);
  if (
    session.settings.security.enforce2fa &&
    session.role &&
    ROLES_REQUIRING_2FA.includes(session.role.key as RoleKey)
  ) {
    throw forbidden('Your role requires two-factor authentication', 'TWO_FACTOR_REQUIRED_BY_POLICY');
  }
  await checkOtp(user, code);
  await db.update(users).set({ totpEnabled: false, totpSecret: null }).where(eq(users.id, userId));
}

/** Sign out every device, e.g. when an employee leaves (spec 5.1). */
export async function revokeAllSessions(userId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}
