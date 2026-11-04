/**
 * What the assistant can do: read facts through predefined tools. There is no free SQL, no write
 * tool, and a tool the caller may not use is neither offered to the model nor run if requested.
 * Money tools need finance.view, so a shepherd's assistant has none at all (CLAUDE.md rule 7).
 */
import { z, type ZodType } from 'zod';
import { ITEM_CATEGORIES, addDays, monthOf, type Permission } from '@yap/shared';
import { today } from '../../core/context';
import { isoDate, isoMonth } from '../../core/query';
import { openAlerts } from '../alerts/summary';
import { assetStatus } from '../assets/summary';
import { overdueOperations } from '../crops/summary';
import {
  budgetExecution,
  cashPosition,
  cashflowForecast,
  debtSummary,
  fieldCosts,
  herdCost,
  monthToDate,
} from '../finance/summary';
import { attendanceToday } from '../hr/summary';
import { feedBalance } from '../inventory/summary';
import { herdMovement, herdSummary, reproductionKpis } from '../livestock/summary';
import * as facts from './facts';
import type { LlmTool } from './provider';

export interface ToolOutcome {
  data: unknown;
  /** Tables the answer rests on, shown to the user as its source. */
  tables: string[];
  from?: string;
  to?: string;
  rows?: number;
  /** False when the tool ran but found too little to answer from. */
  enoughData?: boolean;
}

export interface AiTool {
  name: string;
  description: string;
  input: ZodType;
  /** The caller needs at least one of these. Empty means any AI user. */
  anyOf: Permission[];
  /** Returns money figures, so it also needs finance.view. */
  money: boolean;
  run(input: never): Promise<ToolOutcome>;
}

function tool<S extends ZodType>(def: {
  name: string;
  description: string;
  input: S;
  anyOf?: Permission[];
  money?: boolean;
  run(input: z.output<S>): Promise<ToolOutcome>;
}): AiTool {
  return { anyOf: [], money: false, ...def, run: def.run as AiTool['run'] };
}

const period = z.object({
  from: isoDate.optional().describe('First day, YYYY-MM-DD. Default: 30 days ago.'),
  to: isoDate.optional().describe('Last day, YYYY-MM-DD. Default: today.'),
});

function resolvePeriod(input: z.output<typeof period>) {
  return { from: input.from ?? addDays(today(), -30), to: input.to ?? today() };
}

