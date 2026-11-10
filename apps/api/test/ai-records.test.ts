import { eq } from 'drizzle-orm';
import { DEFAULT_ROLE_PERMISSIONS } from '@yap/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { ensureConversation } from '../src/modules/ai/conversations';
import { receiveStock, stockOnHand } from '../src/core/inventory';
import { approveTransaction, postTransaction, rejectTransaction } from '../src/core/ledger';
import { cashPosition, costCenterCosts } from '../src/modules/finance/summary';
import { setProvider } from '../src/modules/ai/provider';
import { FARM_DRAFT_TOOLS } from '../src/modules/ai/records/farm-tools';
import { RECORD_TOOLS } from '../src/modules/ai/records/tools';
import {
  confirmProposal, getProposal, listAliases, listPending, rejectProposal, saveDraft, undoProposal, updateProposal,
} from '../src/modules/ai/records/service';
import { eveningRecaps, renderRecap, sendEveningRecap } from '../src/modules/ai/records/recap';
import type { ProposalView } from '../src/modules/ai/records/types';
import type { DraftInput } from '../src/modules/ai/records/validate';
import { ALL_JOBS } from '../src/jobs';
import { TOOLS } from '../src/modules/ai/tools';
import { ELECTRICITY, Scripted, asOwner, asked, call, daysAgo, draft, electricity, ready, say, today, world, type World } from './ai-world';
import type { Client } from './helpers';

