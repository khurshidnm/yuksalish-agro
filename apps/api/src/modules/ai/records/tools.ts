/**
 * What the model can do with money: look things up, and prepare a draft. There is no confirm tool.
 */
import type { Permission } from '@yap/shared';
import { z } from 'zod';
import { hasPermission } from '../../../core/context';
import { openAlerts } from '../../alerts/summary';
import { cashPosition } from '../../finance/summary';
import { feedBalance } from '../../inventory/summary';
import { herdSummary } from '../../livestock/summary';
import { taskSummary } from '../../tasks/summary';
import type { AiTool, ToolEnv, ToolOutcome } from '../tools';
import {
  accountCandidates, categoryCandidates, costCenterCandidates, counterpartyCandidates, itemCandidates, resolve,
  warehouseCandidates, type Candidate, type TargetType,
} from './resolve';
import type { RecordKind } from './routing';
import { cancelDraft, changedEvent, saveDraft } from './service';
import type { DraftEnv } from './types';
import type { DraftInput } from './validate';

const shared = {
  date: z.string().optional().describe('YYYY-MM-DD. Leave out for today. Work out kecha, вчера and the like from the date in the context.'),
  paymentMethod: z.enum(['cash', 'bank', 'card', 'debt']).optional().describe('Only if the person said it. Never assume.'),
  account: z.string().optional().describe('Account name, only if stated.'),
  counterparty: z.string().optional().describe("Who it was with, in the person's words."),
  description: z.string().max(200).optional().describe('A short note in their own words.'),
  currency: z.string().optional(),
  fxRate: z.number().optional(),
  heardAs: z.record(z.string(), z.string()).optional().describe('When a name was not understood and they then picked an option, their original word, by field: { "item": "solyarka" }. It is remembered for next time.'),
};
const amount = z.number().optional().describe('The amount exactly as stated. Omit it if unstated: code checks it against their words. A price per unit is not an amount: on an expense, ask for the total.');
const category = z.string().optional().describe('Category key or name from find_records.');

const expenseInput = z.object({
  amount, category,
  target: z.string().optional().describe('The field, herd or machine in their words, or "general".'),
  direct: z.boolean().optional().describe('Goods used straight away or paid for as a service, not bought into stock. Only if they said so.'),
  ...shared,
});
const stockInput = z.object({
  item: z.string().optional().describe('The item in their words.'),
  qty: z.number().optional().describe('The number exactly as they said it, not converted. Code converts it.'),
  unit: z.string().optional().describe('The unit they used: kg, tonna, litr, doza, flakon. Code converts it.'),
  amount: z.number().optional().describe('The total, if they stated one.'),
  unitPrice: z.number().optional().describe('The price per unit exactly as they said it, for the unit they said it for. Code multiplies.'),
  warehouse: z.string().optional(),
  ...shared,
});
const incomeInput = z.object({ amount, category, target: z.string().optional(), ...shared });
const debtInput = z.object({
  amount,
  direction: z.enum(['payable', 'receivable']).optional().describe('payable: we paid them. receivable: they paid us. Only if they said it. Never assume.'),
  ...shared,
});
const transferInput = z.object({
  amount,
  account: z.string().optional().describe('Where the money left.'),
  toAccount: z.string().optional().describe('Where it went.'),
  currency: shared.currency,
  date: shared.date,
  description: shared.description,
});

const update = z.object({
  proposalId: z.uuid(),
  changes: z
    .strictObject({ ...expenseInput.shape, ...stockInput.shape, ...debtInput.shape, toAccount: transferInput.shape.toAccount })
    .refine((changes) => Object.keys(changes).length > 0, 'Name what changed')
    .describe('Only what changed.'),
});

function draftTool(name: string, description: string, kind: RecordKind, input: z.ZodType, also: Permission[] = []): AiTool {
  return {
    name,
    description,
    input,
    anyOf: ['finance.create'],
    allOf: ['finance.create', ...also],
    money: true,
    writes: true,
    run: (async (data: DraftInput, env: ToolEnv): Promise<ToolOutcome> => outcome(await saveDraft(kind, data, env.draft as DraftEnv))) as never,
  };
}

function outcome(result: Awaited<ReturnType<typeof saveDraft>>): ToolOutcome {
  if (result.status === 'needs_info') {
    const [first] = result.questions;
    return {
      data: { status: 'needs_info', ask: first.hint, field: first.field, code: first.code, options: first.options, stillMissing: result.questions.length },
      tables: ['ai_proposals'],
      attachments: [{ type: 'question', question: first }],
      record: result.record,
    };
  }
  return {
    data: { status: 'ready', proposalId: result.proposal.id, note: 'A card with Confirm and Cancel buttons is now shown. Do not list its fields. Say in one short sentence that it needs their confirmation.', warnings: result.proposal.warnings.map((w) => w.code) },
    tables: ['ai_proposals'],
    attachments: [{ type: 'proposal', proposal: result.proposal }],
    record: result.record,
  };
}

const LOOKUPS: Record<string, () => Promise<Candidate[]>> = {
  expense_categories: () => categoryCandidates('expense'),
  income_categories: () => categoryCandidates('income'),
  accounts: accountCandidates,
  counterparties: counterpartyCandidates,
  items: itemCandidates,
  warehouses: warehouseCandidates,
  fields: () => costCenterCandidates(['field']),
  herds: () => costCenterCandidates(['herd']),
  machines: () => costCenterCandidates(['asset']),
};

