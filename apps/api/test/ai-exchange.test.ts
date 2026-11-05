/**
 * Whole turns through the real path, with a scripted model: what a person said over several messages, what
 * code made of it, and what reached the card. Each test holds a rule of docs/assistant.md that a model cannot
 * be trusted with, so most of them script a model that gets it wrong.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.AI_CHAT_PER_MINUTE = '100000';
  process.env.AI_CHAT_PER_DAY = '1000000';
});

import { and, eq } from 'drizzle-orm';
import { DEFAULT_ROLE_PERMISSIONS } from '@yap/shared';
import { schema } from '../src/db/client';
import { tx, type Identity } from '../src/core/context';
import { ensureCostCenter } from '../src/core/costCenters';
import { postTransaction } from '../src/core/ledger';
import { chat } from '../src/modules/ai/assistant';
import { setProvider, type LlmBlock, type LlmResponse } from '../src/modules/ai/provider';
import { Scripted, asOwner, daysAgo, say, today, world, type World } from './ai-world';

afterEach(() => setProvider(undefined));

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 };
let nextId = 0;
const tools = (...calls: [string, unknown][]): LlmResponse => ({
  stopReason: 'tool_use',
  content: calls.map(([name, input]) => ({ type: 'tool_use', id: `c-${++nextId}`, name, input })),
  raw: [],
  model: 's',
  usage,
});
const call = (name: string, input: unknown) => tools([name, input]);

async function turn(w: World, message: string, steps: LlmResponse[], conversationId?: string) {
  setProvider(new Scripted(steps));
  return w.owner.post('/ai/chat', { message, ...(conversationId ? { conversationId } : {}) });
}

const cards = (res: any): any[] => (res.data?.message?.attachments ?? []).filter((a: any) => a.type === 'proposal').map((a: any) => a.proposal);
const questionOf = (res: any): string | undefined => (res.data?.message?.attachments ?? []).find((a: any) => a.type === 'question')?.question?.code;
const conv = (res: any): string => res.data.conversationId;
const codes = (card: any): string[] => card.warnings.map((x: any) => x.code);
const booked = (w: World) => asOwner(w, () => tx().select().from(schema.transactions).where(eq(schema.transactions.farmId, w.f.farmId)));

const base = (w: World) => ({ tenantId: w.f.tenantId, farmId: w.f.farmId });

async function addField(w: World, number: string) {
  await w.f.run(async () => {
    const [field] = await tx().insert(schema.fields).values({ ...base(w), number, areaHa: 10 }).returning();
    await ensureCostCenter('field', field.id, `Dala ${number}`);
  });
}
async function addAsset(w: World, name: string, type = 'tractor') {
  return w.f.run(async () => {
    const [asset] = await tx().insert(schema.assets).values({ ...base(w), name, type: type as never }).returning();
    return ensureCostCenter('asset', asset.id, asset.name);
  });
}
async function addItems(w: World, ...items: [string, string, string?][]) {
  await w.f.run(() => tx().insert(schema.items).values(items.map(([name, category, unit]) => ({ ...base(w), name, category: category as never, unit: (unit ?? 'kg') as never, defaultWarehouseId: w.store }))));
}
async function usdRate(w: World, rate = 12_500) {
  await w.f.run(() => tx().insert(schema.fxRates).values({ tenantId: w.f.tenantId, date: daysAgo(1), currency: 'USD', rate }));
}
const identity = (w: World): Identity => ({
  userId: w.owner.userId, tenantId: w.f.tenantId, farmId: w.f.farmId, membershipId: w.owner.membershipId, roleKey: 'owner',
  permissions: DEFAULT_ROLE_PERMISSIONS.owner, source: 'mobile', device: 'telegram', currency: 'UZS', timezone: 'Asia/Tashkent',
} as Identity);
const photo: LlmBlock = { type: 'image', mediaType: 'image/jpeg', data: 'AAAA' } as never;
const read = (amount: number) => say(JSON.stringify([{ amount, currency: 'UZS' }]));

// ─── the 'answered' shortcut ────────────────────────────────────────────────

describe('answered: a part of a name while answering a question', () => {
  const service = { amount: 900_000, category: 'mechanization_service', paymentMethod: 'cash' };

  it('"2-dala" answering "which field" cannot put the card on Dala 1', async () => {
    const w = await world();
    await addField(w, '2');
    const first = await turn(w, "Haydash xizmatiga 900 ming naqd to'ladim", [call('draft_expense', service), say('Qaysi dala?')]);
    expect(questionOf(first)).toBe('TARGET_REQUIRED');
    const second = await turn(w, '2-dala', [call('draft_expense', { ...service, target: 'Dala 1' }), say('Tayyor.')], conv(first));
    expect(cards(second).map((c) => c.fields.target?.name)).not.toContain('Dala 1');
  });

  it('repeating the word both goods share does not let the model choose', async () => {
    const w = await world();
    await addItems(w, ["Bug'doy (yem)", 'feed'], ["Bug'doy urug'i", 'seed']);
    const input = { qty: 2, unit: 't', amount: 8_000_000, paymentMethod: 'cash' };
    const first = await turn(w, "2 tonna bug'doy 8 mln naqd oldim", [call('draft_stock_purchase', { ...input, item: "bug'doy" }), say('Qaysi biri?')]);
    expect(questionOf(first)).toBe('ITEM_AMBIGUOUS');
    const second = await turn(w, "bug'doy", [call('draft_stock_purchase', { ...input, item: "Bug'doy urug'i" }), say('Tayyor.')], conv(first));
    expect(cards(second)).toEqual([]);
    expect(questionOf(second)).toBe('ITEM_AMBIGUOUS');
  });

  it('"MTZ emas" answering which machine cannot put the card on the MTZ', async () => {
    const w = await world();
    await addAsset(w, 'Nasos', 'pump');
    const repair = { amount: 2_000_000, category: 'repair', paymentMethod: 'cash' };
    const first = await turn(w, "Ta'mirga 2 mln naqd to'ladim", [call('draft_expense', repair), say('Nima uchun?')]);
    expect(questionOf(first)).toBe('TARGET_REQUIRED');
    const second = await turn(w, 'MTZ emas, nasos', [call('draft_expense', { ...repair, target: 'MTZ-82 №1' }), say('Tayyor.')], conv(first));
    expect(cards(second).map((c) => c.fields.target?.name)).not.toContain('MTZ-82 №1');
  });
});

// ─── singledOut ─────────────────────────────────────────────────────────────

describe('singledOut: names the person never said', () => {
  it('a small word the person said, glued to a name, does not vouch for that name', async () => {
    const w = await world();
    const res = await turn(w, "Ta'mir uchun 2 mln naqd to'ladim", [call('draft_expense', { amount: 2_000_000, category: 'repair', paymentMethod: 'cash', target: 'uchun MTZ-82 №1' }), say('Tayyor.')]);
    expect(cards(res)).toEqual([]);
    expect(questionOf(res)).toMatch(/^TARGET_/);
  });

  it('the same for who a debt is owed to', async () => {
    const w = await world();
    const res = await turn(w, "Elektr uchun 2 mln qarzga oldik", [call('draft_expense', { amount: 2_000_000, category: 'electricity', paymentMethod: 'debt', counterparty: 'uchun Neft Baza' }), say('Tayyor.')]);
    expect(cards(res)).toEqual([]);
    expect(questionOf(res)).toMatch(/^COUNTERPARTY_/);
  });

  it('the only herd is not said to be named when the words name another', async () => {
    const w = await world();
    const res = await turn(w, "Qo'chqorlarni qirqish 460 ming naqd to'ladim", [call('draft_expense', { amount: 460_000, category: 'shearing', paymentMethod: 'cash', target: "Qo'chqorlar" }), say('Tayyor.')]);
    // Their words name something else, so it is a question, or at the least the card says it is a default.
    const [card] = cards(res);
    if (card) expect(card.fields.target).toMatchObject({ defaulted: true });
    else expect(questionOf(res)).toMatch(/^TARGET_/);
  });

  it('"arpa urug\'i" is not the plain Arpa just because the model says so', async () => {
    const w = await world();
    await addItems(w, ['Arpa', 'feed'], ["Arpa urug'i", 'seed']);
    const res = await turn(w, "2 tonna arpa urug'i 4 mln naqd oldim", [call('draft_stock_purchase', { item: 'Arpa', qty: 2, unit: 't', amount: 4_000_000, paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(cards(res).map((c) => c.fields.item?.name)).not.toContain('Arpa');
  });

  it('"семена ячменя" is not the plain Arpa either', async () => {
    const w = await world();
    await addItems(w, ['Arpa', 'feed'], ["Arpa urug'i", 'seed']);
    const res = await turn(w, 'Купил 2 тонны семян ячменя за 4 млн наличными', [call('draft_stock_purchase', { item: 'Arpa', qty: 2, unit: 't', amount: 4_000_000, paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(cards(res).map((c) => c.fields.item?.name)).not.toContain('Arpa');
  });
});

// ─── across turns ───────────────────────────────────────────────────────────

describe('across turns', () => {
  it('change said before a question still needs a yes when the card comes on the next turn', async () => {
    const w = await world();
    const elec = { amount: 5_000_000, category: 'electricity' };
    const first = await turn(w, 'Elektrga 5 mln berdim, 200 ming qaytdi', [call('draft_expense', elec), say("Qanday to'landi?")]);
    expect(questionOf(first)).toBe('PAYMENT_METHOD_REQUIRED');
    const second = await turn(w, 'naqd', [call('draft_expense', { ...elec, paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    const [card] = cards(second);
    expect(card.fields.amount).toBe(5_000_000);
    expect(codes(card)).toContain('OTHER_AMOUNT');
    expect(card.needsAcknowledgement).toBe(true);
  });

  it('change in a message that also leaves a question open still needs a yes', async () => {
    const w = await world();
    const res = await turn(w, "Elektrga 5 mln berdim, 200 ming qaytdi, naqd. Yemga 300 ming ham naqd to'ladim", [
      tools(['draft_expense', { amount: 5_000_000, category: 'electricity', paymentMethod: 'cash' }], ['draft_expense', { amount: 300_000, category: 'feed', paymentMethod: 'cash' }]),
      say('Yem omborga kirdimi?'),
    ]);
    expect(questionOf(res)).toBe('GOODS_STOCK_OR_DIRECT');
    const [card] = cards(res);
    expect(codes(card)).toContain('OTHER_AMOUNT');
  });

  it('approximate change is still money no card accounts for', async () => {
    const w = await world();
    const res = await turn(w, 'Elektrga 5 mln berdim, taxminan 200 ming qaytdi, naqd', [call('draft_expense', { amount: 5_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(codes(cards(res)[0])).toContain('OTHER_AMOUNT');
  });

  it('money already on a ready card cannot fund another record while a question on a third stays open', async () => {
    const w = await world();
    const first = await turn(w, "Elektrga 3 mln naqd, yemga ham to'ladim", [
      tools(['draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' }], ['draft_expense', { category: 'feed', paymentMethod: 'cash' }]),
      say('Yemga qancha?'),
    ]);
    expect(cards(first)).toHaveLength(1);
    expect(questionOf(first)).toBe('AMOUNT_REQUIRED');
    const second = await turn(w, "Gazga ham to'ladim", [call('draft_expense', { amount: 3_000_000, category: 'gas', paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    expect(cards(second)).toEqual([]);
    expect(questionOf(second)).toBe('AMOUNT_NOT_STATED');
  });

  it('a new record said while a question is open does not inherit the old record\'s day and payment', async () => {
    const w = await world();
    await addAsset(w, 'MTZ-80 №2');
    const first = await turn(w, "Kecha MTZ ta'miriga 2 mln naqd to'ladim", [call('draft_expense', { amount: 2_000_000, category: 'repair', paymentMethod: 'cash', target: 'MTZ' }), say('Qaysi MTZ?')]);
    expect(questionOf(first)).toBe('TARGET_AMBIGUOUS');
    const second = await turn(w, "Gazga 500 ming to'ladim", [call('draft_expense', { amount: 500_000, category: 'gas' }), say('Tayyor.')], conv(first));
    const [card] = cards(second);
    if (card) expect(card.fields.date).toBe(today);
    else expect(questionOf(second)).toBe('PAYMENT_METHOD_REQUIRED');
  });

  it('"bugun" answered two days later is no longer an answer, so nothing is filed under the wrong day', async () => {
    const w = await world();
    const elec = { amount: 3_000_000, category: 'electricity' };
    const first = await turn(w, "Bugun elektrga 3 mln to'ladim", [call('draft_expense', elec), say("Qanday to'landi?")]);
    await w.f.run(() => tx().update(schema.aiMessages).set({ createdAt: new Date(Date.now() - 2 * 86_400_000) }).where(eq(schema.aiMessages.conversationId, conv(first))));
    const second = await turn(w, 'naqd', [call('draft_expense', { ...elec, paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    expect(cards(second)).toEqual([]);
    expect(questionOf(second)).toBe('AMOUNT_NOT_STATED');
  });

  it('a total said before a question is not lost when the card comes on the next turn', async () => {
    const w = await world();
    await addItems(w, ['Benzin', 'fuel', 'l']);
    const line = { qty: 200, unit: 'l', unitPrice: 15_000, paymentMethod: 'cash' };
    const first = await turn(w, "200 litr yoqilg'i 15 mingdan, jami 5 mln naqd oldim", [call('draft_stock_purchase', { ...line, item: "yoqilg'i" }), say('Qaysi biri?')]);
    expect(questionOf(first)).toBe('ITEM_AMBIGUOUS');
    const second = await turn(w, 'Dizel', [call('draft_stock_purchase', { ...line, item: 'Dizel' }), say('Tayyor.')], conv(first));
    expect(cards(second)).toEqual([]);
    expect(questionOf(second)).toBe('AMOUNT_AMBIGUOUS');
  });

  it('a polite closing question after a refusal does not keep its money open', async () => {
    const w = await world();
    const first = await turn(w, "Qo'y sotdim, 20 mln naqd tushdi", [call('draft_income', { amount: 20_000_000, category: 'subsidies', paymentMethod: 'cash' }), say('Buni Savdo bo\'limida kiriting. Yana nima kerak?')]);
    expect(cards(first)).toEqual([]);
    const second = await turn(w, "Elektrga ham to'ladim", [call('draft_expense', { amount: 20_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    expect(cards(second)).toEqual([]);
    expect(questionOf(second)).toBe('AMOUNT_NOT_STATED');
  });

  it('a stale question is not left beside the card that answered it', async () => {
    const w = await world();
    const res = await turn(w, "200 litr yoqilg'i 3 mln naqd oldim", [
      call('draft_expense', { amount: 3_000_000, category: 'fuel', paymentMethod: 'cash' }),
      call('draft_stock_purchase', { item: 'Dizel', qty: 200, unit: 'l', amount: 3_000_000, paymentMethod: 'cash' }),
      say('Tasdiqlang.'),
    ]);
    expect(cards(res)).toHaveLength(1);
    expect(questionOf(res)).toBeUndefined();
    expect(res.data.message.asked).toEqual([]);
  });
});

// ─── what the answer to a question really said ──────────────────────────────

describe('an open question is not a blank cheque', () => {
  it('a corrected amount while the rate is being asked for is not the rate', async () => {
    const w = await world();
    const repair = { category: 'repair', target: 'MTZ', paymentMethod: 'cash', currency: 'USD' };
    const first = await turn(w, "MTZ ta'miriga 200 dollar naqd to'ladim", [call('draft_expense', { ...repair, amount: 200 }), say('Kurs qancha?')]);
    expect(questionOf(first)).toBe('FX_RATE_REQUIRED');
    const second = await turn(w, "yo'q, 300 dollar edi", [call('draft_expense', { ...repair, amount: 300 }), say('Tayyor.')], conv(first));
    const [card] = cards(second);
    if (card) await w.owner.post(`/ai/proposals/${card.id}/confirm`, { stamp: card.stamp, acknowledged: true });
    const rows = await booked(w);
    expect(rows.map((t) => t.amountBase)).not.toContain(90_000);
    expect(questionOf(second)).toBe('FX_RATE_REQUIRED');
  });

  it('"so\'m" answering which currency cannot leave dollars on the card', async () => {
    const w = await world();
    await usdRate(w);
    const repair = { amount: 5_000, category: 'repair', target: 'MTZ', paymentMethod: 'cash', currency: 'USD' };
    const first = await turn(w, "MTZ ta'miriga 5 ming naqd to'ladim", [call('draft_expense', repair), say('Qaysi valyuta?')]);
    expect(questionOf(first)).toBe('CURRENCY_UNCLEAR');
    const second = await turn(w, "so'm", [call('draft_expense', repair), say('Tayyor.')], conv(first));
    expect(cards(second).map((c) => c.fields.currency)).not.toContain('USD');
  });

  it('"omborga" answering warehouse-or-direct cannot make a direct expense', async () => {
    const w = await world();
    const feed = { amount: 3_000_000, category: 'feed', paymentMethod: 'cash' };
    const first = await turn(w, "Yemga 3 mln naqd to'ladim", [call('draft_expense', feed), say('Omborgami?')]);
    expect(questionOf(first)).toBe('GOODS_STOCK_OR_DIRECT');
    const second = await turn(w, 'omborga', [call('draft_expense', { ...feed, direct: true }), say('Tayyor.')], conv(first));
    expect(cards(second)).toEqual([]);
  });

  it('a pay question still comes when the job was said in an earlier message of the exchange', async () => {
    const w = await world();
    const guard = { category: 'security_guard', paymentMethod: 'cash' };
    const first = await turn(w, 'Qorovulga pul berdim', [call('draft_expense', guard), say('Qancha?')]);
    expect(questionOf(first)).toBe('AMOUNT_REQUIRED');
    const second = await turn(w, '2 mln naqd', [call('draft_expense', { ...guard, amount: 2_000_000 }), say('Tayyor.')], conv(first));
    expect(cards(second)).toEqual([]);
    expect(questionOf(second)).toBe('WAGE_OR_SERVICE');
  });

  it('"oylik" answering wage-or-service is a wage', async () => {
    const w = await world();
    const guard = { amount: 2_000_000, category: 'security_guard', paymentMethod: 'cash' };
    const first = await turn(w, 'Qorovulga 2 mln naqd berdim', [call('draft_expense', guard), say('Oylikmi?')]);
    expect(questionOf(first)).toBe('WAGE_OR_SERVICE');
    const second = await turn(w, 'oylik', [call('draft_expense', guard), say('Tayyor.')], conv(first));
    expect(cards(second)).toEqual([]);
  });

  it('something still to pay does not become a card because the next word is only "yo\'q"', async () => {
    const w = await world();
    const elec = { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' };
    const first = await turn(w, "Elektrga 3 mln naqd to'lashim kerak", [call('draft_expense', elec), say("To'landimi?")]);
    expect(questionOf(first)).toBe('NOT_HAPPENED');
    const second = await turn(w, "yo'q", [call('draft_expense', elec), say('Tayyor.')], conv(first));
    expect(cards(second)).toEqual([]);
  });

  it('"umumiy emas" cannot put the card on General', async () => {
    const w = await world();
    const repair = { amount: 2_000_000, category: 'repair', paymentMethod: 'cash' };
    const first = await turn(w, "Ta'mirga 2 mln naqd to'ladim", [call('draft_expense', repair), say('Nima uchun?')]);
    const second = await turn(w, 'umumiy emas', [call('draft_expense', { ...repair, target: 'general' }), say('Tayyor.')], conv(first));
    expect(cards(second)).toEqual([]);
  });
});

// ─── the needed yes ─────────────────────────────────────────────────────────

describe('a needed yes', () => {
  it('a later correction of something else does not clear OTHER_AMOUNT', async () => {
    const w = await world();
    const first = await turn(w, 'Elektrga 5 mln berdim, 200 ming qaytdi, naqd', [call('draft_expense', { amount: 5_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]);
    const [card] = cards(first);
    expect(card.needsAcknowledgement).toBe(true);
    const second = await turn(w, 'izohga noyabr uchun deb yoz', [call('update_draft', { proposalId: card.id, changes: { description: 'noyabr uchun' } }), say('Tayyor.')], conv(first));
    expect(cards(second)[0].needsAcknowledgement).toBe(true);
  });

  it('a change in the card form does not clear OTHER_AMOUNT', async () => {
    const w = await world();
    const first = await turn(w, 'Elektrga 5 mln berdim, 200 ming qaytdi, naqd', [call('draft_expense', { amount: 5_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]);
    const [card] = cards(first);
    const edited = await w.owner.patch(`/ai/proposals/${card.id}`, { description: 'noyabr uchun' });
    expect(edited.data.needsAcknowledgement).toBe(true);
  });

  it('a later correction of the day does not clear AMOUNT_FROM_DOCUMENT', async () => {
    const w = await world();
    setProvider(new Scripted([read(1_500_000), call('draft_expense', { amount: 1_500_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]));
    const first = await chat(identity(w), { message: "Shu chek, elektr, naqd to'ladim", blocks: [photo], channel: 'telegram' });
    const [card] = first.message.attachments.filter((a: any) => a.type === 'proposal').map((a: any) => a.proposal);
    expect(codes(card)).toContain('AMOUNT_FROM_DOCUMENT');
    setProvider(new Scripted([call('update_draft', { proposalId: card.id, changes: { date: daysAgo(1) } }), say('Tayyor.')]));
    const second = await chat(identity(w), { conversationId: first.conversationId, message: 'kecha edi', channel: 'telegram' });
    const [updated] = second.message.attachments.filter((a: any) => a.type === 'proposal').map((a: any) => a.proposal);
    expect(updated.needsAcknowledgement).toBe(true);
  });

  it('a yes given to one warning does not cover a duplicate that appeared after it was asked', async () => {
    const w = await world();
    const res = await turn(w, 'Elektrga 5 mln berdim, 200 ming qaytdi, naqd', [call('draft_expense', { amount: 5_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]);
    const [card] = cards(res);
    const asked = await w.owner.post(`/ai/proposals/${card.id}/confirm`, { stamp: card.stamp });
    expect(asked.body.error.code).toBe('NOT_ACKNOWLEDGED');
    expect(codes(asked.body.error.details.proposal)).not.toContain('POSSIBLE_DUPLICATE');
    await asOwner(w, () => postTransaction({ date: today, type: 'expense', amount: 5_000_000, categoryId: w.electricityCategory, paymentMethod: 'cash', accountId: w.cash, costCenterId: w.general }));
    const yes = await w.owner.post(`/ai/proposals/${card.id}/confirm`, { stamp: card.stamp, acknowledged: true });
    const rows = await booked(w);
    expect({ refused: yes.body.error?.code, inBooks: rows.length }).toEqual({ refused: 'PROPOSAL_CHANGED', inBooks: 1 });
    expect(codes(yes.body.error.details.proposal)).toContain('POSSIBLE_DUPLICATE');
  });

  it('the person\'s words outrank a document on the turn after they were said', async () => {
    const w = await world();
    const elec = { category: 'electricity' };
    setProvider(new Scripted([read(3_500_000), call('draft_expense', { ...elec, amount: 3_000_000 }), say("Qanday to'landi?")]));
    const first = await chat(identity(w), { message: "Elektrga 3 mln to'ladim", blocks: [photo], channel: 'telegram' });
    setProvider(new Scripted([call('draft_expense', { ...elec, amount: 3_500_000, paymentMethod: 'cash' }), say('Tayyor.')]));
    const second = await chat(identity(w), { conversationId: first.conversationId, message: 'naqd', channel: 'telegram' });
    expect(second.message.attachments.filter((a: any) => a.type === 'proposal')).toEqual([]);
    expect(second.message.asked).toContain('AMOUNT_CONFLICT');
  });
});

// ─── reported speech, forwarded words ───────────────────────────────────────

describe('someone else\'s words', () => {
  it('"to\'ladim deyapti" is what someone else says about themselves', async () => {
    const w = await world();
    const res = await turn(w, "Akmal elektrga 3 mln naqd to'ladim deyapti", [call('draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(cards(res)).toEqual([]);
    expect(questionOf(res)).toBe('NOT_HAPPENED');
  });

  it('a figure taken back in a forwarded message cannot be the amount', async () => {
    const w = await world();
    const elec = { amount: 3_000_000, category: 'electricity' };
    setProvider(new Scripted([call('draft_expense', elec), say("Qanday to'landi?")]));
    const first = await chat(identity(w), { message: "Elektrga 3 mln emas, 4 mln to'langan", forwarded: true, channel: 'telegram' });
    expect(first.message.asked).toEqual(['AMOUNT_NOT_STATED']);
    setProvider(new Scripted([call('draft_expense', { ...elec, paymentMethod: 'cash' }), say('Tayyor.')]));
    const second = await chat(identity(w), { conversationId: first.conversationId, message: 'naqd', channel: 'telegram' });
    expect(second.message.attachments.filter((a: any) => a.type === 'proposal')).toEqual([]);
  });

  it('a forwarded plan is not filed as paid today', async () => {
    const w = await world();
    const elec = { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' };
    setProvider(new Scripted([call('draft_expense', elec), say("Qanday to'landi?")]));
    const first = await chat(identity(w), { message: "Ertaga elektrga 3 mln to'laymiz", forwarded: true, channel: 'telegram' });
    setProvider(new Scripted([call('draft_expense', elec), say('Tayyor.')]));
    const second = await chat(identity(w), { conversationId: first.conversationId, message: 'naqd', channel: 'telegram' });
    expect(second.message.attachments.filter((a: any) => a.type === 'proposal')).toEqual([]);
  });

  it('forwarded pay is still payroll, whichever category the model picks', async () => {
    const w = await world();
    const pay = { amount: 20_000_000, category: 'meals' };
    setProvider(new Scripted([call('draft_expense', pay), say("Qanday to'landi?")]));
    const first = await chat(identity(w), { message: 'Ishchilarga oylik 20 mln berildi', forwarded: true, channel: 'telegram' });
    setProvider(new Scripted([call('draft_expense', { ...pay, paymentMethod: 'cash' }), say('Tayyor.')]));
    const second = await chat(identity(w), { conversationId: first.conversationId, message: 'naqd', channel: 'telegram' });
    expect(second.message.attachments.filter((a: any) => a.type === 'proposal')).toEqual([]);
  });
});

// ─── other model-only values ────────────────────────────────────────────────

describe('values only the model vouches for', () => {
  it('from and to of a transfer follow the words', async () => {
    const w = await world();
    const res = await turn(w, "Kassadan Agrobankka 2 mln o'tkazdim", [call('draft_transfer', { amount: 2_000_000, account: 'Agrobank', toAccount: 'Kassa' }), say('Tayyor.')]);
    const [card] = cards(res);
    if (card) expect(card.fields.account.name).toBe('Kassa');
    else expect(questionOf(res)).toBeDefined();
  });

  it('debt cannot replace an account the person named', async () => {
    const w = await world();
    const res = await turn(w, "Elektrga kassadan 3 mln to'ladim, Neft Bazaga", [call('draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'debt', account: 'Kassa', counterparty: 'Neft Baza' }), say('Tayyor.')]);
    expect(cards(res).map((c) => c.fields.paymentMethod)).not.toContain('debt');
  });

  it('one amount said once does not make two plain cards', async () => {
    const w = await world();
    const res = await turn(w, "Elektr va gazga 3 mln naqd to'ladim", [
      tools(['draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' }], ['draft_expense', { amount: 3_000_000, category: 'gas', paymentMethod: 'cash' }]),
      say('Tayyor.'),
    ]);
    const plain = cards(res).filter((c) => !c.needsAcknowledgement);
    expect(plain.length).toBeLessThanOrEqual(1);
  });

  it('a claim of saving is replaced when an open card waits, even if this message held no money', async () => {
    const w = await world();
    const first = await turn(w, 'Elektrga 3 mln naqd', [call('draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]);
    const second = await turn(w, 'Ha, tasdiqlayman', [say("Tasdiqlandi, yozib qo'ydim.")], conv(first));
    expect(second.data.message.text).not.toContain("yozib qo'ydim");
    expect(await booked(w)).toHaveLength(0);
  });
});

// ─── form edits ─────────────────────────────────────────────────────────────

describe('a person\'s own form edit', () => {
  it('an unrelated form edit does not adopt the amount the model was refused', async () => {
    const w = await world();
    const first = await turn(w, 'Elektrga 3 mln naqd', [call('draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]);
    const [card] = cards(first);
    const second = await turn(w, "yo'q, boshqa summa edi", [call('update_draft', { proposalId: card.id, changes: { amount: 9_999_000 } }), say('Qancha?')], conv(first));
    expect(questionOf(second)).toBe('AMOUNT_NOT_STATED');
    const edited = await w.owner.patch(`/ai/proposals/${card.id}`, { description: 'noyabr' });
    if (edited.data.stamp) await w.owner.post(`/ai/proposals/${card.id}/confirm`, { stamp: edited.data.stamp, acknowledged: true });
    const rows = await booked(w);
    expect(rows.map((t) => t.amount)).not.toContain(9_999_000);
  });

  it('changing only the account in the form is the person\'s statement, whatever the first words said', async () => {
    const w = await world();
    const first = await turn(w, 'Elektrga 3 mln naqd', [call('draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]);
    const [card] = cards(first);
    const edited = await w.owner.patch(`/ai/proposals/${card.id}`, { accountId: w.bank });
    expect(edited.data.questions).toBeUndefined();
    expect(edited.data.fields.account.name).toBe('Agrobank');
  });
});

// ─── closing the gaps around water, places and totals ───────────────────────

describe('places, water, totals', () => {
  it('a place named with the target left out never quietly stays on General', async () => {
    const w = await world();
    const res = await turn(w, "3-dala nasosi uchun elektrga 2 mln naqd to'ladim", [call('draft_expense', { amount: 2_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(cards(res)).toEqual([]);
    expect(questionOf(res)).toBe('TARGET_REQUIRED');
  });

  it('a field the farm has, named with the target left out, does not stay on General', async () => {
    const w = await world();
    const res = await turn(w, 'Yuk tashish 600 ming naqd, birinchi dalaga', [call('draft_expense', { amount: 600_000, category: 'transport', paymentMethod: 'cash' }), say('Tayyor.')]);
    const [card] = cards(res);
    if (card) expect(card.fields.target.costCenterId).toBe(w.fieldCenter);
    else expect(questionOf(res)).toBe('TARGET_REQUIRED');
  });

  it('"3-dalaga suv" with office water and no target does not land on General', async () => {
    const w = await world();
    const res = await turn(w, "3-dalaga suv uchun 900 ming naqd to'ladim", [call('draft_expense', { amount: 900_000, category: 'utility_water', paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(cards(res).map((c) => c.fields.target?.type)).not.toContain('general');
  });

  it('a total beside the word for it is the total, not the unit price next to it', async () => {
    const w = await world();
    const res = await turn(w, "200 litr dizel 15 mingdan jami 3 mln naqd oldim", [call('draft_stock_purchase', { item: 'Dizel', qty: 200, unit: 'l', unitPrice: 15_000, paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(questionOf(res)).toBeUndefined();
    expect(cards(res)[0].fields.amount).toBe(3_000_000);
  });
});

// ─── what code never asks the words ─────────────────────────────────────────

describe('what the words never decide', () => {
  it('money paid out is not filed as money in', async () => {
    const w = await world();
    const res = await turn(w, "Elektrga 3 mln naqd to'ladim", [call('draft_income', { amount: 3_000_000, category: 'subsidies', paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(cards(res).map((c) => c.kind)).not.toContain('income');
  });

  it('a note cannot carry money or a name nobody said', async () => {
    const w = await world();
    const res = await turn(w, 'Elektrga 3 mln naqd', [call('draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash', description: 'Akmalga 10 mln qarz qaytarildi' }), say('Tayyor.')]);
    expect(cards(res)[0]?.fields.description ?? '').not.toContain('10 mln');
  });

  it('two records of one amount: the one still being asked about is not dropped', async () => {
    const w = await world();
    const res = await turn(w, "Ta'mirga 3 mln, gazga 3 mln naqd to'ladim", [
      tools(['draft_expense', { amount: 3_000_000, category: 'repair', paymentMethod: 'cash' }], ['draft_expense', { amount: 3_000_000, category: 'gas', paymentMethod: 'cash' }]),
      say('Tasdiqlang.'),
    ]);
    expect(cards(res)).toHaveLength(1);
    expect(questionOf(res)).toBe('TARGET_REQUIRED');
  });

  it('a newer quantity is not outvoted by an older one the model repeats', async () => {
    const w = await world();
    const line = { item: 'Dizel', qty: 200, unit: 'l', amount: 3_000_000 };
    const first = await turn(w, '200 litr dizel 3 mln oldim', [call('draft_stock_purchase', line), say("Qanday to'landi?")]);
    expect(questionOf(first)).toBe('PAYMENT_METHOD_REQUIRED');
    const second = await turn(w, '300 litr edi, naqd', [call('draft_stock_purchase', { ...line, paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    expect(cards(second).map((c) => c.fields.qty)).not.toContain(200);
  });

  it('a newer amount said alone is not outvoted once the next message holds no money', async () => {
    const w = await world();
    const elec = { amount: 3_000_000, category: 'electricity' };
    const first = await turn(w, "Elektrga 3 mln to'ladim", [call('draft_expense', elec), say("Qanday to'landi?")]);
    const second = await turn(w, '4 mln edi', [call('draft_expense', { ...elec, amount: 4_000_000 }), say("Qanday to'landi?")], conv(first));
    expect(questionOf(second)).toBe('PAYMENT_METHOD_REQUIRED');
    const third = await turn(w, 'naqd', [call('draft_expense', { ...elec, paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    const [card] = cards(third);
    if (card) expect(card.needsAcknowledgement).toBe(true);
  });
});

// ─── goods vocabulary ───────────────────────────────────────────────────────

describe('goods vocabulary', () => {
  it('wheat said to be for feed, with only a seed on the shelf, is a question', async () => {
    const w = await world();
    await addItems(w, ["Bug'doy urug'i", 'seed']);
    const res = await turn(w, "2 tonna bug'doy yem uchun 8 mln naqd oldim", [call('draft_stock_purchase', { item: "Bug'doy urug'i", qty: 2, unit: 't', amount: 8_000_000, paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(cards(res)).toEqual([]);
  });

  it('the same word in Russian, bought as feed, is not the seed either', async () => {
    const w = await world();
    await addItems(w, ["Bug'doy urug'i", 'seed']);
    const res = await turn(w, 'Купили 2 тонны пшеницы на корм за 8 млн наличными', [call('draft_stock_purchase', { item: 'пшеница', qty: 2, unit: 't', amount: 8_000_000, paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(cards(res).map((c) => c.fields.item?.name)).not.toContain("Bug'doy urug'i");
  });
});

// ─── control cases: the same message without the shortcut ───────────────────

describe('controls: what the rule does when the shortcut is not in play', () => {
  it('"2-dala" in the first message does not let the model say Dala 1', async () => {
    const w = await world();
    await addField(w, '2');
    const res = await turn(w, "2-dala haydash xizmatiga 900 ming naqd to'ladim", [call('draft_expense', { amount: 900_000, category: 'mechanization_service', paymentMethod: 'cash', target: 'Dala 1' }), say('Tayyor.')]);
    expect(cards(res)).toEqual([]);
  });

  it('"MTZ emas" in the first message does not let the model say MTZ', async () => {
    const w = await world();
    await addAsset(w, 'Nasos', 'pump');
    const res = await turn(w, "Ta'mirga 2 mln naqd to'ladim, MTZ emas, nasos", [call('draft_expense', { amount: 2_000_000, category: 'repair', paymentMethod: 'cash', target: 'MTZ-82 №1' }), say('Tayyor.')]);
    expect(cards(res)).toEqual([]);
  });

  it('with no small word the model cannot name a machine nobody said', async () => {
    const w = await world();
    const res = await turn(w, "Ta'mir uchun 2 mln naqd to'ladim", [call('draft_expense', { amount: 2_000_000, category: 'repair', paymentMethod: 'cash', target: 'MTZ-82 №1' }), say('Tayyor.')]);
    expect(cards(res)).toEqual([]);
  });

  it('the same words in one message raise OTHER_AMOUNT', async () => {
    const w = await world();
    const res = await turn(w, 'Elektrga 5 mln berdim, 200 ming qaytdi, naqd', [call('draft_expense', { amount: 5_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(codes(cards(res)[0])).toContain('OTHER_AMOUNT');
  });

  it('a plan said in the latest message is refused', async () => {
    const w = await world();
    const res = await turn(w, "Elektrga 3 mln naqd to'lashim kerak", [call('draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' }), say("To'landimi?")]);
    expect(questionOf(res)).toBe('NOT_HAPPENED');
  });
});

describe('small numbers and answers', () => {
  it('a bare "15 dan" for diesel is asked about, as a bare total is', async () => {
    const w = await world();
    const res = await turn(w, '500 litr dizel 15 dan naqd oldim', [call('draft_stock_purchase', { item: 'Dizel', qty: 500, unit: 'l', unitPrice: 15, paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(cards(res)).toEqual([]);
    expect(questionOf(res)).toBe('AMOUNT_UNCLEAR');
  });

  it('a rate that cannot be a rate is asked about even with none stored', async () => {
    const w = await world();
    const res = await turn(w, "MTZ ta'miriga 200 dollar, kurs 12,7, naqd to'ladim", [call('draft_expense', { amount: 200, currency: 'USD', category: 'repair', target: 'MTZ', paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(cards(res)).toEqual([]);
    expect(questionOf(res)).toBe('FX_RATE_REQUIRED');
  });

  it('"naqd bo\'ladi" answering how it was paid is an answer, not a plan', async () => {
    const w = await world();
    const elec = { amount: 3_000_000, category: 'electricity' };
    const first = await turn(w, "Elektrga 3 mln to'ladim", [call('draft_expense', elec), say("Qanday to'landi?")]);
    const second = await turn(w, "naqd bo'ladi", [call('draft_expense', { ...elec, paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    expect(questionOf(second)).toBeUndefined();
    expect(cards(second)).toHaveLength(1);
  });

  it('"dollar edi" correcting a card is a statement of the currency', async () => {
    const w = await world();
    await usdRate(w);
    const first = await turn(w, 'Elektrga 300 ming naqd', [call('draft_expense', { amount: 300_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]);
    const [card] = cards(first);
    const second = await turn(w, 'dollar edi', [call('update_draft', { proposalId: card.id, changes: { currency: 'USD' } }), say('Tayyor.')], conv(first));
    expect(questionOf(second)).toBeUndefined();
  });
});

describe('reported speech', () => {
  const words = [
    ["Usta elektrga 3 mln naqd to'ladi deyishdi", 'deyishdi'],
    ["Usta elektrga 3 mln naqd to'ladi deyishyapti", 'deyishyapti'],
    ["Akmal aka elektrga 3 mln naqd to'ladim deb aytdi", 'deb aytdi'],
    ["Akmal elektrga 3 mln naqd berdim dedi", 'berdim dedi'],
    ["Акмал пишет что заплатил за свет 3 млн наличными", 'пишет'],
    ["Akmal claims he paid 3 million cash for electricity", 'claims'],
  ];
  for (const [text, label] of words) {
    it(`reported: ${label}`, async () => {
      const w = await world();
      const res = await turn(w, text, [call('draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]);
      expect(questionOf(res)).toBe('NOT_HAPPENED');
    });
  }
});

describe('card against the books', () => {
  const press = (w: World, card: any, extra: Record<string, unknown> = {}) => w.owner.post(`/ai/proposals/${card.id}/confirm`, { stamp: card.stamp, ...extra });
  const balances = async (w: World) => {
    const { data } = await w.owner.get('/finance/accounts');
    return Object.fromEntries((data as any[]).map((a) => [a.name, a.balance ?? a.currentBalance]));
  };

  it('dollars from a so\'m account take the so\'m value out of it', async () => {
    const w = await world();
    await usdRate(w);
    const [card] = cards(await turn(w, 'Elektrga 300 dollar naqd', [call('draft_expense', { amount: 300, currency: 'USD', category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]));
    const before = await balances(w);
    expect((await press(w, card, { acknowledged: true })).status).toBe(200);
    const after = await balances(w);
    expect(before.Kassa - after.Kassa).toBe(3_750_000);
  });

  it('dollars moved between two so\'m accounts move the so\'m value on both sides', async () => {
    const w = await world();
    await usdRate(w);
    const [card] = cards(await turn(w, "Kassadan Agrobankka 300 dollar o'tkazdim", [call('draft_transfer', { amount: 300, currency: 'USD', account: 'Kassa', toAccount: 'Agrobank' }), say('Tayyor.')]));
    const before = await balances(w);
    const res = await press(w, card, { acknowledged: true });
    const after = await balances(w);
    expect(res.status).toBe(200);
    expect(before.Kassa - after.Kassa).toBe(3_750_000);
    expect(after.Agrobank - before.Agrobank).toBe(3_750_000);
  });

  it('a stale card can be mended in its form and then confirmed', async () => {
    const w = await world();
    const [card] = cards(await turn(w, 'Elektrga 3 mln naqd', [call('draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]));
    await w.f.run(() => tx().update(schema.accounts).set({ active: false }).where(eq(schema.accounts.id, w.cash)));
    const stale = await press(w, card);
    expect(stale.body.error.code).toBe('PROPOSAL_STALE');
    const edited = await w.owner.patch(`/ai/proposals/${card.id}`, { accountId: w.bank, paymentMethod: 'bank' });
    expect(edited.data.fields.account.name).toBe('Agrobank');
    expect((await press(w, edited.data)).status).toBe(200);
  });

  it('a closed counterparty does not leave its raw id as the note', async () => {
    const w = await world();
    const [card] = cards(await turn(w, "Neft Bazaga elektr uchun 3 mln naqd to'ladim", [call('draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash', counterparty: 'Neft Baza' }), say('Tayyor.')]));
    expect(card.fields.counterparty.name).toBe('Neft Baza');
    await w.f.run(() => tx().update(schema.counterparties).set({ active: false }).where(eq(schema.counterparties.id, w.supplier)));
    const edited = await w.owner.patch(`/ai/proposals/${card.id}`, {});
    expect(edited.data.fields?.description ?? null).not.toBe(w.supplier);
  });

  it('a card made from a price still confirms after its quantity is edited', async () => {
    const w = await world();
    const [card] = cards(await turn(w, '300 litr dizel 15 mingdan naqd oldim', [call('draft_stock_purchase', { item: 'Dizel', qty: 300, unit: 'l', unitPrice: 15_000, paymentMethod: 'cash' }), say('Tayyor.')]));
    expect(card.fields.amount).toBe(4_500_000);
    const edited = await w.owner.patch(`/ai/proposals/${card.id}`, { qty: 333.333 });
    expect(edited.data.fields.amount).toBe(4_999_995);
    expect((await press(w, edited.data)).status).toBe(200);
  });
});

describe('what the words decide about a whole turn', () => {
  it('a sentence that says the card is ready is not kept when there is no card', async () => {
    const w = await world();
    const res = await turn(w, "Elektrga 3 mln to'ladim", [call('draft_expense', { amount: 3_000_000, category: 'electricity' }), say('Karta tayyor, tasdiqlang.')]);
    expect(cards(res)).toEqual([]);
    expect(res.data.message.text).not.toContain('tayyor');
  });

  it('paying off a debt the books hold is not a new expense', async () => {
    const w = await world();
    await asOwner(w, () => postTransaction({ date: daysAgo(5), type: 'expense', amount: 4_000_000, categoryId: w.electricityCategory, paymentMethod: 'debt', counterpartyId: w.supplier, costCenterId: w.general }));
    const res = await turn(w, "Neft Bazaga qarzimizni 3 mln naqd to'ladim", [call('draft_expense', { amount: 3_000_000, category: 'transport', paymentMethod: 'cash', counterparty: 'Neft Baza' }), say('Tayyor.')]);
    expect(cards(res).map((c) => c.kind)).not.toContain('expense');
  });

  it('an open question three days old does not fund a new record', async () => {
    const w = await world();
    const first = await turn(w, "Elektrga 3 mln to'ladim", [call('draft_expense', { amount: 3_000_000, category: 'electricity' }), say("Qanday to'landi?")]);
    await w.f.run(() => tx().update(schema.aiMessages).set({ createdAt: new Date(Date.now() - 3 * 86_400_000) }).where(eq(schema.aiMessages.conversationId, conv(first))));
    const second = await turn(w, "Gazga ham to'ladim naqd", [call('draft_expense', { amount: 3_000_000, category: 'gas', paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    expect(cards(second)).toEqual([]);
    expect(questionOf(second)).toBe('AMOUNT_NOT_STATED');
  });

  it('a figure from a question the model merely answered does not fund a record', async () => {
    const w = await world();
    const first = await turn(w, 'Elektrga 3 mln ketdimi?', [say('Bu oy elektrga 2 mln ketgan. Yana nima kerak?')]);
    const second = await turn(w, "Gazga ham to'ladim naqd", [call('draft_expense', { amount: 3_000_000, category: 'gas', paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    expect(cards(second)).toEqual([]);
    expect(questionOf(second)).toBe('AMOUNT_NOT_STATED');
  });

  it('a sale is refused whichever tool the model reaches for', async () => {
    const w = await world();
    const res = await turn(w, "Qo'y sotdim, 20 mln naqd tushdi", [call('draft_expense', { amount: 20_000_000, category: 'transport', paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(cards(res)).toEqual([]);
  });

  it('a card is not cancelled by words that never asked for it', async () => {
    const w = await world();
    const first = await turn(w, 'Elektrga 3 mln naqd', [call('draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]);
    const [card] = cards(first);
    await turn(w, 'rahmat', [call('cancel_draft', { proposalId: card.id }), say('Arzimaydi.')], conv(first));
    expect((await w.owner.get(`/ai/proposals/${card.id}`)).data.status).toBe('pending');
  });
});

describe('a model that repeats itself', () => {
  it('the same draft repeated in one turn makes one card', async () => {
    const w = await world();
    const elec = { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' };
    const res = await turn(w, 'Elektrga 3 mln naqd', [call('draft_expense', elec), call('draft_expense', elec), call('draft_expense', elec), say('Tayyor.')]);
    expect(cards(res)).toHaveLength(1);
  });
});

describe('document amounts once the exchange is over', () => {
  it('a closed exchange leaves its document amounts behind', async () => {
    const w = await world();
    setProvider(new Scripted([read(1_500_000), call('draft_expense', { amount: 1_500_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]));
    const first = await chat(identity(w), { message: "Shu chek, elektr, naqd to'ladim", blocks: [photo], channel: 'telegram' });
    expect(first.message.asked).toEqual([]);
    setProvider(new Scripted([call('draft_expense', { amount: 1_500_000, category: 'gas', paymentMethod: 'cash' }), say('Tayyor.')]));
    const second = await chat(identity(w), { conversationId: first.conversationId, message: "Gazga ham naqd to'ladim", channel: 'telegram' });
    expect(second.message.asked).toEqual(['AMOUNT_NOT_STATED']);
  });

  it('a new record does not lean on the document of the one before it', async () => {
    const w = await world();
    setProvider(new Scripted([read(1_500_000), call('draft_expense', { category: 'electricity', paymentMethod: 'cash' }), say('Qancha?')]));
    const first = await chat(identity(w), { message: "Shu chek, elektr, naqd to'ladim", blocks: [photo], channel: 'telegram' });
    setProvider(new Scripted([call('draft_expense', { amount: 1_500_000, category: 'gas', paymentMethod: 'cash' }), say('Tayyor.')]));
    const second = await chat(identity(w), { conversationId: first.conversationId, message: "Gazga 300 ming naqd to'ladim", channel: 'telegram' });
    expect(second.message.asked).toContain('AMOUNT_NOT_STATED');
  });
});

describe('cancelling in words', () => {
  it('"bekor qil" cancels the card through cancel_draft', async () => {
    const w = await world();
    const first = await turn(w, 'Elektrga 3 mln naqd', [call('draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]);
    const [card] = cards(first);
    const second = await turn(w, 'bekor qil', [call('cancel_draft', { proposalId: card.id }), say('Bekor qilindi.')], conv(first));
    expect((await w.owner.get(`/ai/proposals/${card.id}`)).data.status).toBe('rejected');
  });
});

describe('a card built from a price survives its own re-check', () => {
  it('a card worked out from a price per tonne can be confirmed', async () => {
    const w = await world();
    await addItems(w, ['Arpa', 'feed']);
    const made = await turn(w, "20865 kg arpa, tonnasi 2835929 so'm, naqd oldim", [call('draft_stock_purchase', { item: 'Arpa', qty: 20865, unit: 'kg', unitPrice: 2835929, paymentMethod: 'cash' }), say('Tayyor.')]);
    const [card] = cards(made);
    expect(card.fields.amount).toBe(59171658.58);
    const res = await w.owner.post(`/ai/proposals/${card.id}/confirm`, { stamp: card.stamp });
    expect(res.status).toBe(200);
  });

  const perTonne: [string, string, number][] = [
    ['tonnasi ... so\'mdan, quantity in kg', "5000 kg arpa, tonnasi 2 mln so'mdan naqd oldim", 5000],
    ['tonnasi ... mlndan, quantity in kg', '5000 kg arpa, tonnasi 2 mlndan naqd oldim', 5000],
    ['тонна по ..., quantity in kg', '5000 кг ячменя, тонна по 2 млн, наличными купил', 5000],
    ['a tonne at ..., quantity in kg', '5000 kg of barley, a tonne at 2 million, paid cash', 5000],
  ];
  for (const [label, text, qty] of perTonne) {
    it(label, async () => {
      const w = await world();
      await addItems(w, ['Arpa', 'feed']);
      const res = await turn(w, text, [call('draft_stock_purchase', { item: 'Arpa', qty, unit: 'kg', unitPrice: 2_000_000, paymentMethod: 'cash' }), say('Tayyor.')]);
      const [card] = cards(res);
      if (card) expect(card.fields.amount).toBe(10_000_000);
      else expect(questionOf(res)).toBeDefined();
    });
  }

  it('"tonnasi 2 mln so\'mdan" says the price is per tonne, so it is not asked', async () => {
    const w = await world();
    await addItems(w, ['Arpa', 'feed']);
    const res = await turn(w, "2 tonna arpa, tonnasi 2 mln so'mdan naqd oldim", [call('draft_stock_purchase', { item: 'Arpa', qty: 2, unit: 't', unitPrice: 2_000_000, paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(questionOf(res)).toBeUndefined();
    expect(cards(res)[0].fields.amount).toBe(4_000_000);
  });

});

describe('money said once', () => {
  const internet = { amount: 500_000, category: 'communication', paymentMethod: 'cash' };
  const notary = { amount: 500_000, category: 'paperwork', paymentMethod: 'cash' };

  it.each([
    ['Заплатил по 500 тысяч наличными: за интернет и нотариусу'],
    ["Internet va notariusga 500 mingdan naqd to'ladim"],
    ['Paid 500 thousand each in cash for the internet and the notary'],
  ])('"%s" gives each that much', async (text) => {
    const w = await world();
    const res = await turn(w, text, [tools(['draft_expense', internet], ['draft_expense', notary]), say('Tayyor.')]);
    expect(cards(res).map((c) => c.fields.amount)).toEqual([500_000, 500_000]);
    expect(questionOf(res)).toBeUndefined();
  });

  it('that much each with nothing joined is still no total', async () => {
    const w = await world();
    const res = await turn(w, "Internetga 500 mingdan naqd to'ladim", [call('draft_expense', internet), say('Tayyor.')]);
    expect(cards(res)).toEqual([]);
    expect(questionOf(res)).toBe('AMOUNT_NOT_STATED');
  });

  it('the second record is asked about, and "har biriga" settles it', async () => {
    const w = await world();
    const elec = { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' };
    const gas = { ...elec, category: 'gas' };
    const first = await turn(w, "Elektr va gazga 3 mln naqd to'ladim", [tools(['draft_expense', elec], ['draft_expense', gas]), say('Bu qanday?')]);
    expect(cards(first)).toHaveLength(1);
    expect(questionOf(first)).toBe('AMOUNT_ALREADY_USED');
    const second = await turn(w, 'har biriga 3 mln', [call('draft_expense', gas), say('Tayyor.')], conv(first));
    expect(cards(second).map((c) => c.fields.category.name)).toEqual(['Gaz']);
  });

  it('said again in its own words, the same sum is new money', async () => {
    const w = await world();
    const elec = { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' };
    const first = await turn(w, "Elektrga 3 mln naqd, yemga ham to'ladim", [tools(['draft_expense', elec], ['draft_expense', { category: 'feed', paymentMethod: 'cash' }]), say('Yemga qancha?')]);
    const second = await turn(w, "Gazga 3 mln naqd to'ladim", [call('draft_expense', { ...elec, category: 'gas' }), say('Tayyor.')], conv(first));
    expect(cards(second).map((c) => c.fields.amount)).toEqual([3_000_000]);
  });
});

describe('an answer stays with its record', () => {
  it('a question about the category itself keeps the money when the answer names another', async () => {
    const w = await world();
    const first = await turn(w, 'Suvga 900 ming naqd', [call('draft_expense', { amount: 900_000, category: 'utility_water', paymentMethod: 'cash' }), say('Qaysi suv?')]);
    expect(questionOf(first)).toBe('CATEGORY_AMBIGUOUS');
    const second = await turn(w, 'Suv haqi', [call('draft_expense', { amount: 900_000, category: 'water', paymentMethod: 'cash' }), say('Qaysi dala?')], conv(first));
    expect(questionOf(second)).toBe('TARGET_REQUIRED');
  });

  it('goods moving to a stock purchase keep their words', async () => {
    const w = await world();
    const first = await turn(w, "Dizelga 3 mln naqd to'ladim", [call('draft_expense', { amount: 3_000_000, category: 'fuel', paymentMethod: 'cash' }), say('Omborgami?')]);
    expect(questionOf(first)).toBe('GOODS_STOCK_OR_DIRECT');
    const second = await turn(w, 'omborga, 200 litr', [call('draft_stock_purchase', { item: 'Dizel', qty: 200, unit: 'l', amount: 3_000_000, paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    expect(cards(second).map((c) => [c.kind, c.fields.amount])).toEqual([['stock_purchase', 3_000_000]]);
  });

  it('after a new record the old question has lapsed, and the new one goes on from its own words', async () => {
    const w = await world();
    await addAsset(w, 'MTZ-80 №2');
    const first = await turn(w, "Kecha MTZ ta'miriga 2 mln naqd to'ladim", [call('draft_expense', { amount: 2_000_000, category: 'repair', paymentMethod: 'cash', target: 'MTZ' }), say('Qaysi MTZ?')]);
    const second = await turn(w, "Gazga 500 ming to'ladim", [call('draft_expense', { amount: 500_000, category: 'gas' }), say("Qanday to'landi?")], conv(first));
    expect(questionOf(second)).toBe('PAYMENT_METHOD_REQUIRED');
    const third = await turn(w, 'bankdan', [call('draft_expense', { amount: 500_000, category: 'gas', paymentMethod: 'bank' }), say('Tayyor.')], conv(first));
    const [card] = cards(third);
    expect({ date: card.fields.date, method: card.fields.paymentMethod, warnings: codes(card) }).toEqual({ date: today, method: 'bank', warnings: ['TARGET_DEFAULTED'] });
  });
});

describe('a document beside money already on a card', () => {
  it('is no conflict with that money', async () => {
    const w = await world();
    const electricity = { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' };
    const feed = { category: 'mechanization_service', paymentMethod: 'cash' };
    const first = await turn(w, "Elektrga 3 mln naqd, haydashga ham to'ladim", [tools(['draft_expense', electricity], ['draft_expense', feed]), say('Haydashga qancha?')]);
    setProvider(new Scripted([read(1_500_000), call('draft_expense', { ...feed, amount: 1_500_000, target: 'Dala 1' }), say('Tayyor.')]));
    const second = await chat(identity(w), { conversationId: conv(first), message: 'Shu chek, 1-dala', blocks: [photo], channel: 'telegram' });
    expect(second.message.asked).not.toContain('AMOUNT_CONFLICT');
  });
});

describe('how long a question stays open', () => {
  const elec = { amount: 3_000_000, category: 'electricity' };
  const age = (w: World, conversationId: string, hours: number) =>
    w.f.run(() => tx().update(schema.aiMessages).set({ createdAt: new Date(Date.now() - hours * 3_600_000) }).where(eq(schema.aiMessages.conversationId, conversationId)));

  it('within half a day an answer is an answer', async () => {
    const w = await world();
    const first = await turn(w, "Elektrga 3 mln to'ladim", [call('draft_expense', elec), say("Qanday to'landi?")]);
    await age(w, conv(first), 11);
    const second = await turn(w, 'naqd', [call('draft_expense', { ...elec, paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    expect(cards(second).map((c) => c.fields.amount)).toEqual([3_000_000]);
  });

  it('past half a day it starts afresh', async () => {
    const w = await world();
    const first = await turn(w, "Elektrga 3 mln to'ladim", [call('draft_expense', elec), say("Qanday to'landi?")]);
    await age(w, conv(first), 13);
    const second = await turn(w, 'naqd', [call('draft_expense', { ...elec, paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    expect(questionOf(second)).toBe('AMOUNT_NOT_STATED');
  });

  async function saidYesterday(w: World, conversationId: string) {
    await w.f.run(async () => {
      const [said] = await tx().select().from(schema.aiMessages).where(and(eq(schema.aiMessages.conversationId, conversationId), eq(schema.aiMessages.role, 'user')));
      await tx().update(schema.aiMessages).set({ content: { ...(said.content as object), saidOn: daysAgo(1) } }).where(eq(schema.aiMessages.id, said.id));
    });
  }

  it('"bugun" keeps the day it was said when the answer comes after midnight', async () => {
    const w = await world();
    const first = await turn(w, "Bugun elektrga 3 mln to'ladim", [call('draft_expense', elec), say("Qanday to'landi?")]);
    await saidYesterday(w, conv(first));
    const second = await turn(w, 'naqd', [call('draft_expense', { ...elec, paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    expect(cards(second)[0].fields.date).toBe(daysAgo(1));
  });

  it('with no day in the words, it is the day the record was said', async () => {
    const w = await world();
    const first = await turn(w, "Elektrga 3 mln to'ladim", [call('draft_expense', elec), say("Qanday to'landi?")]);
    await saidYesterday(w, conv(first));
    const second = await turn(w, 'naqd', [call('draft_expense', { ...elec, date: today, paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    expect(cards(second)[0].fields.date).toBe(daysAgo(1));
  });
});

describe('left-out money reads the exchange, and no more than that', () => {
  const elec = { category: 'electricity', paymentMethod: 'cash' };

  it('a faithful correction leaves the figure it replaced behind', async () => {
    const w = await world();
    const first = await turn(w, "Elektrga 3 mln to'ladim", [call('draft_expense', { category: 'electricity', amount: 3_000_000 }), say("Qanday to'landi?")]);
    const second = await turn(w, '4 mln edi, naqd', [call('draft_expense', { ...elec, amount: 4_000_000 }), say('Tayyor.')], conv(first));
    expect(cards(second)[0].needsAcknowledgement).toBe(false);
  });

  it('money on another card of the exchange is accounted for', async () => {
    const w = await world();
    const repair = { amount: 500_000, category: 'repair', paymentMethod: 'cash' };
    const first = await turn(w, "Elektrga 3 mln, ta'mirga 500 ming naqd", [tools(['draft_expense', { ...elec, amount: 3_000_000 }], ['draft_expense', repair]), say('Nimani?')]);
    expect(questionOf(first)).toBe('TARGET_REQUIRED');
    expect(codes(cards(first)[0])).not.toContain('OTHER_AMOUNT');
    const second = await turn(w, 'MTZ', [call('draft_expense', { ...repair, target: 'MTZ' }), say('Tayyor.')], conv(first));
    expect(cards(second).map((c) => c.fields.amount)).toEqual([500_000]);
    expect(codes(cards(second)[0])).not.toContain('OTHER_AMOUNT');
  });

  it('the rate that was asked for is no left-out money', async () => {
    const w = await world();
    const repair = { amount: 200, currency: 'USD', category: 'repair', target: 'MTZ', paymentMethod: 'cash' };
    const first = await turn(w, "MTZ ta'miriga 200 dollar naqd to'ladim", [call('draft_expense', repair), say('Kurs qancha?')]);
    const second = await turn(w, '12700', [call('draft_expense', repair), say('Tayyor.')], conv(first));
    const [card] = cards(second);
    expect(card.fields.fxRate).toBe(12_700);
    expect(codes(card)).not.toContain('OTHER_AMOUNT');
  });

  it('a changed amount leaves the warnings about the old one behind', async () => {
    const w = await world();
    const first = await turn(w, 'Elektrga 5 mln berdim, 200 ming qaytdi, naqd', [call('draft_expense', { ...elec, amount: 5_000_000 }), say('Tayyor.')]);
    const [card] = cards(first);
    const edited = await w.owner.patch(`/ai/proposals/${card.id}`, { amount: 4_800_000 });
    expect(codes(edited.data)).not.toContain('OTHER_AMOUNT');
    expect(edited.data.needsAcknowledgement).toBe(false);
  });
});

describe('a correction waiting for an answer', () => {
  async function waiting(w: World) {
    const first = await turn(w, 'Elektrga 3 mln naqd', [call('draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]);
    const [card] = cards(first);
    await turn(w, "yo'q, boshqa summa edi", [call('update_draft', { proposalId: card.id, changes: { amount: 9_999_000 } }), say('Qancha?')], conv(first));
    return card;
  }

  it('keeps waiting through an unrelated edit, and cannot be confirmed', async () => {
    const w = await world();
    const card = await waiting(w);
    const edited = await w.owner.patch(`/ai/proposals/${card.id}`, { description: 'noyabr' });
    expect(edited.data.fields.amount).toBe(3_000_000);
    expect(edited.data.needsAnswer).toBe(true);
    const confirmed = await w.owner.post(`/ai/proposals/${card.id}/confirm`, { stamp: edited.data.stamp, acknowledged: true });
    expect(confirmed.body.error.code).toBe('PROPOSAL_NEEDS_ANSWER');
  });

  it('is settled by typing what it changed', async () => {
    const w = await world();
    const card = await waiting(w);
    const edited = await w.owner.patch(`/ai/proposals/${card.id}`, { amount: 3_500_000 });
    expect(edited.data).toMatchObject({ needsAnswer: false, fields: { amount: 3_500_000 } });
    expect((await w.owner.post(`/ai/proposals/${card.id}/confirm`, { stamp: edited.data.stamp, acknowledged: true })).status).toBe(200);
  });
});

describe('a price with no scale', () => {
  const line = { item: 'Dizel', qty: 500, unit: 'l', paymentMethod: 'cash' };
  const asked = (w: World) => turn(w, '500 litr dizel 15 dan naqd oldim', [call('draft_stock_purchase', { ...line, unitPrice: 15 }), say('15 ming yoki 15 so\'m?')]);

  it('offers both readings', async () => {
    const w = await world();
    const res = await asked(w);
    const { question } = res.data.message.attachments.find((a: any) => a.type === 'question');
    expect(question.options.map((o: any) => o.id)).toEqual(['15000', '15']);
  });

  it.each([['15 ming'], ['ming'], ['15 000 UZS']])('"%s" answers it, keeping what the price was for', async (reply) => {
    const w = await world();
    const first = await asked(w);
    const second = await turn(w, reply, [call('draft_stock_purchase', { ...line, unitPrice: 15_000 }), say('Tayyor.')], conv(first));
    expect(cards(second).map((c) => c.fields.amount)).toEqual([7_500_000]);
  });

  it("\"so'm\" stands by the small figure", async () => {
    const w = await world();
    await addItems(w, ['Mix', 'spare_part', 'pcs']);
    const first = await turn(w, '5000 ta mix 15 dan naqd oldim', [call('draft_stock_purchase', { item: 'Mix', qty: 5000, unitPrice: 15, paymentMethod: 'cash' }), say('15 ming yoki 15 so\'m?')]);
    expect(questionOf(first)).toBe('AMOUNT_UNCLEAR');
    const second = await turn(w, "so'm", [call('draft_stock_purchase', { item: 'Mix', qty: 5000, unitPrice: 15, paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    expect(cards(second).map((c) => c.fields.amount)).toEqual([75_000]);
  });

  it('a total that agrees settles it, however small the price', async () => {
    const w = await world();
    await addItems(w, ['Mix', 'spare_part', 'pcs']);
    const res = await turn(w, "5000 ta mix 15 dan, jami 75 ming naqd oldim", [call('draft_stock_purchase', { item: 'Mix', qty: 5000, amount: 75_000, unitPrice: 15, paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(cards(res).map((c) => c.fields.amount)).toEqual([75_000]);
  });

  it('a real small price stands', async () => {
    const w = await world();
    await addItems(w, ['Somon', 'feed']);
    const res = await turn(w, "2 tonna somon, kilosi 800 dan naqd oldim", [call('draft_stock_purchase', { item: 'Somon', qty: 2, unit: 't', unitPrice: 800, paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(cards(res).map((c) => c.fields.amount)).toEqual([1_600_000]);
  });

  it('what a bare price comes to counts as a bare amount', async () => {
    const w = await world();
    await addItems(w, ["Qo'chqor", 'feed', 'head']);
    const res = await turn(w, "3 bosh qo'chqor 500 dan naqd oldim", [call('draft_stock_purchase', { item: "Qo'chqor", qty: 3, unit: 'head', unitPrice: 500, paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(cards(res)).toEqual([]);
    expect(questionOf(res)).toBe('AMOUNT_UNCLEAR');
  });
});

describe('a newer quantity', () => {
  it('in another unit is still newer', async () => {
    const w = await world();
    await addItems(w, ['Arpa', 'feed']);
    const line = { item: 'Arpa', qty: 2, unit: 't', amount: 4_000_000 };
    const first = await turn(w, '2 tonna arpa 4 mln oldim', [call('draft_stock_purchase', line), say("Qanday to'landi?")]);
    const second = await turn(w, '2500 kg edi, naqd', [call('draft_stock_purchase', { ...line, paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    expect(cards(second)).toEqual([]);
    expect(questionOf(second)).toBe('QUANTITY_NOT_STATED');
  });

  it('that says the same again is no conflict', async () => {
    const w = await world();
    await addItems(w, ['Arpa', 'feed']);
    const line = { item: 'Arpa', qty: 2, unit: 't', amount: 4_000_000 };
    const first = await turn(w, '2 tonna arpa 4 mln oldim', [call('draft_stock_purchase', line), say("Qanday to'landi?")]);
    const second = await turn(w, '2000 kg edi, naqd', [call('draft_stock_purchase', { ...line, paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    expect(cards(second).map((c) => c.fields.qty)).toEqual([2000]);
  });
});

describe('the kind must not contradict the words', () => {
  const income = { amount: 3_000_000, category: 'subsidies', paymentMethod: 'cash' };

  it('the person who is asked can still settle it', async () => {
    const w = await world();
    const first = await turn(w, "Hokimiyat uchun 3 mln naqd to'ladim", [call('draft_income', income), say('Kirdimi?')]);
    expect(questionOf(first)).toBe('KIND_UNCLEAR');
    const second = await turn(w, 'kirim edi', [call('draft_income', income), say('Tayyor.')], conv(first));
    expect(cards(second).map((c) => c.kind)).toEqual(['income']);
  });

  it.each([
    ['Subsidiya 3 mln naqd tushdi'], ['Davlat 3 mln naqd subsidiya berdi'], ['Получили субсидию 3 млн наличными'], ['Received a 3 million subsidy in cash'],
  ])('income stands on "%s"', async (text) => {
    const w = await world();
    const res = await turn(w, text, [call('draft_income', income), say('Tayyor.')]);
    expect(cards(res).map((c) => c.kind)).toEqual(['income']);
  });

  it.each([
    ["Qo'y sotish uchun bozorga olib borishga 500 ming naqd to'ladim"], ['Pul tushdi, yuk uchun 500 ming naqd berdim'], ['Получили счёт, заплатили 500 тысяч наличными'],
  ])('an expense stands on "%s"', async (text) => {
    const w = await world();
    const res = await turn(w, text, [call('draft_expense', { amount: 500_000, category: 'transport', paymentMethod: 'cash' }), say('Tayyor.')]);
    expect(cards(res).map((c) => c.kind)).toEqual(['expense']);
  });

  it('a purchase on credit from someone already owed is still a purchase', async () => {
    const w = await world();
    await asOwner(w, () => postTransaction({ date: daysAgo(5), type: 'expense', amount: 4_000_000, categoryId: w.electricityCategory, paymentMethod: 'debt', counterpartyId: w.supplier, costCenterId: w.general }));
    const res = await turn(w, 'Neft Bazadan transport uchun 500 ming qarzga oldik', [call('draft_expense', { amount: 500_000, category: 'transport', paymentMethod: 'debt', counterparty: 'Neft Baza' }), say('Tayyor.')]);
    expect(cards(res).map((c) => c.kind)).toEqual(['expense']);
  });
});

describe('which way a transfer went', () => {
  it.each([
    ["Kassadan Agrobankka 2 mln o'tkazdim"], ['Перевёл из кассы в Агробанк 2 млн'], ['Moved 2 million from Kassa to Agrobank'], ["Bankka kassadan 2 mln o'tkazdim"],
  ])('"%s" follows the words', async (text) => {
    const w = await world();
    const res = await turn(w, text, [call('draft_transfer', { amount: 2_000_000, account: 'Kassa', toAccount: 'Agrobank' }), say('Tayyor.')]);
    expect(cards(res).map((c) => [c.fields.account.name, c.fields.toAccount.name])).toEqual([['Kassa', 'Agrobank']]);
  });

  it.each([
    ["Kassadan Agrobankka 2 mln o'tkazdim"], ['Перевёл из кассы в Агробанк 2 млн'], ['Moved 2 million from Kassa to Agrobank'],
  ])('"%s" swapped by the model is asked about', async (text) => {
    const w = await world();
    const res = await turn(w, text, [call('draft_transfer', { amount: 2_000_000, account: 'Agrobank', toAccount: 'Kassa' }), say('Tayyor.')]);
    expect(cards(res)).toEqual([]);
    expect(questionOf(res)).toBe('TRANSFER_SIDES');
  });
});

describe('someone who has lost finance.view', () => {
  async function demoted() {
    const w = await world();
    const accountant = await w.f.as('accountant');
    setProvider(new Scripted([call('draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash', counterparty: 'Neft Baza', description: 'Neft Bazaga 3 mln' }), say('Tasdiqlang.')]));
    const made = await accountant.post('/ai/chat', { message: "Neft Bazaga elektr uchun 3 mln naqd to'ladim" });
    setProvider(new Scripted([call('cash_position', {}), say('Kassada 99 mln bor.')]));
    await accountant.post('/ai/chat', { conversationId: made.data.conversationId, message: 'Kassada qancha bor?' });
    await w.f.run(() => tx().update(schema.roles).set({ permissions: ['ai.view'] }).where(eq(schema.roles.id, w.f.roleIds.accountant)));
    return { accountant, conversationId: made.data.conversationId as string };
  }

  it('sees a card with no money, note, payment or counterparty', async () => {
    const { accountant } = await demoted();
    const [view] = (await accountant.get('/ai/proposals')).data;
    expect(view).toMatchObject({ masked: true, sourceText: '', learning: [], warnings: [], willNeedApproval: false });
    expect(view.fields).toMatchObject({ amount: null, amountBase: null, paymentMethod: null, direction: null, description: null, counterparty: null, account: null });
  });

  it('reads the conversation without the figures, and keeps their own words', async () => {
    const { accountant, conversationId } = await demoted();
    const { messages } = (await accountant.get(`/ai/conversations/${conversationId}`)).data;
    const answers = JSON.stringify(messages.filter((m: any) => m.role === 'assistant'));
    for (const secret of ['3000000', 'Neft Baza', 'Kassada 99 mln', 'cash_position', 'toolCalls":[{']) expect(answers).not.toContain(secret);
    expect(messages.find((m: any) => m.role === 'user').text).toContain('3 mln');
    expect(messages.find((m: any) => m.attachments?.length).attachments[0].proposal.masked).toBe(true);
  });

  it('does not have the old answer put back in front of the model', async () => {
    const { accountant, conversationId } = await demoted();
    const provider = new Scripted([say('Bu sizning ruxsatingizdan tashqarida.')]);
    setProvider(provider);
    await accountant.post('/ai/chat', { conversationId, message: 'Kassada qancha edi?' });
    expect(JSON.stringify(provider.requests[0].messages)).not.toContain('Kassada 99 mln');
  });

  it('an answer that could have held money is hidden only if it did', async () => {
    const w = await world();
    const shepherd = await w.f.as('shepherd');
    await w.f.run(() => tx().update(schema.roles).set({ permissions: [...DEFAULT_ROLE_PERMISSIONS.shepherd, 'ai.view'] }).where(eq(schema.roles.id, w.f.roleIds.shepherd)));
    const asked = async (who: typeof shepherd) => {
      setProvider(new Scripted([call('farm_status', {}), say('Hammasi joyida, kassada 77 mln.')]));
      return (await who.post('/ai/chat', { message: 'Ahvol qanday?' })).data.conversationId as string;
    };
    const accountant = await w.f.as('accountant');
    const [theirs, accountants] = [await asked(shepherd), await asked(accountant)];
    await w.f.run(() => tx().update(schema.roles).set({ permissions: ['ai.view'] }).where(eq(schema.roles.id, w.f.roleIds.accountant)));
    expect((await shepherd.get(`/ai/conversations/${theirs}`)).data.messages[1].text).toContain('Hammasi joyida');
    expect((await accountant.get(`/ai/conversations/${accountants}`)).data.messages[1].text).not.toContain('77 mln');
  });

  it('someone who still sees money reads the conversation as it was', async () => {
    const w = await world();
    const first = await turn(w, 'Elektrga 3 mln naqd', [call('draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]);
    const { messages } = (await w.owner.get(`/ai/conversations/${conv(first)}`)).data;
    expect(messages[1].attachments[0].proposal.fields.amount).toBe(3_000_000);
  });
});

describe('the journal', () => {
  const events = (w: World, type: string) => asOwner(w, () => tx().select().from(schema.events).where(and(eq(schema.events.farmId, w.f.farmId), eq(schema.events.type, type))));
  const make = async (w: World) => {
    const first = await turn(w, 'Elektrga 3 mln naqd', [call('draft_expense', { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' }), say('Tayyor.')]);
    return { first, card: cards(first)[0] };
  };

  it('keeps a cancel in words, written as the person', async () => {
    const w = await world();
    const { first, card } = await make(w);
    const res = await turn(w, 'bekor qil', [call('cancel_draft', { proposalId: card.id }), say('Bekor qilindi.')], conv(first));
    expect(res.data.message.toolCalls[0].status).toBe('ok');
    expect(res.data.message.text).toBe('Bekor qilindi.');
    const [event] = await events(w, 'ai_proposal.rejected');
    expect({ id: event.entityId, by: (event.data as any).by, who: event.createdBy }).toEqual({ id: card.id, by: 'chat', who: w.owner.userId });
  });

  it('a card kept because no one said cancel is not reported as cancelled', async () => {
    const w = await world();
    const { first, card } = await make(w);
    const res = await turn(w, 'rahmat', [call('cancel_draft', { proposalId: card.id }), say('Bekor qilindi.')], conv(first));
    expect(res.data.message.text).not.toContain('Bekor qilindi');
    expect(await events(w, 'ai_proposal.rejected')).toEqual([]);
  });

  it('names what changed on a card, in chat or in the form, and no values', async () => {
    const w = await world();
    const { first, card } = await make(w);
    await turn(w, "2 mln 500 ming edi", [call('update_draft', { proposalId: card.id, changes: { amount: 2_500_000 } }), say('Tayyor.')], conv(first));
    await w.owner.patch(`/ai/proposals/${card.id}`, { description: 'noyabr' });
    const changes = await events(w, 'ai_proposal.changed');
    expect(changes.map((e) => e.data)).toEqual(expect.arrayContaining([{ kind: 'expense', changed: ['amount'], by: 'chat' }, { kind: 'expense', changed: ['description'], by: 'person' }]));
  });

  it('asking the server to look again changes nothing, so nothing is written', async () => {
    const w = await world();
    const { card } = await make(w);
    expect((await w.owner.patch(`/ai/proposals/${card.id}`, {})).status).toBe(200);
    expect(await events(w, 'ai_proposal.changed')).toEqual([]);
  });

  it('keeps a learned phrase being deleted', async () => {
    const w = await world();
    const [alias] = await w.f.run(() => tx().insert(schema.aiAliases).values({ tenantId: w.f.tenantId, farmId: w.f.farmId, phrase: 'akmal aka', targetType: 'counterparty', targetId: w.supplier }).returning());
    expect((await w.owner.delete(`/ai/aliases/${alias.id}`)).status).toBe(200);
    expect((await events(w, 'ai_alias.deleted')).map((e) => e.entityId)).toEqual([alias.id]);
  });
});

describe('a question about dollars', () => {
  const line = { item: 'Dizel', qty: 100, unit: 'litr', currency: 'USD', paymentMethod: 'cash' };
  const asked = async (w: World) => {
    await usdRate(w);
    return turn(w, '100 litr dizel 5 dollardan, jami 600 dollar naqd', [call('draft_stock_purchase', { ...line, amount: 600, unitPrice: 5 }), say("Qaysi biri to'g'ri?")]);
  };

  it('offers dollars, and no number the web would read as so\'m', async () => {
    const w = await world();
    const { question } = (await asked(w)).data.message.attachments.find((a: any) => a.type === 'question');
    expect(question.options).toEqual([{ id: '600 USD', label: '600 USD' }, { id: '500 USD', label: '500 USD' }]);
  });

  it('keeps dollars when the tapped words come back, whatever the model passes', async () => {
    const w = await world();
    const first = await asked(w);
    const second = await turn(w, '600 USD', [call('draft_stock_purchase', { item: 'Dizel', qty: 100, unit: 'litr', amount: 600, paymentMethod: 'cash' }), say('Tayyor.')], conv(first));
    expect(cards(second).map((c) => [c.fields.amount, c.fields.currency])).toEqual([[600, 'USD']]);
  });

  it('a question in so\'m keeps its plain numbers', async () => {
    const w = await world();
    const res = await turn(w, '100 litr dizel 5 mingdan, jami 600 ming naqd', [call('draft_stock_purchase', { item: 'Dizel', qty: 100, unit: 'litr', amount: 600_000, unitPrice: 5_000, paymentMethod: 'cash' }), say("Qaysi biri to'g'ri?")]);
    const { question } = res.data.message.attachments.find((a: any) => a.type === 'question');
    expect(question.options.map((o: any) => o.id)).toEqual(['600000', '500000']);
  });
});