describe('readiness: when it must ask', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });

  it('a complete expense is ready, and shared costs land on the general cost center', async () => {
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    expect(p.fields.amountBase).toBe(3_000_000);
    expect(p.fields.account?.name).toBe('Kassa');
    expect(p.fields.target?.type).toBe('general');
    expect(p.warnings.map((x) => x.code)).toContain('TARGET_DEFAULTED');
  });

  it('refuses an amount that is not in the words, whatever the model claims', async () => {
    expect(await asked(w, 'expense', { ...electricity, amount: 3_500_000 }, ELECTRICITY)).toContain('AMOUNT_NOT_STATED');
    expect(await asked(w, 'expense', { ...electricity, amount: 300_000 }, ELECTRICITY)).toContain('AMOUNT_NOT_STATED');
    expect(await asked(w, 'expense', { category: 'electricity', paymentMethod: 'cash' }, "Elektrga to'ladim")).toContain('AMOUNT_REQUIRED');
  });

  it('questions a bare number that probably lost a word', async () => {
    expect(await asked(w, 'expense', { ...electricity, amount: 500 }, 'Elektrga 500 berdim')).toContain('AMOUNT_UNCLEAR');
  });

  it('never assumes how it was paid', async () => {
    expect(await asked(w, 'expense', { amount: 3_000_000, category: 'electricity' }, 'Elektrga 3 mln')).toContain('PAYMENT_METHOD_REQUIRED');
  });

  it('asks which account only when there is a real choice', async () => {
    const two = await world({ secondBank: true });
    expect(await asked(two, 'expense', { ...electricity, paymentMethod: 'bank' }, 'Elektrga 3 mln bankdan')).toContain('ACCOUNT_REQUIRED');
    expect((await ready(w, 'expense', { ...electricity, paymentMethod: 'bank' }, 'Elektrga 3 mln bankdan')).fields.account?.name).toBe('Agrobank');
  });

  it('asks for a category when it is unknown', async () => {
    expect(await asked(w, 'expense', { amount: 3_000_000, paymentMethod: 'cash' }, '3 mln naqd')).toContain('CATEGORY_REQUIRED');
    expect(await asked(w, 'expense', { ...electricity, category: 'kosmik kema' }, ELECTRICITY)).toContain('CATEGORY_UNKNOWN');
  });

  it('asks which herd only when there is more than one', async () => {
    const input: DraftInput = { amount: 800_000, category: 'shearing', paymentMethod: 'cash' };
    const one = await ready(w, 'expense', input, 'Junqirqish 800 ming naqd');
    expect(one.fields.target).toMatchObject({ type: 'herd', defaulted: true });
    const two = await world({ secondHerd: true });
    expect(await asked(two, 'expense', input, 'Junqirqish 800 ming naqd')).toContain('TARGET_REQUIRED');
  });

  it('asks which machine or field for a repair, and accepts a shared answer', async () => {
    const input: DraftInput = { amount: 2_000_000, category: 'repair', paymentMethod: 'cash' };
    expect(await asked(w, 'expense', input, "Ta'mirlash 2 mln naqd")).toContain('TARGET_REQUIRED');
    expect((await ready(w, 'expense', { ...input, target: 'MTZ' }, "MTZ ta'miriga 2 mln naqd")).fields.target?.costCenterId).toBe(w.assetCenter);
    expect((await ready(w, 'expense', { ...input, target: 'umumiy', amount: 2_100_000 }, "Ta'mirlash 2 mln 100 ming naqd, umumiy")).fields.target?.costCenterId).toBe(w.general);
  });

  it('does not let goods slip through as an expense, which would double count on issue', async () => {
    const input: DraftInput = { amount: 3_000_000, category: 'fuel', paymentMethod: 'cash' };
    expect(await asked(w, 'expense', input, "Yoqilg'iga 3 mln naqd")).toContain('GOODS_STOCK_OR_DIRECT');
    const direct = await ready(w, 'expense', { ...input, direct: true, target: 'MTZ' }, "Yoqilg'iga 3 mln naqd, MTZ ga quydik");
    expect(direct.fields).toMatchObject({ costTreatment: 'expense', target: { costCenterId: w.assetCenter } });
  });

  it.each([
    ['salary', 'expense', "Ish haqiga 5 mln naqd"],
    ['loan_interest', 'expense', 'Kredit foizi 5 mln naqd'],
    ['depreciation', 'expense', 'Amortizatsiya 5 mln naqd'],
    ['lamb_sales', 'income', "Qo'zi sotdim 5 mln naqd"],
  ] as const)('%s belongs to another module', async (category, kind, text) => {
    expect(await asked(w, kind, { amount: 5_000_000, category, paymentMethod: 'cash' }, text)).toContain('USE_OTHER_MODULE');
  });

  it('a debt needs a known counterparty', async () => {
    const input: DraftInput = { ...electricity, paymentMethod: 'debt' };
    const words = 'Elektrga 3 mln qarzga';
    expect(await asked(w, 'expense', input, words)).toContain('COUNTERPARTY_REQUIRED');
    expect(await asked(w, 'expense', { ...input, counterparty: 'Mavjud emas' }, words)).toContain('COUNTERPARTY_UNKNOWN');
    expect((await ready(w, 'expense', { ...input, counterparty: 'neft baza', amount: 2_900_000 }, 'Neft bazaga elektr uchun 2 mln 900 ming qarzga')).fields.account).toBeNull();
  });

  it('an unknown name on a paid expense is a note, not a blocker', async () => {
    const p = await ready(w, 'expense', { ...electricity, amount: 2_700_000, counterparty: 'Notarius' }, 'Notariusga 2 mln 700 ming naqd');
    expect(p.fields.counterparty).toBeNull();
    expect(p.fields.description).toBe('Notarius');
  });

  it('a category key wins over a translation of another category', async () => {
    const p = await ready(w, 'expense', { amount: 700_000, category: 'water', paymentMethod: 'cash', target: 'general' }, 'Suv haqi 700 ming naqd, umumiy');
    expect(p.fields.category?.name).toBe('Suv haqi');
  });

  it('accepts a total the model worked out, only when the unit price really was said', async () => {
    const said = '300 litr dizel litri 15 ming naqd';
    const input: DraftInput = { item: 'Dizel', qty: 300, amount: 4_500_000, paymentMethod: 'cash', counterparty: 'Neft Baza' };
    expect((await ready(w, 'stock_purchase', input, said)).fields).toMatchObject({ amount: 4_500_000, unitPrice: 15_000 });
    expect(await asked(w, 'stock_purchase', { ...input, amount: 4_800_000 }, said)).toContain('AMOUNT_NOT_STATED');
  });

  it('asks instead of picking between two similar names', async () => {
    const two = await world();
    await two.f.run(() => tx().insert(schema.counterparties).values({ tenantId: two.f.tenantId, farmId: two.f.farmId, name: 'Neft Savdo', type: 'supplier' }));
    expect(await asked(two, 'expense', { ...electricity, paymentMethod: 'debt', counterparty: 'neft' }, ELECTRICITY)).toContain('COUNTERPARTY_AMBIGUOUS');
  });

  it('refuses a future date and warns about an old one', async () => {
    const said = (iso: string) => iso.split('-').reverse().join('.');
    const future = daysAgo(-3);
    expect(await asked(w, 'expense', { ...electricity, date: future }, `Elektrga 3 mln naqd ${said(future)}`)).toContain('DATE_IN_FUTURE');
    const old = await ready(w, 'expense', { ...electricity, amount: 2_800_000, date: daysAgo(45) }, `Elektrga 2 mln 800 ming naqd ${said(daysAgo(45))}`);
    expect(old.warnings.map((x) => x.code)).toContain('OLD_DATE');
  });

  it('never accepts a currency the person did not name', async () => {
    expect(await asked(w, 'expense', { ...electricity, currency: 'USD' }, ELECTRICITY)).toContain('CURRENCY_UNCLEAR');
  });

  it('needs a rate for a foreign currency, and uses the stored one', async () => {
    const input: DraftInput = { amount: 200, category: 'electricity', paymentMethod: 'cash' };
    expect(await asked(w, 'expense', input, 'Elektrga 200 dollar naqd')).toContain('FX_RATE_REQUIRED');
    await w.f.run(() => tx().insert(schema.fxRates).values({ tenantId: w.f.tenantId, date: daysAgo(2), currency: 'USD', rate: 12_500 }));
    const p = await ready(w, 'expense', input, 'Elektrga 200 dollar naqd');
    expect(p.fields).toMatchObject({ currency: 'USD', fxRate: 12_500, amountBase: 2_500_000 });
  });

  it('a stock purchase needs a quantity, and a supplier only when something is owed', async () => {
    const input: DraftInput = { item: 'Dizel', amount: 3_000_000, paymentMethod: 'cash' };
    expect(await asked(w, 'stock_purchase', input, 'Dizel 3 mln naqd')).toContain('QUANTITY_REQUIRED');
    expect((await ready(w, 'stock_purchase', { ...input, qty: 200, amount: 3_100_000 }, '200 litr dizel 3 mln 100 ming naqd')).fields.counterparty).toBeNull();
    expect(await asked(w, 'stock_purchase', { ...input, qty: 200, paymentMethod: 'debt' }, '200 litr dizel 3 mln qarzga')).toContain('COUNTERPARTY_REQUIRED');
  });

  it('works out the total from a unit price the person stated', async () => {
    const p = await ready(w, 'stock_purchase', { item: 'Dizel', qty: 200, unit: 'l', unitPrice: 15_000, paymentMethod: 'cash', counterparty: 'Neft Baza' }, "200 litr dizel litri 15 ming so'mdan naqd");
    expect(p.fields).toMatchObject({ amount: 3_000_000, unitPrice: 15_000, qty: 200, costTreatment: 'inventory' });
    expect(p.fields.warehouse?.id).toBe(w.store);
  });

  it('warns about an amount beyond the account balance', async () => {
    const p = await ready(w, 'expense', { amount: 150_000_000, category: 'gas', paymentMethod: 'cash' }, 'Gazga 150 mln naqd');
    expect(p.warnings.map((x) => x.code)).toContain('OVER_BALANCE');
    expect(p.willNeedApproval).toBe(true);
  });

  it('warns when an amount is far above the usual for its category', async () => {
    const fresh = await world();
    await asOwner(fresh, async () => {
      for (let i = 0; i < 6; i++) {
        await postTransaction({ date: daysAgo(20 + i), type: 'expense', amount: 100_000 + i, paymentMethod: 'cash', accountId: fresh.cash, categoryId: fresh.electricityCategory, costCenterId: fresh.general });
      }
    });
    const p = await ready(fresh, 'expense', { ...electricity, amount: 900_000 }, 'Elektrga 900 ming naqd');
    expect(p.warnings.map((x) => x.code)).toContain('UNUSUALLY_LARGE');
  });
});

