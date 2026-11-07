/**
 * What the assistant promises (docs/assistant.md): a record reaches the books only as the card a person
 * read, re-checked at that moment, and nothing on a card rests on the model's word alone.
 */
import { and, eq } from 'drizzle-orm';
import { DEFAULT_ROLE_PERMISSIONS } from '@yap/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { ensureCostCenter } from '../src/core/costCenters';
import { postTransaction, rejectTransaction, approveTransaction } from '../src/core/ledger';
import { setProvider } from '../src/modules/ai/provider';
import { readDocumentAmounts } from '../src/modules/ai/records/document';
import {
  confirmProposal, getProposal, listAliases, listPending, saveDraft, undoProposal, updateProposal,
} from '../src/modules/ai/records/service';
import type { ProposalView } from '../src/modules/ai/records/types';
import type { DraftInput } from '../src/modules/ai/records/validate';
import { voidTransaction } from '../src/modules/finance/transactions.service';
import { ELECTRICITY, Scripted, asOwner, asked, call, daysAgo, draft, electricity, ready, say, today, world, type World } from './ai-world';

const booked = (w: World) => asOwner(w, () => tx().select().from(schema.transactions).where(eq(schema.transactions.farmId, w.f.farmId)));
const confirm = (w: World, p: ProposalView, acknowledged?: boolean) => asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp, acknowledged }));
const refused = (work: Promise<unknown>, code: string) => expect(work).rejects.toMatchObject({ code });
const env = { documentAmounts: [], channel: 'web' as const, conversationId: null };

async function arpa(w: World, unit = 'kg') {
  await w.f.run(() => tx().insert(schema.items).values({ tenantId: w.f.tenantId, farmId: w.f.farmId, name: 'Arpa', category: 'feed', unit, defaultWarehouseId: w.store }));
}

async function usdRate(w: World, rate = 12_500) {
  await w.f.run(() => tx().insert(schema.fxRates).values({ tenantId: w.f.tenantId, date: daysAgo(1), currency: 'USD', rate }));
}

describe('confirm books the card that was read', () => {
  it('a stale card books nothing and hands back the card as it stands', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    await asOwner(w, () => updateProposal(p.id, { amount: 2_500_000 }));
    const error = await confirm(w, p).catch((e) => e);
    expect(error).toMatchObject({ code: 'PROPOSAL_CHANGED', details: { proposal: { fields: { amount: 2_500_000 } } } });
    expect(await booked(w)).toHaveLength(0);
  });

  it('an account closed while the card waited stops it, and nothing is booked', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    await w.f.run(() => tx().update(schema.accounts).set({ active: false }).where(eq(schema.accounts.id, w.cash)));
    await refused(confirm(w, p), 'PROPOSAL_STALE');
    expect(await booked(w)).toHaveLength(0);
  });

  it('a renamed account is still the same account', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    await w.f.run(() => tx().update(schema.accounts).set({ name: 'Bosh kassa' }).where(eq(schema.accounts.id, w.cash)));
    expect((await confirm(w, p)).status).toBe('confirmed');
  });

  it('nothing can change a confirmed card, so Undo always finds the money', async () => {
    const w = await world();
    const conversationId = await asOwner(w, async () => (await tx().insert(schema.aiConversations).values({ tenantId: w.f.tenantId, farmId: w.f.farmId, userId: w.owner.userId, title: 'x' }).returning())[0].id);
    const context = { ...env, userTexts: [ELECTRICITY], conversationId };
    const made = await asOwner(w, () => saveDraft('expense', electricity, context));
    const p = (made as { proposal: ProposalView }).proposal;
    await confirm(w, p);
    await refused(asOwner(w, () => saveDraft('expense', { paymentMethod: 'bank' }, { ...context, userTexts: ['bankdan edi'] }, p.id)), 'NOT_FOUND');
    await asOwner(w, () => undoProposal(p.id));
    expect((await booked(w)).map((t) => t.status)).toEqual(['rejected']);
  });

  it('a correction that needs an answer keeps the old value from being confirmed', async () => {
    const w = await world();
    const conversationId = await asOwner(w, async () => (await tx().insert(schema.aiConversations).values({ tenantId: w.f.tenantId, farmId: w.f.farmId, userId: w.owner.userId, title: 'x' }).returning())[0].id);
    const context = { ...env, userTexts: [ELECTRICITY], conversationId };
    const p = ((await asOwner(w, () => saveDraft('expense', electricity, context))) as { proposal: ProposalView }).proposal;

    const asked = await asOwner(w, () => saveDraft('expense', { amount: 9_999 }, { ...context, userTexts: ["yo'q, boshqa summa"] }, p.id));
    expect(asked.status).toBe('needs_info');
    const held = await asOwner(w, () => getProposal(p.id));
    expect(held).toMatchObject({ needsAnswer: true, fields: { amount: 3_000_000 } });
    await refused(confirm(w, held), 'PROPOSAL_NEEDS_ANSWER');

    const answered = await asOwner(w, () => saveDraft('expense', { amount: 3_200_000 }, { ...context, userTexts: ['3 mln 200 ming'] }, p.id));
    expect(answered).toMatchObject({ status: 'ready', proposal: { needsAnswer: false, fields: { amount: 3_200_000 } } });
  });

  it('a correction reaches only a card of its own conversation', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    const other = await asOwner(w, async () => (await tx().insert(schema.aiConversations).values({ tenantId: w.f.tenantId, farmId: w.f.farmId, userId: w.owner.userId, title: 'y' }).returning())[0].id);
    await refused(asOwner(w, () => saveDraft('expense', { amount: 1_000_000 }, { ...env, userTexts: ['1 mln'], conversationId: other }, p.id)), 'NOT_FOUND');
  });

  it('an expired card cannot be revived by a correction', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    await w.f.run(() => tx().update(schema.aiProposals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.aiProposals.id, p.id)));
    await refused(asOwner(w, () => saveDraft('expense', { amount: 1_000_000 }, { ...env, userTexts: ['1 mln'] }, p.id)), 'NOT_FOUND');
  });
});

