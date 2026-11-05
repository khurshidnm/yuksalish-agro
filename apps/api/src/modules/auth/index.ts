import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config, isProd, isTest } from '../../config';
import { unauthorized } from '../../core/errors';
import { routes } from '../../core/http';
import { MIN_PASSWORD_LENGTH } from '../../core/passwords';
import { idParam } from '../../core/query';
import { verifyAccessToken } from '../../core/tokens';
import * as auth from './auth.service';

const COOKIE = 'yap_rt';
const cookiePath = '/api/v1/auth';

const strictLimit = isTest ? {} : { rateLimit: { max: 10, timeWindow: '1 minute' } };
/** Each call costs a database lookup, so guessing has to cost something too. Tabs refresh every 15 minutes. */
const sessionLimit = isTest ? {} : { rateLimit: { max: 60, timeWindow: '1 minute' } };

function setRefreshCookie(reply: FastifyReply, token: string) {
  reply.setCookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    path: cookiePath,
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400,
  });
}

function meta(req: FastifyRequest): auth.ClientMeta {
  return { ip: req.ip, device: (req.headers['user-agent'] ?? '').slice(0, 200) };
}

async function claims(req: FastifyRequest) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  return verifyAccessToken(header.slice(7));
}

function respond(reply: FastifyReply, issued: auth.IssuedTokens) {
  setRefreshCookie(reply, issued.refreshToken);
  return { accessToken: issued.accessToken, session: issued.session };
}

const password = z.string().min(MIN_PASSWORD_LENGTH).max(128);

/** Six digits from the app, or a recovery code. */
const secondFactor = z.string().trim().min(6).max(32);

export default async function authModule(app: FastifyInstance) {
  // Auth routes are 'public' at the guard level: a platform admin has no tenant context, so
  // each route that needs a user verifies the token itself through claims().
  const r = routes(app, 'auth');

  r.post('/login', {
    access: 'public',
    summary: 'Sign in with phone and password',
    config: strictLimit,
    body: z.object({ phone: z.string().min(9).max(20), password: z.string().min(1).max(128) }),
    handler: async (req, reply) => {
      const result = await auth.login(req.body.phone, req.body.password, meta(req as unknown as FastifyRequest));
      return 'twoFactorRequired' in result ? result : respond(reply, result);
    },
  });

  r.post('/2fa/verify', {
    access: 'public',
    summary: 'Complete sign-in with a one-time code',
    config: strictLimit,
    body: z.object({ challengeToken: z.string(), code: secondFactor }),
    handler: async (req, reply) => {
      const issued = await auth.verifyTwoFactor(req.body.challengeToken, req.body.code, meta(req as unknown as FastifyRequest));
      return { ...respond(reply, issued), recoveryCodeUsed: issued.recoveryCodeUsed };
    },
  });

  r.post('/refresh', {
    access: 'public',
    summary: 'Rotate the refresh cookie and get a new access token',
    config: sessionLimit,
    handler: async (req, reply) =>
      respond(reply, await auth.refresh(req.cookies[COOKIE], meta(req as unknown as FastifyRequest))),
  });

  r.post('/logout', {
    access: 'public',
    config: sessionLimit,
    handler: async (req, reply) => {
      await auth.logout(req.cookies[COOKIE]);
      reply.clearCookie(COOKIE, { path: cookiePath });
      return { ok: true };
    },
  });

  r.get('/me', {
    access: 'public',
    summary: 'Current session',
    handler: async (req) => {
      const c = await claims(req as unknown as FastifyRequest);
      return auth.me(c.userId, c.membershipId);
    },
  });

  r.post('/switch-farm', {
    access: 'public',
    body: z.object({ membershipId: z.uuid() }),
    handler: async (req, reply) => {
      const c = await claims(req as unknown as FastifyRequest);
      return respond(reply, await auth.switchFarm(c.userId, req.body.membershipId, meta(req as unknown as FastifyRequest)));
    },
  });

  r.post('/invitations/:id/accept', {
    access: 'public',
    summary: 'Join the farm that invited this phone, and land on it',
    params: idParam,
    handler: async (req, reply) => {
      const c = await claims(req as unknown as FastifyRequest);
      return respond(reply, await auth.acceptInvitation(c.userId, req.params.id, meta(req as unknown as FastifyRequest)));
    },
  });

  r.post('/invitations/:id/decline', {
    access: 'public',
    params: idParam,
    handler: async (req) => {
      const c = await claims(req as unknown as FastifyRequest);
      return auth.declineInvitation(c.userId, c.membershipId, req.params.id);
    },
  });

  r.post('/change-password', {
    access: 'public',
    summary: 'Sets the new password. Other devices are signed out, and this one gets a new session.',
    config: strictLimit,
    body: z.object({ currentPassword: z.string().max(128), newPassword: password }),
    handler: async (req, reply) => {
      const c = await claims(req as unknown as FastifyRequest);
      return respond(
        reply,
        await auth.changePassword(c.userId, c.membershipId, req.body.currentPassword, req.body.newPassword, meta(req as unknown as FastifyRequest)),
      );
    },
  });

  r.post('/2fa/setup', {
    access: 'public',
    summary: 'Start enrolment: returns the secret and otpauth URL, the same ones until 2FA is on',
    handler: async (req) => auth.setupTwoFactor((await claims(req as unknown as FastifyRequest)).userId),
  });

  r.post('/2fa/enable', {
    access: 'public',
    summary: 'Finish enrolment. The ten recovery codes are in this response and never again.',
    config: strictLimit,
    body: z.object({ code: z.string().length(6) }),
    handler: async (req) => {
      const c = await claims(req as unknown as FastifyRequest);
      const recoveryCodes = await auth.enableTwoFactor(c.userId, req.body.code);
      return { session: await auth.me(c.userId, c.membershipId), recoveryCodes };
    },
  });

  r.post('/2fa/disable', {
    access: 'public',
    config: strictLimit,
    body: z.object({ code: secondFactor }),
    handler: async (req) => {
      const c = await claims(req as unknown as FastifyRequest);
      await auth.disableTwoFactor(c.userId, c.membershipId, req.body.code);
      return auth.me(c.userId, c.membershipId);
    },
  });

  r.post('/2fa/replace', {
    access: 'public',
    summary: 'Clear the authenticator to enrol a new phone. Other devices are signed out.',
    config: strictLimit,
    body: z.object({ code: secondFactor }),
    handler: async (req, reply) => {
      const c = await claims(req as unknown as FastifyRequest);
      return respond(reply, await auth.replaceTwoFactor(c.userId, c.membershipId, req.body.code, meta(req as unknown as FastifyRequest)));
    },
  });

  r.post('/2fa/recovery-codes', {
    access: 'public',
    summary: 'Replace the recovery codes. The new ones are in this response and never again.',
    config: strictLimit,
    body: z.object({ code: secondFactor }),
    handler: async (req) => {
      const c = await claims(req as unknown as FastifyRequest);
      const recoveryCodes = await auth.regenerateRecoveryCodes(c.userId, req.body.code);
      return { session: await auth.me(c.userId, c.membershipId), recoveryCodes };
    },
  });
}