describe('confirming', () => {
  it('a draft alone changes nothing, and confirm posts exactly once with the right numbers', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    const before = await asOwner(w, cashPosition);
    expect(before.accounts.find((a) => a.id === w.cash)?.balance).toBe(100_000_000);

    const done = await asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp }));
    expect(done).toMatchObject({ status: 'confirmed', result: { type: 'transaction', status: 'approved' } });
    expect(done.undoUntil).not.toBeNull();

    const after = await asOwner(w, cashPosition);
    expect(after.accounts.find((a) => a.id === w.cash)?.balance).toBe(97_000_000);
    const rows = await w.f.run(() => tx().select().from(schema.transactions));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ createdBy: w.owner.userId, costCenterId: w.general, costTreatment: 'expense' });
    const events = await w.f.run(() => tx().select().from(schema.events).where(eq(schema.events.type, 'ai_proposal.confirmed')));
    expect(events).toHaveLength(1);
  });

  it('a double tap, even at the same moment, records one transaction', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    const results = await Promise.allSettled([asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp })), asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp }))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await w.f.run(() => tx().select().from(schema.transactions))).toHaveLength(1);
    await expect(asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp }))).rejects.toMatchObject({ code: 'PROPOSAL_NOT_PENDING' });
  });

  it('goes through the real receipt, without double counting', async () => {
    const w = await world();
    // 137 does not divide 4.5 mln evenly, and the money must still come to the stated total.
    const p = await ready(w, 'stock_purchase', { item: 'Dizel', qty: 137, amount: 4_500_000, paymentMethod: 'bank', counterparty: 'Neft Baza' }, '137 litr dizel 4,5 mln bankdan');
    const done = await asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp }));
    expect(done.result?.type).toBe('stock_receipt');
    expect(await w.f.run(() => stockOnHand(w.diesel))).toBe(137);
    const [entry] = await w.f.run(() => tx().select().from(schema.transactions));
    expect(entry).toMatchObject({ costTreatment: 'inventory', amountBase: 4_500_000 });
    const costs = await asOwner(w, () => costCenterCosts());
    expect(costs.reduce((sum, row) => sum + row.direct, 0)).toBe(0);
    expect((await asOwner(w, cashPosition)).accounts.find((a) => a.id === w.bank)?.balance).toBe(495_500_000);
  });

  it('income, debt payment and transfer move the right balances', async () => {
    const w = await world();
    await asOwner(w, () => postTransaction({ date: daysAgo(5), type: 'expense', amount: 4_000_000, paymentMethod: 'debt', counterpartyId: w.supplier, categoryId: w.electricityCategory, costCenterId: w.general }));

    const income = await ready(w, 'income', { amount: 2_000_000, category: 'subsidies', paymentMethod: 'bank' }, "Subsidiya 2 mln bankka tushdi");
    const debt = await ready(w, 'debt_payment', { amount: 1_500_000, direction: 'payable', counterparty: 'Neft Baza', paymentMethod: 'cash' }, "Neft Bazaga 1,5 mln qarzni to'ladim naqd");
    const move = await ready(w, 'transfer', { amount: 4_000_000, account: 'Agrobank', toAccount: 'Kassa' }, 'Bankdan kassaga 4 mln oldim');
    for (const p of [income, debt, move]) await asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp }));

    const { accounts } = await asOwner(w, cashPosition);
    expect(accounts.find((a) => a.id === w.cash)?.balance).toBe(100_000_000 - 1_500_000 + 4_000_000);
    expect(accounts.find((a) => a.id === w.bank)?.balance).toBe(500_000_000 + 2_000_000 - 4_000_000);
  });

  it('a settlement needs a debt to settle, and cannot pay more than is open', async () => {
    const w = await world();
    const input: DraftInput = { amount: 1_000_000, direction: 'payable', counterparty: 'Neft Baza', paymentMethod: 'cash' };
    expect(await asked(w, 'debt_payment', input, "Neft Bazaga 1 mln to'ladim naqd")).toContain('NO_OPEN_DEBT');
    await asOwner(w, () => postTransaction({ date: daysAgo(5), type: 'expense', amount: 800_000, categoryId: w.electricityCategory, paymentMethod: 'debt', counterpartyId: w.supplier, costCenterId: w.general }));
    expect(await asked(w, 'debt_payment', input, "Neft Bazaga 1 mln to'ladim naqd")).toContain('MORE_THAN_OWED');
    expect((await ready(w, 'debt_payment', { ...input, amount: 500_000 }, "Neft Bazaga 500 ming to'ladim naqd")).fields.direction).toBe('payable');
  });

  it('exactly at the threshold counts as large', async () => {
    const w = await world();
    const p = await ready(w, 'expense', { ...electricity, amount: 5_000_000 }, 'Elektrga 5 mln naqd');
    expect((await asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp }))).result?.status).toBe('pending');
  });

  it('a large amount still waits for a second person, and cannot be undone here', async () => {
    const w = await world();
    const p = await ready(w, 'expense', { ...electricity, amount: 9_000_000 }, 'Elektrga 9 mln naqd');
    expect(p.willNeedApproval).toBe(true);
    const done = await asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp }));
    expect(done.result?.status).toBe('pending');
    expect(done.undoUntil).toBeNull();
    expect((await asOwner(w, cashPosition)).accounts.find((a) => a.id === w.cash)?.balance).toBe(100_000_000);
  });

  it('a possible duplicate needs an explicit yes', async () => {
    const w = await world();
    await asOwner(w, async () => {
      const first = await saveDraft('expense', electricity, { userTexts: [ELECTRICITY], documentAmounts: [], channel: 'web', conversationId: null });
      if (first.status === 'ready') await confirmProposal(first.proposal.id, { stamp: first.proposal.stamp });
    });
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    expect(p.needsAcknowledgement).toBe(true);
    await expect(asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp }))).rejects.toMatchObject({ code: 'NOT_ACKNOWLEDGED' });
    expect((await asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp, acknowledged: true }))).status).toBe('confirmed');
  });

  it('the same thing drafted twice is never merged: the second card needs an explicit yes', async () => {
    const w = await world();
    const conversationId = await asOwner(w, () => ensureConversation(undefined, 'x'));
    const env = { userTexts: [ELECTRICITY], documentAmounts: [], channel: 'web' as const, conversationId };
    await asOwner(w, () => saveDraft('expense', electricity, env));
    await asOwner(w, () => saveDraft('expense', electricity, env));
    const [first, second] = await asOwner(w, listPending);
    expect(first.needsAcknowledgement).toBe(false);
    expect(second.needsAcknowledgement).toBe(true);
  });

  it('two different things at the same price are two cards', async () => {
    const w = await world();
    const conversationId = await asOwner(w, () => ensureConversation(undefined, 'x'));
    const text = '400 ming tushlik va 400 ming internet naqd';
    const env = { userTexts: [text], documentAmounts: [], channel: 'web' as const, conversationId };
    const lunch = await asOwner(w, () => saveDraft('expense', { amount: 400_000, category: 'meals', paymentMethod: 'cash' }, env));
    const internet = await asOwner(w, () => saveDraft('expense', { amount: 400_000, category: 'communication', paymentMethod: 'cash' }, env));
    expect(lunch.status).toBe('ready');
    expect(internet.status).toBe('ready');
    expect(await asOwner(w, listPending)).toHaveLength(2);
  });

  it('an expired draft cannot be confirmed', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    await w.f.run(() => tx().update(schema.aiProposals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.aiProposals.id, p.id)));
    expect((await asOwner(w, () => getProposal(p.id))).status).toBe('expired');
    await expect(asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp }))).rejects.toMatchObject({ code: 'PROPOSAL_EXPIRED' });
    expect(await asOwner(w, listPending)).toEqual([]);
  });

  it('a rejected draft stays out of the books', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    await asOwner(w, () => rejectProposal(p.id));
    await expect(asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp }))).rejects.toMatchObject({ code: 'PROPOSAL_NOT_PENDING' });
    expect(await w.f.run(() => tx().select().from(schema.transactions))).toEqual([]);
  });
});