describe('one thing never reaches the books twice without a yes', () => {
  it('sees what was entered by hand while the card waited', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    expect(p.needsAcknowledgement).toBe(false);
    await asOwner(w, () => postTransaction({ date: today, type: 'expense', amount: 3_000_000, categoryId: w.electricityCategory, paymentMethod: 'cash', accountId: w.cash, costCenterId: w.general }));

    // A warning that needs a yes is part of what the person read, so the card has to be read again.
    const error = await confirm(w, p).catch((e) => e);
    expect(error).toMatchObject({ code: 'PROPOSAL_CHANGED', details: { proposal: { needsAcknowledgement: true } } });
    await refused(confirm(w, p, true), 'PROPOSAL_CHANGED');
    const fresh = await asOwner(w, () => getProposal(p.id));
    expect(fresh.needsAcknowledgement).toBe(true);
    await refused(confirm(w, fresh), 'NOT_ACKNOWLEDGED');
    expect((await confirm(w, fresh, true)).status).toBe('confirmed');
  });

  it('the same bill on two open cards: the older goes through, the newer needs a yes', async () => {
    const w = await world();
    const first = await ready(w, 'expense', electricity, ELECTRICITY);
    const second = await ready(w, 'expense', electricity, ELECTRICITY);
    expect((await confirm(w, first)).status).toBe('confirmed');
    await refused(confirm(w, second), 'NOT_ACKNOWLEDGED');
    expect(await booked(w)).toHaveLength(1);
  });

  it('two presses on two cards for one bill at the same moment book it once', async () => {
    const w = await world();
    const first = await ready(w, 'expense', electricity, ELECTRICITY);
    const second = await ready(w, 'expense', electricity, ELECTRICITY);
    const results = await Promise.allSettled([confirm(w, first), confirm(w, second)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await booked(w)).toHaveLength(1);
  });

  it('every kind has a duplicate check', async () => {
    const w = await world();
    const stock: DraftInput = { item: 'Dizel', qty: 200, amount: 3_000_000, paymentMethod: 'cash' };
    await confirm(w, await ready(w, 'stock_purchase', stock, '200 litr dizel 3 mln naqd'));
    expect((await ready(w, 'stock_purchase', stock, '200 litr dizel 3 mln naqd')).needsAcknowledgement).toBe(true);

    const transfer: DraftInput = { amount: 2_000_000, account: 'Kassa', toAccount: 'Agrobank' };
    await confirm(w, await ready(w, 'transfer', transfer, "Kassadan Agrobankka 2 mln o'tkazdim"));
    expect((await ready(w, 'transfer', transfer, "Kassadan Agrobankka 2 mln o'tkazdim")).needsAcknowledgement).toBe(true);

    await asOwner(w, () => postTransaction({ date: daysAgo(9), type: 'expense', amount: 4_000_000, categoryId: w.electricityCategory, paymentMethod: 'debt', counterpartyId: w.supplier, costCenterId: w.general }));
    const debt: DraftInput = { amount: 1_000_000, direction: 'payable', counterparty: 'Neft Baza', paymentMethod: 'cash' };
    await confirm(w, await ready(w, 'debt_payment', debt, "Neft Bazaga 1 mln to'ladim naqd"));
    expect((await ready(w, 'debt_payment', debt, "Neft Bazaga 1 mln to'ladim naqd")).needsAcknowledgement).toBe(true);
  });

  it('two real records at one price stay two cards, and neither is called a duplicate', async () => {
    const w = await world();
    const input: DraftInput = { amount: 700_000, category: 'repair', paymentMethod: 'cash' };
    const text = "MTZ ta'miriga 700 ming, 1-dalaga 700 ming naqd";
    await ready(w, 'expense', { ...input, target: 'MTZ' }, text);
    await ready(w, 'expense', { ...input, target: 'Dala 1' }, text);
    const pending = await asOwner(w, listPending);
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.needsAcknowledgement)).toEqual([false, false]);
  });

  it('the model cannot wave a duplicate through', async () => {
    const w = await world();
    await confirm(w, await ready(w, 'expense', electricity, ELECTRICITY));
    const p = await ready(w, 'expense', { ...electricity, duplicateConfirmed: true } as DraftInput, ELECTRICITY);
    expect(p.needsAcknowledgement).toBe(true);
  });
});