export const TOOLS: AiTool[] = [
  tool({
    name: 'herd_summary',
    description: 'Head count of animals on the farm by category and by status (pregnant, sick, quarantine).',
    input: z.object({}),
    anyOf: ['livestock.view'],
    run: async () => {
      const data = await herdSummary();
      return { data, tables: ['animals'], rows: data.total, enoughData: data.total > 0 };
    },
  }),
  tool({
    name: 'herd_movement',
    description: 'Herd count over a period: opening, born, purchased, sold, slaughtered, dead, lost, closing.',
    input: period,
    anyOf: ['livestock.view'],
    run: async (input) => {
      const { from, to } = resolvePeriod(input);
      return { data: await herdMovement(from, to), tables: ['animals', 'animal_exits'], from, to };
    },
  }),
  tool({
    name: 'reproduction_kpis',
    description: 'Lambing percent, lamb survival percent and related breeding figures.',
    input: z.object({}),
    anyOf: ['livestock.view'],
    run: async () => ({
      data: await reproductionKpis(),
      tables: ['breeding_records', 'lambing_records', 'animals'],
    }),
  }),
  tool({
    name: 'lambing_schedule',
    description:
      'Pregnant ewes expected to lamb between two dates: count per day and the ewes by ear tag. Use for "which ewes lamb this week".',
    input: z.object({
      from: isoDate.optional().describe('First day, YYYY-MM-DD. Default: today.'),
      to: isoDate.optional().describe('Last day, YYYY-MM-DD. Default: 7 days from today.'),
    }),
    anyOf: ['livestock.view'],
    run: async (input) => {
      const from = input.from ?? today();
      const to = input.to ?? addDays(from, 7);
      const data = await facts.lambingSchedule(from, to);
      return { data, tables: ['breeding_records', 'animals'], from, to, rows: data.total };
    },
  }),
  tool({
    name: 'mortality_report',
    description: 'Animal deaths over the last N days, with reasons and the percentage of the herd.',
    input: z.object({ days: z.number().int().min(1).max(365).default(30) }),
    anyOf: ['livestock.view'],
    run: async (input) => {
      const data = await facts.mortalitySummary(input.days);
      return { data, tables: ['animal_exits', 'animals'], from: data.from, to: data.to, rows: data.dead };
    },
  }),
  tool({
    name: 'sick_animals',
    description: 'Animals currently sick or in quarantine, by ear tag.',
    input: z.object({}),
    anyOf: ['livestock.view', 'health.view'],
    run: async () => {
      const data = await facts.sickAnimals();
      return { data, tables: ['animals'], rows: data.length };
    },
  }),
  tool({
    name: 'animal_card',
    description: 'One animal by ear tag or other identifier: status, weight, herd, pregnancy, recent health records.',
    input: z.object({ tag: z.string().trim().min(1).max(40).describe('Ear tag, e.g. YA-0123') }),
    anyOf: ['livestock.view'],
    run: async (input) => {
      const data = await facts.animalFacts(input.tag);
      return {
        data,
        tables: ['animals', 'breeding_records', 'health_records'],
        rows: data ? 1 : 0,
        enoughData: data !== null,
      };
    },
  }),
  tool({
    name: 'stock_levels',
    description: 'Warehouse stock by item, with quantities and whether an item is below its minimum.',
    input: z.object({
      category: z.enum(ITEM_CATEGORIES).optional().describe('Limit to one item category.'),
      search: z.string().trim().max(60).optional().describe('Part of the item name.'),
    }),
    anyOf: ['inventory.view', 'feed.view'],
    run: async (input) => {
      const data = await facts.stockLevels(input);
      return { data, tables: ['items', 'stock_batches'], rows: data.length };
    },
  }),
  tool({
    name: 'feed_position',
    description:
      'For each feed: stock, daily need by ration, real daily use over the last 7 days, and how many days it lasts.',
    input: z.object({}),
    anyOf: ['feed.view'],
    run: async () => {
      const data = await feedBalance();
      return {
        data,
        tables: ['items', 'stock_batches', 'stock_movements', 'ration_lines', 'herds'],
        rows: data.length,
      };
    },
  }),
  tool({
    name: 'feed_consumption',
    description: 'Quantities of feed issued in a period, per item. Quantities only.',
    input: period,
    anyOf: ['feed.view'],
    run: async (input) => {
      const { from, to } = resolvePeriod(input);
      const data = await facts.feedConsumption(from, to);
      return { data, tables: ['stock_movements', 'items'], from, to, rows: data.length };
    },
  }),
  tool({
    name: 'fields_overview',
    description: 'Arable fields this season: number, area, crop and plan status.',
    input: z.object({}),
    anyOf: ['crops.view'],
    run: async () => {
      const data = await facts.fieldsOverview();
      return {
        data,
        tables: ['fields', 'crop_plans', 'crops', 'seasons'],
        rows: data.fields.length,
        enoughData: data.fields.length > 0,
      };
    },
  }),
  tool({
    name: 'overdue_tasks',
    description: 'Open tasks past their due date.',
    input: z.object({}),
    anyOf: ['tasks.view'],
    run: async () => {
      const data = await facts.overdueTasks();
      return { data, tables: ['tasks'], rows: data.length };
    },
  }),
  tool({
    name: 'overdue_field_operations',
    description: 'Planned field operations past their date.',
    input: z.object({}),
    anyOf: ['crops.view'],
    run: async () => {
      const data = await overdueOperations();
      return { data, tables: ['field_operations', 'fields'], rows: data.length };
    },
  }),
  tool({
    name: 'open_alerts',
    description: 'Open alerts on the farm, most urgent first.',
    input: z.object({}),
    anyOf: ['dashboard.view'],
    run: async () => {
      // The alerts module applies each alert's own permission, so money alerts stay hidden.
      const rows = await openAlerts(30);
      const data = rows.map(({ ruleKey, severity, title, body, lastSeenAt }) => ({ ruleKey, severity, title, body, lastSeenAt }));
      return { data, tables: ['alerts'], rows: data.length };
    },
  }),
  tool({
    name: 'machinery_status',
    description: 'Machines by status: working, idle, in repair.',
    input: z.object({}),
    anyOf: ['assets.view'],
    run: async () => ({ data: await assetStatus(), tables: ['assets'] }),
  }),
  tool({
    name: 'attendance_today',
    description: 'How many employees are at work today. Counts only.',
    input: z.object({}),
    anyOf: ['hr.view'],
    run: async () => ({ data: await attendanceToday(), tables: ['timesheets', 'employees'] }),
  }),
  tool({
    name: 'recent_findings',
    description: 'Latest statistical findings of the AI analysis, with confidence and decision.',
    input: z.object({}),
    anyOf: ['ai.view'],
    run: async () => {
      const data = await facts.recentInsights();
      return { data, tables: ['ai_insights'], rows: data.length };
    },
  }),

  // ─── Money: needs finance.view on top of the rest ─────────────────────────
  tool({
    name: 'feed_spending',
    description:
      'Money spent on feed in a period: value of feed consumed, and cash paid for feed purchases. Use for "how much did we spend on feed last month".',
    input: period,
    money: true,
    anyOf: ['finance.view'],
    run: async (input) => {
      const { from, to } = resolvePeriod(input);
      const data = await facts.feedSpending(from, to);
      return {
        data,
        tables: ['stock_movements', 'items', 'transactions'],
        from,
        to,
        rows: data.byItem.length,
        enoughData: data.byItem.length > 0 || data.purchased > 0,
      };
    },
  }),
  tool({
    name: 'cash_position',
    description: 'Cash and bank balances per account and in total.',
    input: z.object({}),
    money: true,
    anyOf: ['finance.view'],
    run: async () => {
      const { accounts, total } = await cashPosition();
      const data = { total, accounts: accounts.map(({ id: _id, ...account }) => account) };
      return { data, tables: ['accounts', 'transactions'], rows: accounts.length };
    },
  }),
  tool({
    name: 'income_expense',
    description: 'Income and expense for one month.',
    input: z.object({ month: isoMonth.optional().describe('YYYY-MM. Default: this month.') }),
    money: true,
    anyOf: ['finance.view'],
    run: async (input) => {
      const month = input.month ?? monthOf(today());
      return { data: await monthToDate(month), tables: ['transactions'], from: `${month}-01` };
    },
  }),
  tool({
    name: 'budget_execution',
    description: 'Budget plan against actual by category for a period.',
    input: period,
    money: true,
    anyOf: ['finance.view'],
    run: async (input) => {
      const { from, to } = resolvePeriod(input);
      const data = await budgetExecution(from, to);
      return { data, tables: ['budgets', 'transactions'], from, to, rows: data.rows.length };
    },
  }),
  tool({
    name: 'debt_summary',
    description: 'Totals owed to the farm and by the farm, and the overdue part.',
    input: z.object({}),
    money: true,
    anyOf: ['finance.view'],
    run: async () => ({ data: await debtSummary(), tables: ['transactions', 'counterparties'] }),
  }),
  tool({
    name: 'cashflow_forecast',
    description: 'Statistical cash-flow forecast by month. Months where cash goes negative matter most.',
    input: z.object({ months: z.number().int().min(1).max(12).default(6) }),
    money: true,
    anyOf: ['finance.view'],
    run: async (input) => {
      const data = await cashflowForecast(input.months);
      return { data, tables: ['transactions', 'loan_instalments'], rows: data.length };
    },
  }),
  tool({
    name: 'herd_cost',
    description: 'Current cost per head of a herd, or of all herds: purchase cost plus accumulated feed, vet, labour, overhead.',
    input: z.object({}),
    money: true,
    anyOf: ['finance.view'],
    run: async () => ({
      data: await herdCost(),
      tables: ['animals', 'stock_movements', 'transactions'],
    }),
  }),
  tool({
    name: 'field_costs',
    description: 'Each field: planned and actual cost, deviation, harvest, yield and cost per ton.',
    input: z.object({}),
    money: true,
    anyOf: ['finance.view'],
    run: async () => {
      const rows = await fieldCosts();
      const data = rows.map(({ number, areaHa, crop, planned, actual, deviation, harvestT, yieldTHa, costPerTon }) => ({
        number,
        areaHa,
        crop: crop.uz,
        planned,
        actual,
        deviation,
        harvestT,
        yieldTHa,
        costPerTon,
      }));
      return {
        data,
        tables: ['fields', 'crop_plans', 'stock_movements', 'transactions'],
        rows: data.length,
      };
    },
  }),
];