describe('undo', () => {
  it('takes back an approved expense', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    await asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp }));
    expect((await asOwner(w, () => undoProposal(p.id))).status).toBe('undone');
    expect((await asOwner(w, cashPosition)).accounts.find((a) => a.id === w.cash)?.balance).toBe(100_000_000);
    const [entry] = await w.f.run(() => tx().select().from(schema.transactions));
    expect(entry.status).toBe('rejected');
  });

  it('takes back a stock purchase, money first and then the stock', async () => {
    const w = await world();
    const p = await ready(w, 'stock_purchase', { item: 'Dizel', qty: 100, amount: 1_500_000, paymentMethod: 'cash', counterparty: 'Neft Baza' }, '100 litr dizel 1,5 mln naqd');
    await asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp }));
    await asOwner(w, () => undoProposal(p.id));
    expect(await w.f.run(() => stockOnHand(w.diesel))).toBe(0);
    expect((await asOwner(w, cashPosition)).accounts.find((a) => a.id === w.cash)?.balance).toBe(100_000_000);
  });

  it('refuses a stock purchase already used', async () => {
    const w = await world();
    const p = await ready(w, 'stock_purchase', { item: 'Dizel', qty: 100, amount: 1_500_000, paymentMethod: 'cash', counterparty: 'Neft Baza' }, '100 litr dizel 1,5 mln naqd');
    await asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp }));
    const { issueStock } = await import('../src/core/inventory');
    await asOwner(w, () => issueStock({ itemId: w.diesel, warehouseId: w.store, qty: 10, date: today, costCenterId: w.assetCenter, reason: 'fuel' }));
    await expect(asOwner(w, () => undoProposal(p.id))).rejects.toBeTruthy();
    expect(await w.f.run(() => stockOnHand(w.diesel))).toBe(90);
  });

  it('closes after the window', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    await asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp }));
    await w.f.run(() => tx().update(schema.aiProposals).set({ undoUntil: new Date(Date.now() - 1000) }).where(eq(schema.aiProposals.id, p.id)));
    await expect(asOwner(w, () => undoProposal(p.id))).rejects.toMatchObject({ code: 'UNDO_EXPIRED' });
  });
});