describe('nothing rests on the model alone', () => {
  it('how it was paid must be in the words, and the words can fill it in', async () => {
    const w = await world();
    expect(await asked(w, 'expense', { ...electricity, paymentMethod: 'cash' }, "Elektrga 3 mln to'ladim")).toContain('PAYMENT_METHOD_REQUIRED');
    const { paymentMethod: _dropped, ...rest } = electricity;
    expect((await ready(w, 'expense', rest, 'Elektrga 3 mln xisobdan')).fields).toMatchObject({ paymentMethod: 'bank', account: { name: 'Agrobank' } });
    expect(await asked(w, 'expense', { ...rest, amount: 3_100_000 }, 'Elektrga 3 mln 100 ming Agrobank plastikdan')).toContain('ACCOUNT_REQUIRED');
    expect((await ready(w, 'expense', { ...rest, amount: 3_100_000, account: 'Agrobank' }, 'Elektrga 3 mln 100 ming Agrobank plastikdan')).fields).toMatchObject({ paymentMethod: 'card', account: { name: 'Agrobank' } });
  });

  it('dates come from the words', async () => {
    const w = await world();
    expect((await ready(w, 'expense', electricity, 'Kecha elektrga 3 mln naqd')).fields.date).toBe(daysAgo(1));
    expect(await asked(w, 'expense', electricity, "O'tgan hafta elektrga 3 mln naqd")).toContain('DATE_UNCLEAR');
    expect(await asked(w, 'expense', { ...electricity, date: daysAgo(2) }, ELECTRICITY)).toContain('DATE_UNCLEAR');
    expect(await asked(w, 'expense', { ...electricity, date: '2026-02-31' }, ELECTRICITY)).toContain('DATE_UNCLEAR');
  });

  it('a late message counts its days from when it was said', async () => {
    const w = await world();
    const saidOn = daysAgo(3);
    expect((await ready(w, 'expense', electricity, 'Kecha elektrga 3 mln naqd', { saidOn })).fields.date).toBe(daysAgo(4));
    expect((await ready(w, 'expense', { ...electricity, amount: 2_900_000 }, 'Elektrga 2 mln 900 ming naqd', { saidOn })).fields.date).toBe(saidOn);
  });

  it('a card keeps its date when edited the next morning', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, 'Kecha elektrga 3 mln naqd');
    const edited = await asOwner(w, () => updateProposal(p.id, { description: 'noyabr' }));
    expect(edited).toMatchObject({ fields: { date: daysAgo(1), description: 'noyabr' } });
  });

  it('a quantity must be in the words, and a unit said cannot be lost', async () => {
    const w = await world();
    await arpa(w);
    const input: DraftInput = { item: 'Arpa', amount: 4_000_000, paymentMethod: 'cash' };
    expect(await asked(w, 'stock_purchase', { ...input, qty: 300 }, 'Arpa 2 tonna 4 mln naqd')).toContain('QUANTITY_NOT_STATED');
    expect((await ready(w, 'stock_purchase', { ...input, qty: 2 }, 'Arpa 2 tonna 4 mln naqd')).fields.qty).toBe(2000);
    expect(await asked(w, 'stock_purchase', { ...input, qty: 50, unit: 'qop', amount: 2_000_000 }, '50 qop arpa 2 mln naqd')).toContain('UNIT_MISMATCH');
  });

  // Control numbers: 4 t at 2 000 000 a tonne is 8 000 000; 500 kg at 3 000 a kilo on an item kept in tonnes is 1 500 000.
  it('a price is multiplied in the unit it was said in', async () => {
    const w = await world();
    await arpa(w);
    const tonnes = await ready(w, 'stock_purchase', { item: 'Arpa', qty: 4, unit: 'tonna', unitPrice: 2_000_000, paymentMethod: 'cash' }, '4 tonna arpa, tonnasi 2 mln, naqd');
    expect(tonnes.fields).toMatchObject({ amount: 8_000_000, qty: 4000, unitPrice: 2000 });

    const other = await world();
    await arpa(other, 't');
    const kilos = await ready(other, 'stock_purchase', { item: 'Arpa', qty: 500, unit: 'kg', unitPrice: 3_000, paymentMethod: 'cash' }, '500 kg arpa, kilosi 3 ming, naqd');
    expect(kilos.fields).toMatchObject({ amount: 1_500_000, qty: 0.5 });
  });

  it('a unit price is not a total, and a total that disagrees with the price is asked about', async () => {
    const w = await world();
    await arpa(w);
    const words = '4 tonna arpa, tonnasi 2 mln, naqd';
    expect(await asked(w, 'expense', { amount: 2_000_000, category: 'meals', paymentMethod: 'cash' }, 'Tushlik boshiga 2 mln naqd')).toContain('AMOUNT_NOT_STATED');
    expect((await ready(w, 'stock_purchase', { item: 'Arpa', qty: 4, unit: 'tonna', amount: 2_000_000, paymentMethod: 'cash' }, words)).fields.amount).toBe(8_000_000);
    expect(await asked(w, 'stock_purchase', { item: 'Arpa', qty: 4, unit: 'tonna', amount: 9_000_000, unitPrice: 2_000_000, paymentMethod: 'cash' }, '4 tonna arpa, tonnasi 2 mln, jami 9 mln, naqd')).toContain('AMOUNT_AMBIGUOUS');
    expect(await asked(w, 'stock_purchase', { item: 'Arpa', qty: 2, unit: 'tonna', unitPrice: 3_000, paymentMethod: 'cash' }, '2 tonna arpa 3 mingdan naqd')).toContain('PRICE_UNIT_UNCLEAR');
  });

  it('a figure taken back cannot be used', async () => {
    const w = await world();
    expect(await asked(w, 'expense', electricity, 'Elektrga 3 mln emas, 4 mln naqd')).toContain('AMOUNT_NOT_STATED');
    expect((await ready(w, 'expense', { ...electricity, amount: 4_000_000 }, 'Elektrga 3 mln emas, 4 mln naqd')).fields.amount).toBe(4_000_000);
  });

  it('foreign money stays what it is, or is asked about', async () => {
    const w = await world();
    await usdRate(w);
    await asOwner(w, () => postTransaction({ date: daysAgo(5), type: 'expense', amount: 4_000_000, categoryId: w.electricityCategory, paymentMethod: 'debt', counterpartyId: w.supplier, costCenterId: w.general }));
    expect(await asked(w, 'debt_payment', { amount: 200, direction: 'payable', counterparty: 'Neft Baza', paymentMethod: 'cash' }, "Neft Bazaga 200 dollar to'ladim naqd")).toContain('CURRENCY_NOT_SUPPORTED');
    // Control number: 500 at 12 500 is 6 250 000. Not 500 so'm.
    const moved = await ready(w, 'transfer', { amount: 500, account: 'Kassa', toAccount: 'Agrobank' }, "Kassadan Agrobankka 500 dollar o'tkazdim");
    expect(moved.fields).toMatchObject({ currency: 'USD', amountBase: 6_250_000 });

    const stored = await ready(w, 'expense', { ...electricity, amount: 150, currency: 'USD', fxRate: 1 }, 'Elektrga $150 naqd');
    expect(stored.fields).toMatchObject({ currency: 'USD', fxRate: 12_500, amountBase: 1_875_000 });
    const stated = await ready(w, 'expense', { ...electricity, amount: 200, currency: 'USD', fxRate: 12_700 }, 'Elektrga 200 dollar naqd, kurs 12 700');
    expect(stated.fields).toMatchObject({ fxRate: 12_700, amountBase: 2_540_000 });
    const edited = await asOwner(w, () => updateProposal(stated.id, { description: 'noyabr' }));
    expect(edited).toMatchObject({ fields: { fxRate: 12_700, amountBase: 2_540_000 } });
  });

  it('a target, a supplier and an account the person never named are not taken from the model', async () => {
    const w = await world();
    const repair: DraftInput = { amount: 2_000_000, category: 'repair', paymentMethod: 'cash', target: 'MTZ' };
    expect(await asked(w, 'expense', repair, "Ta'mirga 2 mln naqd")).toContain('TARGET_REQUIRED');
    expect(await asked(w, 'expense', { ...repair, target: 'general' }, "Ta'mirga 2 mln naqd")).toContain('TARGET_REQUIRED');
    expect(await asked(w, 'expense', { ...electricity, paymentMethod: 'debt', counterparty: 'Neft Baza' }, 'Elektrga 3 mln qarzga')).toContain('COUNTERPARTY_REQUIRED');
  });

  it('who paid whom comes from the words', async () => {
    const w = await world();
    await asOwner(w, () => postTransaction({ date: daysAgo(5), type: 'expense', amount: 4_000_000, categoryId: w.electricityCategory, paymentMethod: 'debt', counterpartyId: w.supplier, costCenterId: w.general }));
    const input: DraftInput = { amount: 1_000_000, direction: 'payable', counterparty: 'Neft Baza', paymentMethod: 'cash' };
    expect(await asked(w, 'debt_payment', input, 'Neft Baza bilan 1 mln naqd hisob-kitob qildik')).toContain('DIRECTION_REQUIRED');
  });

  it("what is another module's is refused, whichever category was chosen", async () => {
    const w = await world();
    const expense = (text: string, category = 'other') => asked(w, 'expense', { amount: 2_500_000, category, paymentMethod: 'cash' }, text);
    expect(await expense('Zarplata 2.5 mln naqd', 'security_guard')).toContain('USE_OTHER_MODULE');
    expect(await expense('Agrobank kredit tolovi 2.5 mln naqd')).toContain('USE_OTHER_MODULE');
    expect(await expense("Qorovulga bu oy uchun 2.5 mln naqd berdim", 'security_guard')).toContain('WAGE_OR_SERVICE');
    expect(await asked(w, 'income', { amount: 40_000_000, category: 'other', paymentMethod: 'cash' }, "Qo'zilardan 40 mln naqd tushdi")).toContain('USE_OTHER_MODULE');
  });

  it('a question or a plan is not a record', async () => {
    const w = await world();
    expect(await asked(w, 'expense', electricity, "Elektrga 3 mln naqd ko'p emasmi?")).toContain('NOT_HAPPENED');
    expect(await asked(w, 'expense', electricity, "Ertaga elektrga 3 mln naqd to'lash kerak")).toContain('NOT_HAPPENED');
  });

  it('paying ahead does not settle an old debt', async () => {
    const w = await world();
    const input: DraftInput = { amount: 1_000_000, direction: 'payable', counterparty: 'Neft Baza', paymentMethod: 'bank' };
    expect(await asked(w, 'debt_payment', input, "Neft Bazaga oldindan 1 mln bankdan o'tkazdim")).toContain('USE_OTHER_MODULE');
  });

  it('a card payment goes through the bank account when there is no card account', async () => {
    const w = await world();
    const { paymentMethod: _dropped, ...rest } = electricity;
    expect(await asked(w, 'expense', rest, 'Elektrga 3 mln plastikdan')).toContain('ACCOUNT_REQUIRED');
    const p = await ready(w, 'expense', { ...rest, account: 'Agrobank' }, 'Elektrga 3 mln Agrobank kartasidan');
    expect(p.fields).toMatchObject({ paymentMethod: 'card', account: { name: 'Agrobank' } });
    await confirm(w, p);
    expect((await booked(w))[0]).toMatchObject({ paymentMethod: 'card', accountId: w.bank });
  });
});

