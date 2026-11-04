import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config';
import { unauthorized } from './errors';

const key = new TextEncoder().encode(config.JWT_SECRET);

async function sign(claims: Record<string, unknown>, subject: string, expires: string, purpose: string) {
  return new SignJWT({ ...claims, use: purpose })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(key);
}

async function verify(token: string, purpose: string) {
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
    if (payload.use !== purpose) throw new Error('wrong token purpose');
    return payload;
  } catch {
    throw unauthorized('INVALID_TOKEN', 'Session expired, please sign in again');
  }
}

export interface AccessClaims {
  userId: string;
  /** Null for a platform admin with no farm membership. */
  membershipId: string | null;
  tenantId: string | null;
  farmId: string | null;
}

export function signAccessToken(c: AccessClaims): Promise<string> {
  return sign(
    { mid: c.membershipId, tid: c.tenantId, fid: c.farmId },
    c.userId,
    `${config.ACCESS_TOKEN_TTL_MIN}m`,
    'access',
  );
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const p = await verify(token, 'access');
  return {
    userId: p.sub!,
    membershipId: (p.mid as string | null) ?? null,
    tenantId: (p.tid as string | null) ?? null,
    farmId: (p.fid as string | null) ?? null,
  };
}

/** Short-lived proof that the password step passed, while the OTP step is pending. */
export const signChallengeToken = (userId: string) => sign({}, userId, '5m', '2fa');
export const verifyChallengeToken = async (token: string) => (await verify(token, '2fa')).sub!;

/** Signed link for <img> and downloads, which cannot send an Authorization header. */
export const signFileToken = (fileId: string, tenantId: string, farmId: string) =>
  sign({ tid: tenantId, fid: farmId }, fileId, '1h', 'file');

export async function verifyFileToken(token: string) {
  const p = await verify(token, 'file');
  return { fileId: p.sub!, tenantId: p.tid as string, farmId: p.fid as string };
}