describe('a correction replaces what it corrects', () => {
  const env = (text: string) => ({ userTexts: ['Gazga 400 ming naqd', text], documentAmounts: [], channel: 'web' as const, conversationId: null });
  const named: DraftInput = { amount: 400_000, category: 'gas', paymentMethod: 'cash', account: 'Kassa' };

  it('a new payment method drops the old account', async () => {
    const w = await world();
    const p = await ready(w, 'expense', named, 'Gazga 400 ming naqd');
    const fixed = await asOwner(w, () => saveDraft('expense', { paymentMethod: 'bank' }, env("Yo'q, bankdan"), p.id));
    expect(fixed).toMatchObject({ status: 'ready', proposal: { id: p.id, fields: { paymentMethod: 'bank', account: { name: 'Agrobank' } } } });
  });

  it('a new account drops the old payment method', async () => {
    const w = await world();
    const p = await ready(w, 'expense', named, 'Gazga 400 ming naqd');
    const fixed = await asOwner(w, () => saveDraft('expense', { account: 'Agrobank' }, env("Yo'q, Agrobankdan"), p.id));
    expect(fixed).toMatchObject({ status: 'ready', proposal: { fields: { paymentMethod: 'bank', account: { name: 'Agrobank' } } } });
  });

  it('the card form follows the same rule', async () => {
    const w = await world();
    const p = await ready(w, 'expense', named, 'Gazga 400 ming naqd');
    expect(await asOwner(w, () => updateProposal(p.id, { paymentMethod: 'bank' }))).toMatchObject({ fields: { account: { name: 'Agrobank' } } });
  });

  it('refuses a card whose method and account disagree, whatever the model sends', async () => {
    const w = await world();
    expect(await asked(w, 'expense', { ...named, paymentMethod: 'bank' }, 'Gazga 400 ming bankdan, Kassa orqali')).toContain('ACCOUNT_REQUIRED');
  });
});

describe('changing a card', () => {
  it('a quantity typed into the form is not converted a second time', async () => {
    const w = await world();
    await w.f.run(() => tx().insert(schema.items).values({ tenantId: w.f.tenantId, farmId: w.f.farmId, name: 'Arpa', category: 'feed', unit: 'kg', defaultWarehouseId: w.store }));
    const p = await ready(w, 'stock_purchase', { item: 'Arpa', qty: 2, unit: 't', amount: 4_000_000, paymentMethod: 'cash', counterparty: 'Neft Baza' }, '2 tonna arpa 4 mln naqd');
    expect(p.fields.qty).toBe(2000);
    expect(await asOwner(w, () => updateProposal(p.id, { qty: 3000 }))).toMatchObject({ fields: { qty: 3000, amount: 4_000_000 } });
  });

  it('an amount typed into the form stays in the currency of the draft', async () => {
    const w = await world();
    await w.f.run(() => tx().insert(schema.fxRates).values({ tenantId: w.f.tenantId, date: daysAgo(1), currency: 'USD', rate: 12_500 }));
    const p = await ready(w, 'expense', { amount: 200, category: 'electricity', paymentMethod: 'cash' }, 'Elektrga 200 dollar naqd');
    const changed = await asOwner(w, () => updateProposal(p.id, { amount: 250 }));
    expect(changed).toMatchObject({ fields: { amount: 250, currency: 'USD', fxRate: 12_500, amountBase: 3_125_000 } });
  });

  it('a shared cost can be charged somewhere specific, and that choice is not called a default', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    expect(p.fields.target).toMatchObject({ costCenterId: w.general, defaulted: true });
    const moved = await asOwner(w, () => updateProposal(p.id, { costCenterId: w.herdCenter }));
    expect(moved).toMatchObject({ fields: { target: { costCenterId: w.herdCenter, defaulted: false } } });
    const back = await asOwner(w, () => updateProposal(p.id, { costCenterId: w.general }));
    expect(back).toMatchObject({ fields: { target: { costCenterId: w.general, defaulted: false } } });
  });

  it('re-checks the change, and an amount typed into the form counts as stated', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    const changed = await asOwner(w, () => updateProposal(p.id, { amount: 3_200_000, accountId: w.bank, paymentMethod: 'bank' }));
    expect(changed).toMatchObject({ fields: { amount: 3_200_000, account: { id: w.bank } } });
    const broken = await asOwner(w, () => updateProposal(p.id, { date: '2099-01-01' }));
    expect(broken).toMatchObject({ questions: [{ code: 'DATE_IN_FUTURE' }] });
  });
});