describe('places and goods in the words people use', () => {
  const transport: DraftInput = { amount: 600_000, category: 'transport', paymentMethod: 'cash' };

  it('a field said as a word is that field', async () => {
    const w = await world();
    const said = async (text: string, target: string) => (await ready(w, 'expense', { ...transport, target }, text)).fields.target;
    expect(await said('Yuk tashish 600 ming naqd, birinchi dalaga', 'Dala 1')).toMatchObject({ costCenterId: w.fieldCenter, defaulted: false });
    expect(await said('За перевозку 600 тысяч наличкой, на первое поле', 'Dala 1')).toMatchObject({ costCenterId: w.fieldCenter, defaulted: false });
    expect(await said('600 thousand cash for transport to the first field', 'Dala 1')).toMatchObject({ costCenterId: w.fieldCenter, defaulted: false });
  });

  it('a place they named never quietly stays on General', async () => {
    const w = await world();
    expect(await asked(w, 'expense', { ...transport, target: 'Dala 1' }, 'За перевозку 600 тысяч наличкой, на седьмое поле')).toContain('TARGET_REQUIRED');
  });

  it('a place only the model mentioned is dropped, and the card says General is a default', async () => {
    const w = await world();
    const p = await ready(w, 'expense', { ...transport, target: 'Dala 1' }, "Yo'l kira 600 ming naqd");
    expect(p.fields.target).toMatchObject({ costCenterId: w.general, defaulted: true });
  });

  it('the only herd is the only answer, marked as such, unless the words name another', async () => {
    const w = await world();
    const shearing: DraftInput = { amount: 450_000, category: 'shearing', paymentMethod: 'cash', target: "Bo'g'oz sovliqlar" };
    const p = await ready(w, 'expense', shearing, 'Shearing the ewes 450 thousand cash');
    expect(p.fields.target).toMatchObject({ costCenterId: w.herdCenter, defaulted: true });
    const named = await ready(w, 'expense', { ...shearing, amount: 460_000 }, "Bo'g'oz sovliqlarni qirqish 460 ming naqd");
    expect(named.fields.target).toMatchObject({ costCenterId: w.herdCenter, defaulted: false });
  });

  it('a machine answers to its kind, while only one of that kind exists', async () => {
    const w = await world();
    const repair: DraftInput = { amount: 900_000, category: 'repair', paymentMethod: 'cash', target: 'MTZ-82 №1' };
    expect((await ready(w, 'expense', repair, 'Paid 900 thousand cash for the tractor repair')).fields.target?.costCenterId).toBe(w.assetCenter);
    await w.f.run(async () => {
      const base = { tenantId: w.f.tenantId, farmId: w.f.farmId };
      const [other] = await tx().insert(schema.assets).values({ ...base, name: 'TTZ-80 №2', type: 'tractor' }).returning();
      await ensureCostCenter('asset', other.id, other.name);
    });
    expect(await asked(w, 'expense', { ...repair, amount: 910_000 }, 'Paid 910 thousand cash for the tractor repair')).toContain('TARGET_AMBIGUOUS');
  });

  it('goods answer to the words people use, in each language', async () => {
    const w = await world();
    await arpa(w);
    const words: [string, string, string][] = [
      ['Dizel', '200 litr salyarka 3 mln naqd', 'Dizel'],
      ['Dizel', '200 литров солярки за 3 млн наличными', 'Dizel'],
      ['Dizel', "200 litr yoqilg'i 3 mln naqd", 'Dizel'],
      ['Dizel', '200 litres of diesel for 3 million cash', 'Dizel'],
    ];
    for (const [item, text, name] of words) {
      const p = await ready(w, 'stock_purchase', { item, qty: 200, unit: 'l', amount: 3_000_000, paymentMethod: 'cash' }, text);
      expect(p.fields.item?.name).toBe(name);
    }
    const barley = await ready(w, 'stock_purchase', { item: 'Arpa', qty: 2, unit: 't', amount: 4_000_000, paymentMethod: 'cash' }, '2 тонны ячменя за 4 млн наличными');
    expect(barley.fields).toMatchObject({ item: { name: 'Arpa' }, qty: 2000 });
  });

  it('wheat with a feed and a seed on the shelf is a question, with those two as the choice', async () => {
    const w = await world();
    await w.f.run(() => tx().insert(schema.items).values([
      { tenantId: w.f.tenantId, farmId: w.f.farmId, name: "Bug'doy (yem)", category: 'feed', unit: 'kg', defaultWarehouseId: w.store },
      { tenantId: w.f.tenantId, farmId: w.f.farmId, name: "Bug'doy urug'i", category: 'seed', unit: 'kg', defaultWarehouseId: w.store },
    ]));
    const input: DraftInput = { item: "Bug'doy (yem)", qty: 2, unit: 't', amount: 8_000_000, paymentMethod: 'cash' };
    const result = await draft(w, 'stock_purchase', input, 'bugdoy oldik 2 tonna 8 mln naqd');
    expect(result).toMatchObject({ status: 'needs_info' });
    const [question] = (result as { questions: { code: string; options: { label: string }[] }[] }).questions;
    expect(question.code).toBe('ITEM_AMBIGUOUS');
    expect(question.options.map((o) => o.label).sort()).toEqual(["Bug'doy (yem)", "Bug'doy urug'i"]);
    const seed = await ready(w, 'stock_purchase', { ...input, item: "Bug'doy urug'i" }, "bugdoy urugi 2 tonna 8 mln naqd");
    expect(seed.fields.item?.name).toBe("Bug'doy urug'i");
  });

  it("goods nobody named are not taken from the model", async () => {
    const w = await world();
    expect(await asked(w, 'stock_purchase', { item: 'Dizel', qty: 200, unit: 'l', amount: 3_000_000, paymentMethod: 'cash' }, '200 litr 3 mln naqd')).toContain('ITEM_REQUIRED');
  });

  it('dollars from a so\'m account need a yes, at the so\'m value', async () => {
    const w = await world();
    await usdRate(w);
    const p = await ready(w, 'expense', { ...electricity, amount: 300, currency: 'USD' }, 'Elektrga 300 dollar naqd');
    expect(p).toMatchObject({ needsAcknowledgement: true, fields: { currency: 'USD', amountBase: 3_750_000, account: { name: 'Kassa' } } });
    expect(p.warnings.map((x) => x.code)).toContain('CURRENCY_CONVERTED');
    await refused(confirm(w, p), 'NOT_ACKNOWLEDGED');
    expect((await confirm(w, p, true)).status).toBe('confirmed');
  });
});

