import { eq } from 'drizzle-orm';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { ensureCostCenter, generalCostCenterId } from '../src/core/costCenters';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/modules/ai/provider';
import { saveDraft } from '../src/modules/ai/records/service';
import type { RecordKind } from '../src/modules/ai/records/routing';
import type { DraftEnv } from '../src/modules/ai/records/types';
import type { DraftInput } from '../src/modules/ai/records/validate';
import { createFixture, type Client, type Fixture } from './helpers';

export const today = new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
export const daysAgo = (n: number) => new Date(Date.now() + 5 * 3_600_000 - n * 86_400_000).toISOString().slice(0, 10);

export interface World {
  f: Fixture;
  owner: Client;
  cash: string;
  bank: string;
  feedCategory: string;
  electricityCategory: string;
  general: string;
  herdCenter: string;
  fieldCenter: string;
  assetCenter: string;
  diesel: string;
  store: string;
  supplier: string;
}

export async function world(extra: { secondBank?: boolean; secondHerd?: boolean } = {}): Promise<World> {
  const f = await createFixture();
  const owner = await f.as('owner');
  const base = { tenantId: f.tenantId, farmId: f.farmId };
  const refs = await f.run(async () => {
    const [cash] = await tx().insert(schema.accounts).values({ ...base, name: 'Kassa', type: 'cash', openingBalance: 100_000_000 }).returning();
    const [bank] = await tx().insert(schema.accounts).values({ ...base, name: 'Agrobank', type: 'bank', openingBalance: 500_000_000 }).returning();
    if (extra.secondBank) await tx().insert(schema.accounts).values({ ...base, name: 'Hamkorbank', type: 'bank' });
    const categories = await tx().select().from(schema.financeCategories).where(eq(schema.financeCategories.tenantId, f.tenantId));
    const key = (k: string) => categories.find((c) => c.key === k)!.id;
    const [herd] = await tx().insert(schema.herds).values({ ...base, name: "Bo'g'oz sovliqlar" }).returning();
    const herdCenter = await ensureCostCenter('herd', herd.id, herd.name);
    if (extra.secondHerd) {
      const [other] = await tx().insert(schema.herds).values({ ...base, name: "Qo'zilar" }).returning();
      await ensureCostCenter('herd', other.id, other.name);
    }
    const [field] = await tx().insert(schema.fields).values({ ...base, number: '1', areaHa: 20 }).returning();
    const fieldCenter = await ensureCostCenter('field', field.id, 'Dala 1');
    const [asset] = await tx().insert(schema.assets).values({ ...base, name: 'MTZ-82 №1', type: 'tractor' }).returning();
    const assetCenter = await ensureCostCenter('asset', asset.id, asset.name);
    const [store] = await tx().insert(schema.warehouses).values({ ...base, name: "Yoqilg'i ombori", type: 'fuel' }).returning();
    const [diesel] = await tx().insert(schema.items).values({ ...base, name: 'Dizel', category: 'fuel', unit: 'l', defaultWarehouseId: store.id }).returning();
    const [supplier] = await tx().insert(schema.counterparties).values({ ...base, name: 'Neft Baza', type: 'supplier' }).returning();
    return {
      cash: cash.id, bank: bank.id, feedCategory: key('feed'), electricityCategory: key('electricity'),
      general: await generalCostCenterId(), herdCenter, fieldCenter, assetCenter, diesel: diesel.id, store: store.id, supplier: supplier.id,
    };
  });
  return { f, owner, ...refs };
}

export const draft = (w: World, kind: RecordKind, input: DraftInput, text: string, proposalId?: string, env: Partial<DraftEnv> = {}) =>
  w.f.run(
    () => saveDraft(kind, input, { userTexts: [text], documentAmounts: [], channel: 'web', conversationId: null, ...env }, proposalId),
    { userId: w.owner.userId },
  );
export const asOwner = <T>(w: World, fn: () => Promise<T>) => w.f.run(fn, { userId: w.owner.userId });

export async function ready(w: World, kind: RecordKind, input: DraftInput, text: string, env: Partial<DraftEnv> = {}) {
  const result = await draft(w, kind, input, text, undefined, env);
  if (result.status !== 'ready') throw new Error(`not ready: ${JSON.stringify(result.questions)}`);
  return result.proposal;
}

export async function asked(w: World, kind: RecordKind, input: DraftInput, text: string, env: Partial<DraftEnv> = {}) {
  const result = await draft(w, kind, input, text, undefined, env);
  if (result.status !== 'needs_info') throw new Error('expected a question');
  return result.questions.map((q) => q.code);
}

export const electricity: DraftInput = { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' };
export const ELECTRICITY = 'Elektrga 3 mln naqd';

export class Scripted implements LlmProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-1';
  readonly configured = true;
  readonly requests: LlmRequest[] = [];
  constructor(private readonly steps: LlmResponse[]) {}
  async complete(request: LlmRequest) {
    this.requests.push(structuredClone({ ...request }));
    const step = this.steps.shift();
    if (!step) throw new Error('The script ran out of steps');
    return step;
  }
}
export const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 };
export const say = (text: string): LlmResponse => ({ stopReason: 'end', content: [{ type: 'text', text }], raw: [], model: 's', usage });
export const call = (name: string, input: unknown): LlmResponse => ({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: `c-${name}`, name, input }], raw: [], model: 's', usage });