describe('learning', () => {
  it('a word that already matched a record teaches nothing: a second tractor must still be asked about', async () => {
    const w = await world();
    const p = await ready(w, 'expense', { amount: 2_000_000, category: 'repair', paymentMethod: 'cash', target: 'MTZ' }, "MTZ ta'miriga 2 mln naqd");
    await asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp }));
    expect(await asOwner(w, listAliases)).toEqual([]);
  });
});

describe('learning a word it did not know', () => {
  const input: DraftInput = { qty: 200, amount: 3_000_000, paymentMethod: 'cash', counterparty: 'Neft Baza' };
  const text = '200 litr gazoyl 3 mln naqd';
  /** They picked Dizel from the options, and the press is their next message. */
  const pickedDizel = { answering: ['ITEM_UNKNOWN'], userTexts: [text, 'Dizel'] };

  it('asks the first time, remembers the answer, and does not ask again', async () => {
    const w = await world();
    expect(await asked(w, 'stock_purchase', { ...input, item: 'gazoyl' }, text)).toContain('ITEM_UNKNOWN');

    const answered = await ready(w, 'stock_purchase', { ...input, item: 'Dizel', heardAs: { item: 'gazoyl' } }, text, pickedDizel);
    expect(answered.learning).toEqual([{ phrase: 'gazoyl', name: 'Dizel' }]);
    await asOwner(w, () => confirmProposal(answered.id, { stamp: answered.stamp }));
    expect((await asOwner(w, listAliases)).map((a) => a.phrase)).toContain('gazoyl');

    const next = await ready(w, 'stock_purchase', { ...input, item: "GAZOYL", qty: 100, amount: 2_000_000 }, '100 litr gazoyl 2 mln naqd');
    expect(next.fields.item?.name).toBe('Dizel');
  });

  it('a word learned on one tenant means nothing on another', async () => {
    const a = await world();
    const b = await world();
    const answered = await ready(a, 'stock_purchase', { ...input, item: 'Dizel', heardAs: { item: 'gazoyl' } }, text, pickedDizel);
    await asOwner(a, () => confirmProposal(answered.id, { stamp: answered.stamp }));
    expect(await asked(b, 'stock_purchase', { ...input, item: 'gazoyl' }, text)).toContain('ITEM_UNKNOWN');
  });

  it('nothing is learned from a draft that was not confirmed', async () => {
    const w = await world();
    await ready(w, 'stock_purchase', { ...input, item: 'Dizel', heardAs: { item: 'gazoyl' } }, text, pickedDizel);
    expect(await asOwner(w, listAliases)).toEqual([]);
  });
});

describe('who may do what', () => {
  it('someone else cannot see or confirm your draft', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    const director = await w.f.as('director');
    expect((await director.get(`/ai/proposals/${p.id}`)).status).toBe(403);
    expect((await director.post(`/ai/proposals/${p.id}/confirm`, { stamp: p.stamp })).status).toBe(403);
    expect((await director.get('/ai/proposals')).data).toEqual([]);
  });

  it('confirm over HTTP works for the owner of the draft', async () => {
    const w = await world();
    const p = await ready(w, 'expense', electricity, ELECTRICITY);
    const res = await w.owner.post(`/ai/proposals/${p.id}/confirm`, { stamp: p.stamp });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('confirmed');
  });

  it('a role without finance.create cannot turn a draft into money, even its own', async () => {
    const w = await world();
    const shepherd = await w.f.as('shepherd');
    await w.f.run(() => tx().update(schema.roles).set({ permissions: [...DEFAULT_ROLE_PERMISSIONS.shepherd, 'ai.view'] }).where(eq(schema.roles.id, w.f.roleIds.shepherd)));
    const p = await w.f.run(
      async () => saveDraft('expense', electricity, { userTexts: [ELECTRICITY], documentAmounts: [], channel: 'web', conversationId: null }),
      { userId: shepherd.userId },
    );
    if (p.status !== 'ready') throw new Error('expected ready');
    const res = await shepherd.post(`/ai/proposals/${p.proposal.id}/confirm`, { stamp: p.proposal.stamp });
    expect(res.status).toBe(403);
    expect(await w.f.run(() => tx().select().from(schema.transactions))).toEqual([]);
  });

  it('a draft from another tenant does not exist', async () => {
    const a = await world();
    const b = await world();
    const p = await ready(a, 'expense', electricity, ELECTRICITY);
    expect((await b.owner.post(`/ai/proposals/${p.id}/confirm`, { stamp: p.stamp })).status).toBe(404);
  });

  it('there is no tool that confirms, anywhere', () => {
    const names = [...TOOLS, ...RECORD_TOOLS].map((t) => t.name);
    expect(names.filter((n) => /confirm|approve|post_|record_|undo/i.test(n))).toEqual([]);
  });

  it('every draft tool needs finance.create', () => {
    for (const tool of RECORD_TOOLS.filter((t) => t.writes)) expect(tool.anyOf).toEqual(['finance.create']);
  });

  it('the accountant now has the assistant', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.accountant).toEqual(expect.arrayContaining(['ai.view', 'ai.create']));
  });
});