describe('a document cannot overrule the words', () => {
  const read = (amount: number, currency: string | null = 'UZS') => ({ documentAmounts: [{ amount, currency }] });

  it('their words win a disagreement, as a question', async () => {
    const w = await world();
    const input = { ...electricity, amount: 5_000_000 };
    expect(await asked(w, 'expense', input, "Elektrga 500 ming naqd to'ladim", read(5_000_000) as never)).toContain('AMOUNT_CONFLICT');
  });

  it('with no words, a read amount needs a yes', async () => {
    const w = await world();
    const p = await ready(w, 'expense', { ...electricity, amount: 5_000_000 }, 'Elektr cheki naqd', read(5_000_000) as never);
    expect(p).toMatchObject({ needsAcknowledgement: true, warnings: expect.arrayContaining([expect.objectContaining({ code: 'AMOUNT_FROM_DOCUMENT' })]) });
    await refused(confirm(w, p), 'NOT_ACKNOWLEDGED');
    expect((await confirm(w, p, true)).status).toBe('confirmed');
  });

  it('a figure neither said nor read is refused, whatever is attached', async () => {
    const w = await world();
    expect(await asked(w, 'expense', { ...electricity, amount: 9_999_999 }, 'Mana chek naqd', read(5_000_000) as never)).toContain('AMOUNT_NOT_STATED');
  });

  it('a currency comes from what was read, not from the model', async () => {
    const w = await world();
    await usdRate(w);
    expect(await asked(w, 'expense', { ...electricity, amount: 500_000, currency: 'USD' }, 'Elektrga 500 ming naqd')).toContain('CURRENCY_UNCLEAR');
  });

  it('a separate step reads the document, and an unreadable reply means nothing was read', async () => {
    setProvider(new Scripted([say('Chek: [{"amount":150000,"currency":"UZS"},{"amount":3000,"currency":"EURO"}]')]));
    expect(await readDocumentAmounts([])).toEqual([{ amount: 150_000, currency: 'UZS' }, { amount: 3_000, currency: null }]);
    setProvider(new Scripted([say('I cannot read this.')]));
    expect(await readDocumentAmounts([])).toEqual([]);
    setProvider(undefined);
  });
});