const FINANCE_LOOKUPS = new Set(['accounts', 'counterparties']);

const LOOKUP_TYPES: Record<string, TargetType> = {
  expense_categories: 'category', income_categories: 'category', accounts: 'account', counterparties: 'counterparty',
  items: 'item', warehouses: 'warehouse', fields: 'cost_center', herds: 'cost_center', machines: 'cost_center',
};

export const RECORD_TOOLS: AiTool[] = [
  {
    name: 'find_records',
    description: 'Find what exists, to use the right name: categories, accounts, counterparties, items, warehouses, fields, herds, machines. Reports matches, including when several fit.',
    input: z.object({ kind: z.enum(Object.keys(LOOKUPS) as [string, ...string[]]), query: z.string().optional() }),
    anyOf: [],
    money: false,
    moneyIfAllowed: true,
    run: (async ({ kind, query }: { kind: string; query?: string }): Promise<ToolOutcome> => {
      // Who the farm deals with and where its money sits are finance data.
      if (FINANCE_LOOKUPS.has(kind) && !hasPermission('finance.view')) return { data: { match: 'none', rows: [] }, tables: [kind], rows: 0 };
      const all = await LOOKUPS[kind]();
      const hit = query ? await resolve(LOOKUP_TYPES[kind], query, all) : null;
      const rows = hit?.status === 'found' ? [hit.candidate] : hit?.status === 'ambiguous' ? hit.candidates : all;
      return {
        data: { match: hit?.status ?? 'all', rows: rows.slice(0, 40).map((c) => ({ key: (c as { key?: string }).key, name: c.name })) },
        tables: [kind],
        rows: rows.length,
      };
    }) as never,
  },
  {
    name: 'farm_status',
    description: 'The whole farm at a glance: herd, feed days, open alerts, tasks, and cash for those allowed to see it. Use for "how is the farm", "ahvol qanday", "как дела на ферме".',
    input: z.object({}),
    anyOf: [],
    money: false,
    moneyIfAllowed: true,
    run: (async (): Promise<ToolOutcome> => {
      const money = hasPermission('finance.view');
      const data = {
        ...(hasPermission('livestock.view') ? { herd: await herdSummary() } : {}),
        ...(hasPermission('feed.view') ? { feed: (await feedBalance()).slice(0, 12) } : {}),
        tasks: await taskSummary(),
        alerts: (await openAlerts(8)).map((a) => ({ severity: a.severity, title: a.title })),
        ...(money ? { cash: await cashPosition() } : {}),
      };
      return { data, tables: ['animals', 'stock_batches', 'tasks', 'alerts'] };
    }) as never,
  },
  draftTool('draft_expense', 'Prepare a direct cost that has already been paid: a service, repair, electricity, a fee. For goods bought for stock use draft_stock_purchase.', 'expense', expenseInput),
  draftTool('draft_stock_purchase', 'Prepare goods bought into the warehouse: feed, seed, fertilizer, fuel, drugs, parts.', 'stock_purchase', stockInput, ['inventory.create']),
  draftTool('draft_income', 'Prepare money received that is not a sale of stock or animals: a subsidy, a grant, rent.', 'income', incomeInput),
  draftTool('draft_debt_payment', 'Prepare paying off a debt that already exists: to a supplier, or a buyer paying what they owed. Not an advance for goods still to come.', 'debt_payment', debtInput),
  draftTool('draft_transfer', 'Prepare moving money between cash and bank.', 'transfer', transferInput),
  {
    name: 'update_draft',
    description: 'Change a pending draft of this conversation when the person corrects it. Never make a new draft for a correction.',
    input: update,
    anyOf: ['finance.create'],
    money: false,
    writes: true,
    run: (async ({ proposalId, changes }: z.output<typeof update>, env: ToolEnv): Promise<ToolOutcome> => {
      const result = await saveDraft('expense', changes as DraftInput, env.draft as DraftEnv, proposalId);
      if (result.status !== 'ready') return outcome(result);
      return { ...outcome(result), events: [changedEvent(result.proposal, Object.keys(changes), 'chat')] };
    }) as never,
  },
  {
    name: 'cancel_draft',
    description: 'Cancel a pending draft when the person says to.',
    input: z.object({ proposalId: z.uuid() }),
    anyOf: ['finance.create'],
    money: false,
    writes: true,
    run: (async ({ proposalId }: { proposalId: string }, env: ToolEnv): Promise<ToolOutcome> => {
      const draft = env.draft as DraftEnv;
      const kind = await cancelDraft(proposalId, draft.conversationId, (draft.own ?? draft).userTexts.at(-1) ?? '');
      if (!kind) return { data: { status: 'not_cancelled', note: 'They did not ask to cancel this. It stays open.' }, tables: ['ai_proposals'] };
      return {
        data: { status: 'cancelled' },
        tables: ['ai_proposals'],
        events: [{ type: 'ai_proposal.rejected', entityType: 'ai_proposal', entityId: proposalId, data: { kind, by: 'chat' } }],
      };
    }) as never,
  },
];