describe('through the assistant', () => {
  afterEach(() => setProvider(undefined));

  it('the AI role can save a draft, and a card comes back with no money moved', async () => {
    const w = await world();
    setProvider(new Scripted([call('draft_expense', electricity), say('Tasdiqlashingizni kutmoqda.')]));
    const res = await w.owner.post('/ai/chat', { message: ELECTRICITY });
    expect(res.status).toBe(200);
    const card = res.data.message.attachments.find((a: any) => a.type === 'proposal');
    expect(card.proposal).toMatchObject({ kind: 'expense', status: 'pending', channel: 'web', sourceText: ELECTRICITY });
    expect(await w.f.run(() => tx().select().from(schema.transactions))).toEqual([]);
    expect((await w.owner.get('/ai/proposals')).data).toHaveLength(1);
    expect(res.data.message.toolCalls[0]).toMatchObject({ name: 'draft_expense', status: 'ok' });
  });

  it('a model inventing an amount gets a question, and no card', async () => {
    const w = await world();
    const provider = new Scripted([call('draft_expense', { ...electricity, amount: 9_999_999 }), say('Summani ayting.')]);
    setProvider(provider);
    const res = await w.owner.post('/ai/chat', { message: 'Elektrga pul berdim' });
    expect(res.data.message.attachments.filter((a: any) => a.type === 'proposal')).toEqual([]);
    const result = provider.requests[1].messages.at(-1)!.content[0] as { content: string };
    expect(result.content).toContain('AMOUNT_NOT_STATED');
  });

  it('an amount from an earlier message in the exchange still counts', async () => {
    const w = await world();
    setProvider(new Scripted([call('draft_expense', { amount: 3_000_000, category: 'electricity' }), say('Qanday to\'landi?')]));
    const first = await w.owner.post('/ai/chat', { message: 'Elektrga 3 mln' });
    setProvider(new Scripted([call('draft_expense', electricity), say('Tayyor.')]));
    const second = await w.owner.post('/ai/chat', { conversationId: first.data.conversationId, message: 'naqd' });
    expect(second.data.message.attachments.some((a: any) => a.type === 'proposal')).toBe(true);
  });

  it('options come back as a question for the buttons', async () => {
    const w = await world();
    setProvider(new Scripted([call('draft_expense', { amount: 2_000_000, category: 'repair', paymentMethod: 'cash' }), say('Qaysi birini?')]));
    const res = await w.owner.post('/ai/chat', { message: "Ta'mirlash 2 mln naqd" });
    const question = res.data.message.attachments.find((a: any) => a.type === 'question');
    expect(question.question.code).toBe('TARGET_REQUIRED');
    expect(question.question.options.map((o: any) => o.label)).toEqual(expect.arrayContaining(['MTZ-82 №1']));
  });

  it('a role without finance.create is offered no draft tools', async () => {
    const w = await world();
    await w.f.run(() => tx().update(schema.roles).set({ permissions: [...DEFAULT_ROLE_PERMISSIONS.shepherd, 'ai.view'] }).where(eq(schema.roles.id, w.f.roleIds.shepherd)));
    const shepherd = await w.f.as('shepherd');
    const provider = new Scripted([say('Bu sizga yopiq.')]);
    setProvider(provider);
    await shepherd.post('/ai/chat', { message: "Elektrga 3 mln to'ladim" });
    const offered = (provider.requests[0].tools ?? []).map((t) => t.name);
    expect(offered).toContain('farm_status');
    // A farm record is not money: its draft tool follows the owning module's right, not finance.create.
    expect(offered.filter((n) => n.startsWith('draft_') && !FARM_DRAFT_TOOLS.has(n))).toEqual([]);
  });

  it('farm_status gives a shepherd no cash, and an owner the whole picture', async () => {
    const w = await world();
    await w.f.run(() => tx().update(schema.roles).set({ permissions: [...DEFAULT_ROLE_PERMISSIONS.shepherd, 'ai.view'] }).where(eq(schema.roles.id, w.f.roleIds.shepherd)));
    const shepherd = await w.f.as('shepherd');
    const read = async (client: Client) => {
      const provider = new Scripted([call('farm_status', {}), say('Yaxshi.')]);
      setProvider(provider);
      await client.post('/ai/chat', { message: 'Ahvol qanday?' });
      return (provider.requests[1].messages.at(-1)!.content[0] as { content: string }).content;
    };
    expect(await read(shepherd)).not.toContain('"cash"');
    expect(await read(w.owner)).toContain('"cash"');
  });

  it('a client cannot fake the channel or attach blocks through the web route', async () => {
    const w = await world();
    const provider = new Scripted([say('Salom')]);
    setProvider(provider);
    await w.owner.post('/ai/chat', { message: 'Salom', channel: 'telegram', blocks: [{ type: 'image', mediaType: 'image/png', dataBase64: 'AAA' }] });
    expect(provider.requests[0].messages.at(-1)!.content).toEqual([{ type: 'text', text: 'Salom' }]);
    const [row] = await w.f.run(() => tx().select().from(schema.aiConversations));
    expect(row.channel).toBe('web');
  });
});


