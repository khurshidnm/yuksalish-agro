import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { randomToken, sha256 } from '../../core/crypto';
import { notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';

const { apiKeys } = schema;

export const API_KEY_SCOPES = ['events:write', '*'] as const;

export const apiKeyInput = z.object({
  name: z.string().trim().min(2).max(120),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
  /** Left out, the key works until someone revokes it. */
  expiresInDays: z.number().int().min(1).max(3650).nullish(),
});

const publicColumns = {
  id: apiKeys.id,
  name: apiKeys.name,
  keyPrefix: apiKeys.keyPrefix,
  scopes: apiKeys.scopes,
  lastUsedAt: apiKeys.lastUsedAt,
  expiresAt: apiKeys.expiresAt,
  revokedAt: apiKeys.revokedAt,
  createdAt: apiKeys.createdAt,
};

export async function listKeys() {
  return tx()
    .select(publicColumns)
    .from(apiKeys)
    .where(eq(apiKeys.farmId, ctx().farmId))
    .orderBy(desc(apiKeys.createdAt));
}

/** The key is returned here once; only its hash is stored. */
export async function createKey(input: z.infer<typeof apiKeyInput>) {
  const c = ctx();
  const key = `yap_${randomToken(32)}`;
  const [row] = await tx()
    .insert(apiKeys)
    .values({
      tenantId: c.tenantId,
      farmId: c.farmId,
      createdBy: c.userId,
      name: input.name,
      keyHash: sha256(key),
      keyPrefix: key.slice(0, 12),
      scopes: input.scopes,
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
    })
    .returning(publicColumns);
  await recordEvent({ type: 'api_key.created', severity: 'attention', entityType: 'api_key', entityId: row.id, data: { name: row.name, scopes: row.scopes } });
  return { ...row, key };
}

export async function revokeKey(id: string) {
  const [row] = await tx()
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.farmId, ctx().farmId), isNull(apiKeys.revokedAt)))
    .returning(publicColumns);
  if (!row) throw notFound('API key');
  await recordEvent({ type: 'api_key.revoked', severity: 'attention', entityType: 'api_key', entityId: id });
  return row;
}
