import type { FastifyInstance } from 'fastify';
import { and, asc, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { CATEGORY_KINDS, COST_CENTER_TYPES, EXPENSE_GROUPS, INCOME_GROUPS } from '@yap/shared';
import { LANGUAGES, resources } from '@yap/shared/i18n';
import { schema } from '../../db/client';
import { ctx, tx } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { routes } from '../../core/http';
import { clientId, idParam, isoDate, isoMonth, listQuery, searchAny } from '../../core/query';
import { receiptMoneyInput, recordReceiptMoney, unpaidReceipts } from '../inventory/stock.service';
import * as accounts from './accounts.service';
import * as budget from './budget.service';
import * as debts from './debts.service';
import { budgetToXlsx, toCsv, toXlsx } from './export';
import * as fx from './fx.service';
import * as loans from './loans.service';
import * as summary from './summary';
import * as transactions from './transactions.service';

const { costCenters, financeCategories: cat } = schema;

/** The general center is stored as 'General' and shown translated, so people search for the translation. */
function namesGeneral(search: string | undefined): boolean {
  const term = search?.toLocaleLowerCase();
  return (
    !!term &&
    LANGUAGES.some(({ code }) => {
      const { costCenterType } = resources[code].enums as { costCenterType: { general: string } };
      return costCenterType.general.toLocaleLowerCase().includes(term);
    })
  );
}

const period = z.object({ from: isoDate.optional(), to: isoDate.optional() });
const reason = z.object({ reason: z.string().trim().min(1).max(300) });
const searchQuery = z.object({ search: z.string().trim().optional() });

const nameI18n = z.object({
  uz: z.string().trim().min(1).max(120),
  ru: z.string().trim().min(1).max(120),
  en: z.string().trim().min(1).max(120),
});

const categoryInput = z.object({
  id: clientId,
  kind: z.enum(CATEGORY_KINDS),
  group: z.enum([...EXPENSE_GROUPS, ...INCOME_GROUPS]),
  key: z.string().trim().regex(/^[a-z0-9_]{2,40}$/),
  name: nameI18n,
});

const categoryPatch = z.object({ name: nameI18n.optional(), active: z.boolean().optional() });

export function registerFinance(app: FastifyInstance) {
  const r = routes(app, 'finance');

  // ─── Lookups (docs/contracts.md): no money, available to any role's forms ───

  r.get('/cost-centers/lookup', {
    access: 'authenticated',
    summary: 'Cost centers for dropdowns',
    query: z.object({ search: z.string().trim().optional(), type: z.enum(COST_CENTER_TYPES).optional() }),
    handler: (req) =>
      tx()
        .select({ id: costCenters.id, name: costCenters.name, type: costCenters.type, refId: costCenters.refId })
        .from(costCenters)
        .where(
          and(
            eq(costCenters.farmId, ctx().farmId),
            eq(costCenters.active, true),
            req.query.type ? eq(costCenters.type, req.query.type) : undefined,
            or(searchAny(req.query.search, [costCenters.name]), namesGeneral(req.query.search) ? eq(costCenters.type, 'general') : undefined),
          ),
        )
        .orderBy(asc(costCenters.type), asc(costCenters.name))
        .limit(50),
  });

  r.get('/categories', {
    access: 'authenticated',
    summary: 'Income and expense categories',
    query: z.object({ kind: z.enum(CATEGORY_KINDS).optional(), includeInactive: z.coerce.boolean().optional() }),
    handler: (req) =>
      tx()
        .select({ id: cat.id, kind: cat.kind, group: cat.group, key: cat.key, name: cat.name, active: cat.active })
        .from(cat)
        .where(
          and(
            eq(cat.tenantId, ctx().tenantId),
            req.query.includeInactive ? undefined : eq(cat.active, true),
            req.query.kind ? eq(cat.kind, req.query.kind) : undefined,
          ),
        )
        .orderBy(asc(cat.kind), asc(cat.group), asc(cat.key)),
  });

  r.post('/categories', {
    access: 'finance.create',
    body: categoryInput,
    handler: async (req, reply) => {
      const { id, ...values } = req.body;
      const isIncomeGroup = (INCOME_GROUPS as readonly string[]).includes(values.group);
      if (isIncomeGroup !== (values.kind === 'income')) {
        throw badRequest('CATEGORY_KIND_MISMATCH', 'This group does not fit the category kind');
      }
      reply.code(201);
      const [row] = await tx()
        .insert(cat)
        .values({ ...(id ? { id } : {}), ...values, tenantId: ctx().tenantId })
        .returning();
      return row;
    },
  });

  r.patch('/categories/:id', {
    access: 'finance.update',
    params: idParam,
    body: categoryPatch,
    handler: async (req) => {
      const [row] = await tx()
        .update(cat)
        .set(req.body)
        .where(and(eq(cat.id, req.params.id), eq(cat.tenantId, ctx().tenantId)))
        .returning();
      if (!row) throw notFound('Category');
      return row;
    },
  });

  // ─── Accounts ───────────────────────────────────────────────────────────────

  r.get('/accounts/lookup', {
    access: 'authenticated',
    summary: 'Accounts for dropdowns, without balances',
    query: searchQuery,
    handler: (req) => accounts.lookup(req.query.search),
  });

  r.get('/accounts', {
    access: 'finance.view',
    summary: 'Accounts with balances',
    query: z.object({ until: isoDate.optional() }),
    handler: (req) => accounts.listWithBalances(req.query.until),
  });

  r.post('/accounts', {
    access: 'finance.create',
    body: accounts.accountInput,
    handler: async (req, reply) => {
      reply.code(201);
      return accounts.create(req.body);
    },
  });

  r.get('/accounts/:id', {
    access: 'finance.view',
    params: idParam,
    handler: (req) => accounts.get(req.params.id),
  });

  r.patch('/accounts/:id', {
    access: 'finance.update',
    params: idParam,
    body: accounts.accountInput.partial(),
    handler: (req) => accounts.update(req.params.id, req.body),
  });

  r.delete('/accounts/:id', {
    access: 'finance.delete',
    params: idParam,
    handler: (req) => accounts.remove(req.params.id),
  });

  r.get('/accounts/:id/daily', {
    access: 'finance.view',
    summary: 'Daily statement of one account',
    params: idParam,
    query: z.object({ from: isoDate, to: isoDate }),
    handler: (req) => accounts.dailyBalance(req.params.id, req.query.from, req.query.to),
  });

  // ─── Transactions ───────────────────────────────────────────────────────────

  r.get('/transactions', {
    access: 'finance.view',
    summary: 'Transaction journal',
    query: transactions.transactionListQuery,
    handler: (req) => transactions.list(req.query),
  });

  r.get('/transactions/totals', {
    access: 'finance.view',
    summary: 'Approved income and expense over the same filters as the journal',
    query: transactions.transactionListQuery,
    handler: (req) => transactions.totals(req.query),
  });

  r.get('/transactions/pending-count', {
    access: 'finance.view',
    handler: () => transactions.pendingCount(),
  });

  r.get('/transactions/export.csv', {
    access: 'finance.view',
    summary: 'Double-entry CSV of approved transactions, for Keeping',
    query: period,
    handler: async (req, reply) => {
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="operatsiyalar.csv"')
        .send(toCsv(await transactions.exportRows(req.query)));
      return reply;
    },
  });

  r.get('/transactions/export.xlsx', {
    access: 'finance.view',
    summary: 'The same export as an Excel workbook',
    query: period,
    handler: async (req, reply) => {
      reply
        .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', 'attachment; filename="operatsiyalar.xlsx"')
        .send(await toXlsx(await transactions.exportRows(req.query)));
      return reply;
    },
  });

  r.post('/transactions', {
    access: 'finance.create',
    body: transactions.transactionInput,
    handler: async (req, reply) => {
      reply.code(201);
      return transactions.create(req.body);
    },
  });

  r.get('/transactions/:id', {
    access: 'finance.view',
    params: idParam,
    handler: (req) => transactions.get(req.params.id),
  });

  r.patch('/transactions/:id', {
    access: 'finance.update',
    summary: 'Change a transaction that is not approved yet',
    params: idParam,
    body: transactions.transactionPatch,
    handler: (req) => transactions.update(req.params.id, req.body),
  });

  r.delete('/transactions/:id', {
    access: 'finance.delete',
    summary: 'Delete a transaction that is not approved yet',
    params: idParam,
    handler: (req) => transactions.remove(req.params.id),
  });

  r.post('/transactions/:id/approve', {
    access: 'finance.approve',
    params: idParam,
    body: transactions.asRead.optional(),
    handler: (req) => transactions.approve(req.params.id, req.body?.baseUpdatedAt),
  });

  r.post('/transactions/:id/reject', {
    access: 'finance.approve',
    params: idParam,
    body: reason.extend(transactions.asRead.shape),
    handler: (req) => transactions.reject(req.params.id, req.body.reason, req.body.baseUpdatedAt),
  });

  r.post('/transactions/:id/void', {
    access: 'finance.approve',
    summary: 'Cancel an approved transaction entered by mistake',
    params: idParam,
    body: reason,
    handler: (req) => transactions.voidTransaction(req.params.id, req.body.reason),
  });

  // ─── Debts ──────────────────────────────────────────────────────────────────

  r.get('/debts', {
    access: 'finance.view',
    summary: 'Open debts by counterparty with aging',
    query: z.object({ direction: z.enum(['payable', 'receivable']).optional() }),
    handler: (req) => debts.listDebts(req.query.direction),
  });

  r.get('/debts/summary', {
    access: 'finance.view',
    handler: () => summary.debtSummary(),
  });

  r.post('/debts/settle', {
    access: 'finance.create',
    summary: 'Record a payment against a debt',
    body: debts.settleInput,
    handler: async (req, reply) => {
      reply.code(201);
      return debts.settle(req.body);
    },
  });

  r.get('/debts/unpaid-receipts', {
    access: 'finance.view',
    summary: 'Purchases received from a supplier with no payment or debt recorded',
    query: listQuery,
    handler: (req) => unpaidReceipts(req.query),
  });

  r.post('/debts/unpaid-receipts/:id/record', {
    access: 'finance.create',
    summary: 'Record one of them as paid or as a debt, linked to the receipt',
    params: idParam,
    body: receiptMoneyInput,
    handler: async (req, reply) => {
      reply.code(201);
      return recordReceiptMoney(req.params.id, req.body);
    },
  });

  // ─── Budget ─────────────────────────────────────────────────────────────────

  r.get('/budget', {
    access: 'finance.view',
    summary: 'Plan and fact by category and month',
    query: budget.budgetQuery,
    handler: (req) => budget.grid(req.query),
  });

  r.get('/budget/export.xlsx', {
    access: 'finance.view',
    summary: 'Plan, fact and totals as an Excel workbook',
    query: budget.budgetQuery,
    handler: async (req, reply) => {
      reply
        .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', 'attachment; filename="byudjet.xlsx"')
        .send(await budgetToXlsx(await budget.grid(req.query)));
      return reply;
    },
  });

  r.put('/budget', {
    access: 'finance.update',
    summary: 'Save plan lines in bulk. Amount 0 removes a line.',
    body: budget.budgetBulkInput,
    handler: (req) => budget.saveEntries(req.body),
  });

  // ─── Exchange rates ─────────────────────────────────────────────────────────

  r.get('/fx-rates', {
    access: 'finance.view',
    query: fx.fxQuery,
    handler: (req) => fx.list(req.query),
  });

  r.put('/fx-rates', {
    access: 'finance.update',
    summary: 'Save the rate for a currency and day',
    body: fx.fxInput,
    handler: (req) => fx.upsert(req.body),
  });

  r.delete('/fx-rates/:date/:currency', {
    access: 'finance.delete',
    params: fx.fxKey,
    handler: (req) => fx.remove(req.params),
  });

  // ─── Loans ──────────────────────────────────────────────────────────────────

  r.get('/loans', {
    access: 'finance.view',
    handler: () => loans.list(),
  });

  r.get('/loans/upcoming', {
    access: 'finance.view',
    summary: 'Instalments due soon, overdue ones included',
    query: z.object({ days: z.coerce.number().int().min(1).max(366).default(30) }),
    handler: (req) => loans.upcoming(req.query.days),
  });

  r.post('/loans', {
    access: 'finance.create',
    summary: 'Create a loan and its schedule',
    body: loans.loanInput,
    handler: async (req, reply) => {
      reply.code(201);
      return loans.create(req.body);
    },
  });

  r.get('/loans/:id', {
    access: 'finance.view',
    params: idParam,
    handler: (req) => loans.get(req.params.id),
  });

  r.patch('/loans/:id', {
    access: 'finance.update',
    params: idParam,
    body: loans.loanPatch,
    handler: (req) => loans.update(req.params.id, req.body),
  });

  r.delete('/loans/:id', {
    access: 'finance.delete',
    params: idParam,
    handler: (req) => loans.remove(req.params.id),
  });

  r.post('/loans/:id/instalments/:instalmentId/pay', {
    access: 'finance.approve',
    summary: 'Pay one instalment: principal, and interest as an expense',
    params: z.object({ id: z.uuid(), instalmentId: z.uuid() }),
    body: loans.payInput,
    handler: (req) => loans.payInstalment(req.params.id, req.params.instalmentId, req.body),
  });

  // ─── Costs and summaries ────────────────────────────────────────────────────

  r.get('/summary/cash', {
    access: 'finance.view',
    handler: () => summary.cashPosition(),
  });

  r.get('/summary/month', {
    access: 'finance.view',
    query: z.object({ month: isoMonth.optional() }),
    handler: (req) => summary.monthToDate(req.query.month),
  });

  r.get('/costs/centers', {
    access: 'finance.view',
    summary: 'Cost, income and profitability per cost center',
    query: period,
    handler: (req) => summary.costCenterCosts(req.query.from, req.query.to),
  });

  r.get('/costs/herds', {
    access: 'finance.view',
    summary: 'Cost per head per herd, plus the farm total',
    handler: async () => {
      const herds = await summary.herdCosts();
      return { herds, total: summary.sumHerds(herds) };
    },
  });

  r.get('/costs/herds/:id', {
    access: 'finance.view',
    params: idParam,
    handler: (req) => summary.herdCost(req.params.id),
  });

  r.get('/costs/fields', {
    access: 'finance.view',
    summary: 'Plan vs fact, yield and cost per ton per crop plan',
    query: z.object({ seasonId: z.uuid().optional() }),
    handler: (req) => summary.fieldCosts(req.query.seasonId),
  });

  r.get('/costs/categories', {
    access: 'finance.view',
    summary: 'Income and expense by category',
    query: period,
    handler: (req) => summary.incomeExpenseByCategory(req.query.from, req.query.to),
  });

  r.get('/cashflow/forecast', {
    access: 'finance.view',
    summary: 'Statistical cash forecast',
    query: z.object({ months: z.coerce.number().int().min(1).max(24).default(12) }),
    handler: (req) => summary.cashflowForecastDetail(req.query.months),
  });

  r.get('/cashflow/actual', {
    access: 'finance.view',
    summary: 'Actual money in and out per month',
    query: period,
    handler: (req) => summary.cashflowActual(req.query.from, req.query.to),
  });
}