/** The tools this caller may use. This list is both what the model sees and what can run. */
export function toolsFor(permissions: ReadonlySet<string>): AiTool[] {
  return TOOLS.filter(
    (t) =>
      (t.anyOf.length === 0 || t.anyOf.some((p) => permissions.has(p))) &&
      (!t.money || permissions.has('finance.view')),
  );
}

function schemaOf(input: ZodType): Record<string, unknown> {
  const { $schema: _dropped, ...schema } = z.toJSONSchema(input, { io: 'input' }) as Record<string, unknown>;
  return schema;
}

export const PRESENT_TOOL = 'present_result';

/**
 * Shows a tool result as a table or chart. The model points at a result rather than supplying
 * numbers, so a chart can only ever draw figures that really came from a tool.
 */
export const presentInput = z.object({
  resultId: z.string().describe('The resultId of an earlier tool result in this answer.'),
  kind: z.enum(['table', 'bar', 'line']),
  title: z.string().trim().min(1).max(120).describe("Short title in the user's language."),
  rowsKey: z.string().optional().describe('Which array inside the result, when it holds several.'),
  columns: z.array(z.string()).max(8).optional().describe('Table columns to show. Default: all simple fields.'),
  xKey: z.string().optional().describe('Chart: field for the labels.'),
  yKeys: z.array(z.string()).max(4).optional().describe('Chart: numeric fields to draw.'),
});

export function llmTools(tools: AiTool[]): LlmTool[] {
  return [
    ...tools.map((t) => ({ name: t.name, description: t.description, inputSchema: schemaOf(t.input) })),
    {
      name: PRESENT_TOOL,
      description:
        'Display an earlier tool result to the user as a table or chart below your answer. Use it when several rows are easier to read than prose.',
      inputSchema: schemaOf(presentInput),
    },
  ];
}