describe('who sees and does what', () => {
  it('money needs finance.view: a reduced role sees no figures and cannot act', async () => {
    const w = await world();
    const accountant = await w.f.as('accountant');
    const made = await w.f.run(
      () => saveDraft('expense', { ...electricity, amount: 150_000_000 }, { ...env, userTexts: ['Elektrga 150 mln naqd'] }),
      { userId: accountant.userId, permissions: [...DEFAULT_ROLE_PERMISSIONS.accountant] },
    );
    const p = (made as { proposal: ProposalView }).proposal;
    expect(p.warnings.find((x) => x.code === 'OVER_BALANCE')?.params).toMatchObject({ balance: 100_000_000 });
    await w.f.run(() => tx().update(schema.roles).set({ permissions: ['ai.view'] }).where(eq(schema.roles.id, w.f.roleIds.accountant)));

    const [view] = (await accountant.get('/ai/proposals')).data;
    expect(view).toMatchObject({ masked: true, warnings: [], sourceText: '', fields: { amount: null, amountBase: null, account: null } });
    expect(JSON.stringify(view)).not.toContain('100000000');
    expect((await accountant.post(`/ai/proposals/${p.id}/confirm`, { stamp: p.stamp })).status).toBe(403);
    expect((await accountant.patch(`/ai/proposals/${p.id}`, { amount: 900_000_000 })).status).toBe(403);
  });

  it('a module switched off offers no money tools and writes nothing', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    await w.f.run(() => tx().update(schema.tenants).set({ modules: ['ai', 'dashboard'] }).where(eq(schema.tenants.id, w.f.tenantId)));
    expect((await w.owner.post(`/ai/proposals/${p.id}/confirm`, { stamp: p.stamp })).body.error.code).toBe('MODULE_DISABLED');
    const provider = new Scripted([say('Salom')]);
    setProvider(provider);
    await w.owner.post('/ai/chat', { message: 'Salom' });
    expect((provider.requests[0].tools ?? []).map((t) => t.name)).not.toContain('draft_expense');
    setProvider(undefined);
  });

  it('a draft of another farm is not listed here', async () => {
    const w = await world();
    const [other] = await w.f.run(() => tx().insert(schema.farms).values({ tenantId: w.f.tenantId, name: 'Ikkinchi', code: 'second' } as never).returning());
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    await w.f.run(() => tx().update(schema.aiProposals).set({ farmId: other.id }).where(eq(schema.aiProposals.id, p.id)));
    expect(await asOwner(w, listPending)).toEqual([]);
    await refused(asOwner(w, () => getProposal(p.id)), 'NOT_FOUND');
  });

  it('a request key answers only for its own request and its own person', async () => {
    const w = await world();
    const first = await ready(w, 'expense', electricity, ELECTRICITY);
    const second = await ready(w, 'expense', { ...electricity, amount: 2_000_000 }, 'Elektrga 2 mln naqd');
    const headers = { 'idempotency-key': 'one-key' };
    expect((await w.owner.post(`/ai/proposals/${first.id}/confirm`, { stamp: first.stamp }, headers)).status).toBe(200);
    expect((await w.owner.post(`/ai/proposals/${first.id}/confirm`, { stamp: first.stamp }, headers)).status).toBe(200);
    const reused = await w.owner.post(`/ai/proposals/${second.id}/confirm`, { stamp: second.stamp }, headers);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('a card follows the books', () => {
  it('shows what a second person decided', async () => {
    const w = await world();
    const director = await w.f.as('director');
    const p = await ready(w, 'expense', { ...electricity, amount: 9_000_000 }, 'Elektrga 9 mln naqd');
    const done = await confirm(w, p);
    expect(done.result?.status).toBe('pending');
    await w.f.run(() => approveTransaction(done.result!.id), { userId: director.userId });
    expect((await asOwner(w, () => getProposal(p.id))).result?.status).toBe('approved');

    const q = await ready(w, 'expense', { ...electricity, amount: 8_000_000 }, 'Elektrga 8 mln naqd');
    const second = await confirm(w, q);
    await w.f.run(() => rejectTransaction(second.result!.id, 'xato'), { userId: director.userId });
    expect((await asOwner(w, () => getProposal(q.id))).result?.status).toBe('rejected');
  });

  it('Undo leaves a record finance already voided as finance left it', async () => {
    const w = await world();
    const p = await ready(w, 'stock_purchase', { item: 'Dizel', qty: 100, amount: 1_500_000, paymentMethod: 'cash' }, '100 litr dizel 1,5 mln naqd');
    const done = await confirm(w, p);
    await w.f.run(() => voidTransaction(done.result!.id, 'Xato kiritilgan'), { userId: (await w.f.as('director')).userId });
    expect((await asOwner(w, () => undoProposal(p.id))).status).toBe('undone');
    const [row] = await booked(w);
    expect(row).toMatchObject({ status: 'rejected' });
  });

  it('a receipt with no money link cannot quietly report undone', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    await confirm(w, p);
    const [row] = await w.f.run(() => tx().select().from(schema.aiProposals).where(eq(schema.aiProposals.id, p.id)));
    const { _transactionIds, ...fields } = row.fields as Record<string, unknown>;
    await w.f.run(() => tx().update(schema.aiProposals).set({ fields }).where(eq(schema.aiProposals.id, p.id)));
    await refused(asOwner(w, () => undoProposal(p.id)), 'UNDO_IMPOSSIBLE');
  });

  it('money the assistant records points back to its card', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    await confirm(w, p);
    expect((await booked(w))[0]).toMatchObject({ sourceType: 'ai_proposal', sourceId: p.id });
  });

  it('Undo forgets what that record taught', async () => {
    const w = await world();
    const p = await ready(
      w, 'stock_purchase',
      { item: 'Dizel', qty: 200, amount: 3_000_000, paymentMethod: 'cash', heardAs: { item: 'gazoyl' } },
      '200 litr gazoyl 3 mln naqd', { answering: ['ITEM_UNKNOWN'], userTexts: ['200 litr gazoyl 3 mln naqd', 'Dizel'] },
    );
    await confirm(w, p);
    expect(await asOwner(w, listAliases)).toHaveLength(1);
    await asOwner(w, () => undoProposal(p.id));
    expect(await asOwner(w, listAliases)).toEqual([]);
  });

  it('a phrase the model says was heard, but nobody said, teaches nothing', async () => {
    const w = await world();
    const p = await ready(w, 'expense', { ...electricity, account: 'Agrobank', paymentMethod: 'bank', heardAs: { account: 'Kassa' } }, 'Elektrga 3 mln Agrobankdan', { answering: ['ACCOUNT_UNKNOWN'] });
    expect(p.learning).toEqual([]);
  });

  it('a word taught earlier is marked on the card', async () => {
    const w = await world();
    await w.f.run(() => tx().insert(schema.aiAliases).values({ tenantId: w.f.tenantId, farmId: w.f.farmId, phrase: 'gazoyl', targetType: 'item', targetId: w.diesel }));
    const p = await ready(w, 'stock_purchase', { item: 'gazoyl', qty: 200, amount: 3_000_000, paymentMethod: 'cash' }, '200 litr gazoyl 3 mln naqd');
    expect(p.warnings.map((x) => x.code)).toContain('PHRASE_USED');
  });
});

describe('what the assistant says', () => {
  afterEach(() => setProvider(undefined));
  const cards = (res: { data: { message: { attachments: { type: string; proposal?: ProposalView; question?: { code: string } }[] } } }) =>
    res.data.message.attachments.filter((a) => a.type === 'proposal').map((a) => a.proposal!);
  const questionOf = (res: { data: { message: { attachments: { type: string; question?: { code: string } }[] } } }) =>
    res.data.message.attachments.find((a) => a.type === 'question')?.question?.code;

  it('beside a card the sentence is written by code, so the model cannot claim anything', async () => {
    const w = await world();
    setProvider(new Scripted([call('draft_expense', electricity), say("Saqlandi! 5 mln kassadan yozib qo'ydim.")]));
    const res = await w.owner.post('/ai/chat', { message: ELECTRICITY });
    expect(res.data.message.text).toBe('Kartani tekshirib, tasdiqlang.');
    expect(cards(res)).toHaveLength(1);
    expect(await booked(w)).toHaveLength(0);
  });

  it('a claim of saving with no card is replaced', async () => {
    const w = await world();
    setProvider(new Scripted([say("Yozib qo'ydim, 3 mln kiritildi.")]));
    const res = await w.owner.post('/ai/chat', { message: ELECTRICITY });
    expect(res.data.message.text).toContain('Hech narsa yozilmadi');
  });

  it('a card already made survives the model failing afterwards', async () => {
    const w = await world();
    setProvider(new Scripted([call('draft_expense', electricity)]));
    const res = await w.owner.post('/ai/chat', { message: ELECTRICITY });
    expect(res.status).toBe(200);
    expect(cards(res)).toHaveLength(1);
    expect(res.data.message.text).toBe('Kartani tekshirib, tasdiqlang.');
  });

  it('a failure before anything was made is still an error', async () => {
    const w = await world();
    setProvider(new Scripted([]));
    expect((await w.owner.post('/ai/chat', { message: 'Salom' })).status).toBeGreaterThanOrEqual(500);
  });

  it('money no card accounts for needs a yes', async () => {
    const w = await world();
    const message = 'Elektrga 5 mln berdim, 200 ming qaytdi, naqd';
    setProvider(new Scripted([call('draft_expense', { ...electricity, amount: 5_000_000 }), say('Tayyor.')]));
    const res = await w.owner.post('/ai/chat', { message });
    const [card] = cards(res);
    expect(card.needsAcknowledgement).toBe(true);
    expect(card.warnings.map((x) => x.code)).toContain('OTHER_AMOUNT');
  });

  it('an amount of a finished record cannot fund a new one', async () => {
    const w = await world();
    setProvider(new Scripted([call('draft_expense', electricity), say('Tayyor.'), call('draft_expense', { amount: 3_000_000, category: 'gas', paymentMethod: 'cash' }), say('Qancha edi?')]));
    const first = await w.owner.post('/ai/chat', { message: ELECTRICITY });
    const second = await w.owner.post('/ai/chat', { conversationId: first.data.conversationId, message: "Gazga ham to'ladim naqd" });
    expect(cards(second)).toEqual([]);
    expect(questionOf(second)).toBe('AMOUNT_NOT_STATED');
  });

  it('an amount stays usable while the assistant is still asking about it', async () => {
    const w = await world();
    const { paymentMethod: _dropped, ...rest } = electricity;
    setProvider(new Scripted([call('draft_expense', rest), say('Qanday to\'landi?'), call('draft_expense', electricity), say('Tayyor.')]));
    const first = await w.owner.post('/ai/chat', { message: "Elektrga 3 mln to'ladim" });
    expect(questionOf(first)).toBe('PAYMENT_METHOD_REQUIRED');
    const second = await w.owner.post('/ai/chat', { conversationId: first.data.conversationId, message: 'naqd' });
    expect(cards(second)).toHaveLength(1);
  });

  it('a question always reaches the person, even when another record in the turn is ready', async () => {
    const w = await world();
    const message = "3 mln yoqilg'i, 500 ming tushlik naqd";
    setProvider(new Scripted([
      call('draft_expense', { amount: 3_000_000, category: 'fuel', paymentMethod: 'cash' }),
      call('draft_expense', { amount: 500_000, category: 'meals', paymentMethod: 'cash' }),
      say('Tasdiqlang.'),
    ]));
    const res = await w.owner.post('/ai/chat', { message });
    expect(cards(res)).toHaveLength(1);
    expect(questionOf(res)).toBe('GOODS_STOCK_OR_DIRECT');
  });

  it('a question with no options still leaves a trace, and a false claim beside it is dropped', async () => {
    const w = await world();
    setProvider(new Scripted([call('draft_expense', { category: 'electricity', paymentMethod: 'cash' }), say('Tayyor, saqlandi.')]));
    const res = await w.owner.post('/ai/chat', { message: 'Elektrga pul berdim naqd' });
    expect(questionOf(res)).toBe('AMOUNT_REQUIRED');
    expect(res.data.message.text).toBe('Summa qancha edi?');
  });

  it('a false sentence beside a question gives way to the exact question, and a real figure does not', async () => {
    const w = await world();
    await usdRate(w);
    const debt = { amount: 200, direction: 'payable', counterparty: 'Neft Baza', paymentMethod: 'cash', currency: 'USD' };
    await asOwner(w, () => postTransaction({ date: daysAgo(5), type: 'expense', amount: 4_000_000, categoryId: w.electricityCategory, paymentMethod: 'debt', counterpartyId: w.supplier, costCenterId: w.general }));
    setProvider(new Scripted([call('draft_debt_payment', debt), say("Saqlandi, yozib qo'ydim.")]));
    const res = await w.owner.post('/ai/chat', { message: "Neft Bazaga 200 dollar to'ladim naqd" });
    expect(res.data.message.text).not.toContain('Saqlandi');
    expect(res.data.message.text).not.toBe('Bu yozuvni tayyorlash uchun yana bir oz ma\'lumot kerak. Batafsilroq ayting, iltimos.');

    const over = { amount: 5_000_000, direction: 'payable', counterparty: 'Neft Baza', paymentMethod: 'cash' };
    setProvider(new Scripted([call('draft_debt_payment', over), say("Faqat 4 000 000 so'm ochiq. Qolgani nima uchun?")]));
    const figure = await w.owner.post('/ai/chat', { message: "Neft Bazaga 5 mln to'ladim naqd" });
    expect(figure.data.message.text).toContain('4 000 000');
  });

  it('a correction goes through update_draft, and a dropped change is an error, not a success', async () => {
    const w = await world();
    setProvider(new Scripted([call('draft_transfer', { amount: 2_000_000, account: 'Kassa', toAccount: 'Agrobank' }), say('Tayyor.')]));
    const first = await w.owner.post('/ai/chat', { message: "Kassadan Agrobankka 2 mln o'tkazdim" });
    const [card] = cards(first);
    setProvider(new Scripted([call('update_draft', { proposalId: card.id, changes: {} }), say('Nimani?')]));
    const res = await w.owner.post('/ai/chat', { conversationId: first.data.conversationId, message: "yo'q" });
    expect(res.data.message.toolCalls[0].status).toBe('invalid');
  });

  it('one card appears once, as it stands, and a cancelled one not at all', async () => {
    const w = await world();
    setProvider(new Scripted([call('draft_expense', electricity), say('Tayyor.')]));
    const first = await w.owner.post('/ai/chat', { message: ELECTRICITY });
    const [card] = cards(first);
    setProvider(new Scripted([
      call('update_draft', { proposalId: card.id, changes: { amount: 4_000_000 } }),
      call('update_draft', { proposalId: card.id, changes: { amount: 3_500_000 } }),
      say('Tayyor.'),
    ]));
    const res = await w.owner.post('/ai/chat', { conversationId: first.data.conversationId, message: "yo'q, 3 mln 500 ming, 4 mln ham emas... 4 mln edi" });
    expect(cards(res).length).toBeLessThanOrEqual(1);
  });

  it('answers in the language of the message', async () => {
    const w = await world();
    setProvider(new Scripted([call('draft_expense', { ...electricity, paymentMethod: 'cash' }), say('Tayyor.')]));
    const ru = await w.owner.post('/ai/chat', { message: 'За свет 3 млн наличными заплатил' });
    expect(ru.data.message.text).toBe('Проверьте карточку и подтвердите.');
  });
});

describe('goods with a feed and a seed of one grain', () => {
  async function shelves(w: World) {
    const base = { tenantId: w.f.tenantId, farmId: w.f.farmId, unit: 'kg', defaultWarehouseId: w.store };
    await w.f.run(() => tx().insert(schema.items).values([
      { ...base, name: 'Arpa', category: 'feed' },
      { ...base, name: "Arpa urug'i", category: 'seed' },
      { ...base, name: "Bug'doy (yem)", category: 'feed' },
      { ...base, name: "Bug'doy urug'i", category: 'seed' },
      { ...base, name: 'Kepak', category: 'feed' },
    ]));
  }
  const buying = (item: string): DraftInput => ({ item, qty: 2, unit: 't', amount: 4_000_000, paymentMethod: 'cash' });

  it('the plain name and its translations are the plain item', async () => {
    const w = await world();
    await shelves(w);
    for (const text of ['Arpa 2 tonna 4 mln naqd', '2 тонны ячменя за 4 млн наличными', 'взяли ячмень на корм 2 тонны за 4 млн наличкой', '2 tonnes of barley for 4 million cash']) {
      expect((await ready(w, 'stock_purchase', buying('Arpa'), text)).fields.item?.name).toBe('Arpa');
    }
  });

  it('the seed is named as a seed', async () => {
    const w = await world();
    await shelves(w);
    for (const text of ["2 tonna arpa urug'i 4 mln naqd", '2 тонны семян ячменя за 4 млн наличными', '2 tonnes of barley seed for 4 million cash']) {
      expect((await ready(w, 'stock_purchase', buying("Arpa urug'i"), text)).fields.item?.name).toBe("Arpa urug'i");
    }
  });

  it('with no plain item the word is a question, and a word of the answer settles it', async () => {
    const w = await world();
    await shelves(w);
    const said = '2 tonna bugdoy 4 mln naqd';
    expect(await asked(w, 'stock_purchase', buying("Bug'doy (yem)"), said)).toContain('ITEM_AMBIGUOUS');
    const p = await ready(w, 'stock_purchase', buying("Bug'doy (yem)"), said, { answering: ['ITEM_AMBIGUOUS'], userTexts: [said, 'yemga, qoylarga'] });
    expect(p.fields.item?.name).toBe("Bug'doy (yem)");
    expect(await asked(w, 'stock_purchase', buying("Bug'doy (yem)"), said, { answering: ['ITEM_AMBIGUOUS'], userTexts: [said, 'boshqasi'] })).toContain('ITEM_AMBIGUOUS');
  });

  it('a word ending does not hide goods, and a guess nobody said is offered, not taken', async () => {
    const w = await world();
    await shelves(w);
    expect((await ready(w, 'stock_purchase', { item: 'Kepak', qty: 1, unit: 'тонну', amount: 1_800_000, paymentMethod: 'cash' }, 'тонну отрубей за 1.8 млн наличными')).fields).toMatchObject({ qty: 1000, item: { name: 'Kepak' } });
    expect((await ready(w, 'stock_purchase', { item: 'Dizel', qty: 300, unit: 'l', unitPrice: 15_000, paymentMethod: 'cash' }, 'Купил 300 литров дизеля по 15 тысяч наличными')).fields.item?.name).toBe('Dizel');
    const result = await draft(w, 'stock_purchase', { item: 'Kepak', qty: 300, unit: 'kg', amount: 900_000, paymentMethod: 'cash' }, '300 kg 900 ming naqd');
    expect(result).toMatchObject({ status: 'needs_info', questions: expect.arrayContaining([expect.objectContaining({ code: 'ITEM_REQUIRED', options: expect.arrayContaining([expect.objectContaining({ label: 'Kepak' })]) })]) });
  });

  it('a machine the words name is used even if the model left it out', async () => {
    const w = await world();
    const p = await ready(w, 'expense', { amount: 2_000_000, category: 'repair', paymentMethod: 'cash' }, "MTZ ta'miriga 2 mln naqd");
    expect(p.fields.target).toMatchObject({ costCenterId: w.assetCenter, defaulted: false });
  });
});

describe('what the third blind test found', () => {
  it('a total the model left out must fit the price, or it is asked about', async () => {
    const w = await world();
    const input: DraftInput = { item: 'Dizel', qty: 500, unit: 'l', unitPrice: 13_000, paymentMethod: 'cash' };
    expect(await asked(w, 'stock_purchase', input, '500 litres of diesel at 13 thousand a litre, 8 million total, paid cash')).toContain('AMOUNT_AMBIGUOUS');
    expect((await ready(w, 'stock_purchase', input, '500 litres of diesel at 13 thousand a litre, 6.5 million total, paid cash')).fields.amount).toBe(6_500_000);
  });

  it('water with nothing to tell which is a question, and the answer settles it', async () => {
    const w = await world();
    const input: DraftInput = { amount: 900_000, category: 'utility_water', paymentMethod: 'cash' };
    expect(await asked(w, 'expense', input, 'Suvga 900 ming naqd')).toContain('CATEGORY_AMBIGUOUS');
    const p = await ready(w, 'expense', input, 'Suvga 900 ming naqd', { answering: ['CATEGORY_AMBIGUOUS'], userTexts: ['Suvga 900 ming naqd', 'Suv'] });
    expect(p.fields.category?.name).toBe('Suv');
    expect((await ready(w, 'expense', { ...input, amount: 910_000 }, 'Idora suvi uchun vodokanalga 910 ming naqd')).fields.category?.name).toBe('Suv');
  });

  it('a name with small words in it still finds the record', async () => {
    const w = await world();
    await w.f.run(() => tx().insert(schema.items).values({ tenantId: w.f.tenantId, farmId: w.f.farmId, name: 'Oqsil vaksinasi', category: 'vaccine', unit: 'dose', defaultWarehouseId: w.store }));
    const p = await ready(w, 'stock_purchase', { item: 'Вакцина от ящура', qty: 400, unit: 'доз', unitPrice: 2_500, paymentMethod: 'bank' }, 'Вакцина от ящура 400 доз по 2500 сум, оплатили безналом');
    expect(p.fields).toMatchObject({ item: { name: 'Oqsil vaksinasi' }, amount: 1_000_000 });
  });

  it('a correction to the bank by its everyday name lands on the bank', async () => {
    const w = await world();
    const context = { documentAmounts: [], channel: 'web' as const, conversationId: await asOwner(w, async () => (await tx().insert(schema.aiConversations).values({ tenantId: w.f.tenantId, farmId: w.f.farmId, userId: w.owner.userId, title: 'x' }).returning())[0].id) };
    const made = await asOwner(w, () => saveDraft('expense', { amount: 3_000_000, category: 'insurance', paymentMethod: 'cash' }, { ...context, userTexts: ['Страховой полис 3 млн наличкой'] }));
    const card = (made as { proposal: ProposalView }).proposal;
    const fixed = await asOwner(w, () => saveDraft('expense', { paymentMethod: 'bank' }, { ...context, userTexts: ['нет, не с кассы, с расчётного ушло'] }, card.id));
    expect(fixed).toMatchObject({ status: 'ready', proposal: { fields: { account: { name: 'Agrobank' } } } });
  });
});

describe('after the final review', () => {
  it('a card says what the books say after finance edits the record', async () => {
    const w = await world();
    const p = await ready(w, 'expense', { ...electricity, amount: 9_000_000 }, 'Elektrga 9 mln naqd');
    const done = await confirm(w, p);
    await w.f.run(() => tx().update(schema.transactions).set({ amount: 7_000_000, amountBase: 7_000_000 }).where(eq(schema.transactions.id, done.result!.id)));
    expect((await asOwner(w, () => getProposal(p.id))).fields).toMatchObject({ amount: 7_000_000, amountBase: 7_000_000 });
  });

  it('a farm with no accounts is told to add one, not asked to pick from nothing', async () => {
    const w = await world();
    await w.f.run(() => tx().update(schema.accounts).set({ active: false }).where(eq(schema.accounts.farmId, w.f.farmId)));
    expect(await asked(w, 'expense', electricity, ELECTRICITY)).toContain('NO_ACCOUNT');
  });
});

describe('what the fourth blind test found', () => {
  it('buying a machine is capital spending, not a cost of the old one', async () => {
    const w = await world();
    const p = await ready(w, 'expense', { amount: 60_000_000, category: 'machinery_purchase', paymentMethod: 'bank', target: 'MTZ-82 №1' }, 'Купили новый трактор 60 млн с расчётного');
    expect(p.fields).toMatchObject({ costTreatment: 'capex', target: { costCenterId: w.general, defaulted: false } });
  });

  it('"not 5 but 7" keeps the scale of the card', async () => {
    const w = await world();
    const context = { documentAmounts: [], channel: 'web' as const, conversationId: await asOwner(w, async () => (await tx().insert(schema.aiConversations).values({ tenantId: w.f.tenantId, farmId: w.f.farmId, userId: w.owner.userId, title: 'x' }).returning())[0].id) };
    const made = await asOwner(w, () => saveDraft('transfer', { amount: 5_000_000, account: 'Agrobank', toAccount: 'Kassa' }, { ...context, userTexts: ['снял со счёта в кассу 5 млн'] }));
    const card = (made as { proposal: ProposalView }).proposal;
    const fixed = await asOwner(w, () => saveDraft('transfer', { amount: 7_000_000 }, { ...context, userTexts: ['не 5 а 7'] }, card.id));
    expect(fixed).toMatchObject({ status: 'ready', proposal: { fields: { amount: 7_000_000 } } });
    const wrong = await asOwner(w, () => saveDraft('transfer', { amount: 9_000_000 }, { ...context, userTexts: ['не 5 а 7'] }, card.id));
    expect(wrong.status).toBe('needs_info');
  });
});