describe('the evening recap', () => {
  const recapOf = async (w: World, userId: string) => {
    const rows = await w.f.run(() => tx().select().from(schema.notifications).where(eq(schema.notifications.userId, userId)));
    return rows.filter((n) => n.eventType === 'assistant_recap');
  };

  it('is registered to run at 20:00', () => {
    expect(ALL_JOBS.find((j) => j.name === 'ai-evening-recap')?.cron).toBe('0 20 * * *');
  });

  it('counts only what reached the books today, and names what still waits', async () => {
    const w = await world();
    const confirm = (id: string) => asOwner(w, async () => confirmProposal(id, { stamp: (await getProposal(id)).stamp }));

    // Control numbers: out 1 500 000 + 400 000 = 1 900 000, in 750 000, the transfer in neither.
    await confirm((await ready(w, 'expense', { amount: 1_500_000, category: 'electricity', paymentMethod: 'cash' }, 'Elektrga 1,5 mln naqd')).id);
    await confirm((await ready(w, 'expense', { amount: 400_000, category: 'gas', paymentMethod: 'cash' }, 'Gazga 400 ming naqd')).id);
    await confirm((await ready(w, 'income', { amount: 750_000, category: 'other_income', paymentMethod: 'cash' }, 'Boshqa kirim 750 ming naqd')).id);
    await confirm((await ready(w, 'transfer', { amount: 2_000_000, account: 'Kassa', toAccount: 'Agrobank' }, "Kassadan Agrobankka 2 mln o'tkazdim")).id);

    // None of these may reach the totals.
    const undone = await ready(w, 'expense', { amount: 111_000, category: 'meals', paymentMethod: 'cash' }, 'Tushlik 111 ming naqd');
    await confirm(undone.id);
    await asOwner(w, () => undoProposal(undone.id));
    const yesterday = await ready(w, 'expense', { amount: 222_000, category: 'communication', paymentMethod: 'cash' }, 'Aloqa 222 ming naqd');
    await confirm(yesterday.id);
    await w.f.run(() => tx().update(schema.aiProposals).set({ confirmedAt: new Date(Date.now() - 86_400_000) }).where(eq(schema.aiProposals.id, yesterday.id)));
    const large = await ready(w, 'expense', { amount: 9_000_000, category: 'insurance', paymentMethod: 'bank' }, "Sug'urtaga 9 mln bankdan");
    await confirm(large.id);
    const refused = await ready(w, 'expense', { amount: 8_000_000, category: 'licenses', paymentMethod: 'bank' }, 'Litsenziyaga 8 mln bankdan');
    const { result } = await confirm(refused.id);
    await w.f.run(() => rejectTransaction(result!.id, 'yanglish'), { userId: (await w.f.as('director')).userId });
    await ready(w, 'expense', { amount: 333_000, category: 'clothing', paymentMethod: 'cash' }, 'Kiyimga 333 ming naqd');

    const recap = (await w.f.run(eveningRecaps)).get(w.owner.userId)!;
    expect(recap).toMatchObject({ recorded: 4, moneyOut: 1_900_000, moneyIn: 750_000, awaitingSecond: 1, waiting: 1 });
    expect(recap.lines.map((l) => l.amount)).toEqual([2_000_000, 1_500_000, 750_000, 400_000]);
    expect(recap.lines[0].label).toBe('Kassa → Agrobank');

    expect(await w.f.run(sendEveningRecap)).toBe(1);
    const [message] = await recapOf(w, w.owner.userId);
    expect(message.deliveries).toEqual({ telegram: 'pending' });
    expect(message.body).toContain('Chiqim: 1 900 000 so\'m');
    expect(message.body).toContain('Kirim: 750 000 so\'m');
    expect(message.body).toContain("tasdig'ingizni kutmoqda: 1");
  });

  it('a second person approving later is reflected, and a person with nothing hears nothing', async () => {
    const w = await world();
    const director = await w.f.as('director');
    const p = await ready(w, 'expense', { amount: 9_000_000, category: 'insurance', paymentMethod: 'bank' }, "Sug'urtaga 9 mln bankdan");
    const { result } = await asOwner(w, () => confirmProposal(p.id, { stamp: p.stamp }));
    expect((await w.f.run(eveningRecaps)).get(w.owner.userId)).toMatchObject({ recorded: 0, awaitingSecond: 1 });
    await w.f.run(() => approveTransaction(result!.id), { userId: director.userId });
    expect((await w.f.run(eveningRecaps)).get(w.owner.userId)).toMatchObject({ recorded: 1, awaitingSecond: 0, moneyOut: 9_000_000 });

    await w.f.run(sendEveningRecap);
    expect(await recapOf(w, director.userId)).toEqual([]);
  });

  it('nothing to say means no message, and it speaks the person\'s language', async () => {
    const w = await world();
    expect(await w.f.run(sendEveningRecap)).toBe(0);
    await w.f.run(() => tx().update(schema.users).set({ locale: 'ru' }).where(eq(schema.users.id, w.owner.userId)));
    await asOwner(w, async () => {
      const { proposal } = (await saveDraft('expense', electricity, { userTexts: [ELECTRICITY], documentAmounts: [], channel: 'web', conversationId: null })) as { proposal: ProposalView };
      await confirmProposal(proposal.id, { stamp: proposal.stamp });
    });
    await w.f.run(sendEveningRecap);
    const [message] = await recapOf(w, w.owner.userId);
    expect(message.title).toContain('Записи за сегодня');
    expect(message.body).toContain('Расход: 3 000 000');
  });

  it('someone who has left the farm no longer hears about it', async () => {
    const w = await world();
    await ready(w, 'expense', electricity, ELECTRICITY);
    await w.f.run(() => tx().update(schema.memberships).set({ status: 'inactive' }).where(eq(schema.memberships.userId, w.owner.userId)));
    expect(await w.f.run(sendEveningRecap)).toBe(0);
  });

  it('a long day stays one short message', () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ label: `Yozuv ${i}`, amount: 1000 + i, currency: 'UZS' }));
    const { body } = renderRecap({ date: today, currency: 'UZS', lines, recorded: 20, moneyOut: 1, moneyIn: 0, awaitingSecond: 0, waiting: 0 }, 'en');
    expect(body.split('\n').filter((l) => l.startsWith('•'))).toHaveLength(12);
    expect(body).toContain('and 8 more');
  });
});
