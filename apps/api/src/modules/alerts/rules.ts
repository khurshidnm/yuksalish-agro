/**
 * Alert rules (spec 14.1, 15.3, 17). Each rule reads current state and returns findings, one per
 * problem that holds right now. The engine turns findings into alerts: a new finding raises one, a
 * repeated finding refreshes it, a finding that has disappeared resolves it. Running the engine
 * twice therefore changes nothing.
 *
 * A failing rule is isolated by a savepoint, so one broken module cannot silence the alerts of
 * another. Figures with an owner, like days of feed, come from that module's own function.
 */
import { safeError } from '../../core/errors';
import { and, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import {
  ANIMAL_ON_FARM_STATUSES,
  addDays,
  budgetExecutionPercent,
  deviationPercent,
  monthOf,
  monthRange,
  mortalityPercent,
  round,
  type Permission,
  type RoleKey,
  type Severity,
} from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, today, tx } from '../../core/context';
import type { TenantSettings } from '../../core/settings';
import { feedBalance } from '../feed/balance.service';
import { tr, type Params } from '../notifications/i18n';
import { raiseAlert } from './alerts.service';

const { alerts } = schema;

export interface Finding {
  dedupKey: string;
  severity: Severity;
  params: Params;
  link: string;
  /** Wording other than the rule's own: an expired document is not "expiring". Same alert, new text. */
  textKey?: string;
  entityType?: string;
  entityId?: string;
}

interface RuleContext {
  farmId: string;
  today: string;
  settings: TenantSettings;
}

interface Rule {
  key: string;
  /** Set when the finding reveals money or financial work. */
  permission?: Permission;
  notify?: RoleKey[];
  run(r: RuleContext): Promise<Finding[]>;
}

const onFarm = sql.raw(`(${ANIMAL_ON_FARM_STATUSES.map((s) => `'${s}'`).join(', ')})`);

async function query<T>(statement: SQL): Promise<T[]> {
  const result = await tx().execute(statement);
  return result.rows as T[];
}

const num = (value: unknown): number => Number(value ?? 0);

export const RULES: Rule[] = [
  {
    key: 'feed_low',
    // feedBalance is the figure the Feed page shows, so the alert and the page cannot disagree.
    async run() {
      const findings: Finding[] = [];
      for (const row of await feedBalance()) {
        if (row.days === null || row.days >= row.minDays) continue;
        findings.push({
          dedupKey: `feed_low:${row.itemId}`,
          severity: row.days < row.minDays / 2 ? 'urgent' : 'attention',
          params: { item: row.name, days: Math.floor(row.days), minimum: row.minDays },
          link: '/feed/balance',
          entityType: 'item',
          entityId: row.itemId,
        });
      }
      return findings;
    },
  },
  {
    key: 'stock_low',
    async run(r) {
      const rows = await query<{ id: string; name: string; unit: string; min_qty: string; qty: string }>(sql`
        select i.id, i.name, i.unit, i.min_qty, coalesce(sum(b.qty_remaining), 0) as qty
        from items i
        left join stock_batches b on b.item_id = i.id and b.farm_id = i.farm_id
        where i.farm_id = ${r.farmId} and i.active and i.min_qty is not null
        group by i.id
        having coalesce(sum(b.qty_remaining), 0) < i.min_qty`);
      return rows.map((row) => ({
        dedupKey: `stock_low:${row.id}`,
        severity: 'attention' as const,
        params: { item: row.name, qty: num(row.qty), minimum: num(row.min_qty), unit: row.unit },
        link: '/inventory/stock',
        entityType: 'item',
        entityId: row.id,
      }));
    },
  },
  {
    // Scenario 2 of spec 15.3. Yesterday is included because the morning alert is about yesterday.
    key: 'ration_deviation',
    async run(r) {
      const from = addDays(r.today, -1);
      const rows = await query<{ herd_id: string; herd: string; date: string; planned: string; actual: string }>(sql`
        select d.herd_id, h.name as herd, d.date::text as date,
               sum(l.planned_qty) as planned, sum(l.actual_qty) as actual
        from daily_logs d
        join daily_log_lines l on l.log_id = d.id
        join herds h on h.id = d.herd_id
        where d.farm_id = ${r.farmId} and d.date >= ${from}::date
        group by d.herd_id, h.name, d.date
        having sum(l.planned_qty) > 0`);
      const threshold = r.settings.feed.deviationPercent;
      const findings: Finding[] = [];
      for (const row of rows) {
        const deviation = deviationPercent(num(row.actual), num(row.planned));
        if (deviation === null || Math.abs(deviation) < threshold) continue;
        findings.push({
          dedupKey: `ration_deviation:${row.herd_id}:${row.date}`,
          severity: Math.abs(deviation) >= threshold * 2 ? 'urgent' : 'attention',
          params: { herd: row.herd, date: row.date, percent: round(deviation, 1), actual: num(row.actual), planned: num(row.planned) },
          link: '/livestock/daily-logs',
          entityType: 'herd',
          entityId: row.herd_id,
        });
      }
      return findings;
    },
  },
  {
    key: 'lambing_soon',
    async run(r) {
      const to = addDays(r.today, 7);
      const [row] = await query<{ n: string; first: string | null }>(sql`
        select count(*) as n, min(expected_date)::text as first
        from breeding_records
        where farm_id = ${r.farmId} and status = 'pregnant'
          and expected_date between ${r.today}::date and ${to}::date`);
      if (num(row.n) === 0) return [];
      const soon = row.first! <= addDays(r.today, 2);
      return [
        {
          dedupKey: 'lambing_soon',
          severity: soon ? 'attention' : 'info',
          params: { count: num(row.n), date: row.first },
          link: '/livestock/breeding',
        },
      ];
    },
  },
  {
    key: 'lambing_overdue',
    async run(r) {
      const [row] = await query<{ n: string }>(sql`
        select count(*) as n from breeding_records
        where farm_id = ${r.farmId} and status = 'pregnant' and expected_latest < ${r.today}::date`);
      if (num(row.n) === 0) return [];
      return [{ dedupKey: 'lambing_overdue', severity: 'attention', params: { count: num(row.n) }, link: '/livestock/breeding' }];
    },
  },
  {
    // Counts animals whose vaccination is not current, which covers never done and expired alike.
    key: 'vaccination_overdue',
    async run(r) {
      const rows = await query<{ id: string; name: string; mandatory: boolean; n: string }>(sql`
        select p.id, p.name, p.mandatory, count(a.id) as n
        from vaccination_plans p
        join animals a
          on a.farm_id = p.farm_id
         and a.status in ${onFarm}
         and (p.species_id is null or a.species_id = p.species_id)
         and (p.category is null or a.category = p.category)
         and (p.age_days is null or a.birth_date is null or a.birth_date + p.age_days <= ${r.today}::date)
        where p.farm_id = ${r.farmId} and p.active
          and not exists (
            select 1 from health_records h
            where h.farm_id = p.farm_id
              and (h.vaccination_plan_id = p.id or (p.item_id is not null and h.item_id = p.item_id))
              and (h.animal_id = a.id or (h.animal_id is null and h.herd_id = a.herd_id))
              and (p.interval_days is null or h.date + p.interval_days >= ${r.today}::date)
          )
        group by p.id, p.name, p.mandatory`);
      return rows.map((row) => ({
        dedupKey: `vaccination_overdue:${row.id}`,
        severity: row.mandatory ? ('attention' as const) : ('info' as const),
        params: { plan: row.name, count: num(row.n) },
        link: '/livestock/health',
      }));
    },
  },
  {
    key: 'sick_animals',
    async run(r) {
      const [row] = await query<{ sick: string; total: string }>(sql`
        select count(*) filter (where status = 'sick') as sick, count(*) as total
        from animals where farm_id = ${r.farmId} and status in ${onFarm}`);
      const sick = num(row.sick);
      if (sick === 0) return [];
      const share = (sick / num(row.total)) * 100;
      return [
        {
          dedupKey: 'sick_animals',
          severity: share >= 2 ? 'urgent' : 'attention',
          params: { count: sick },
          link: '/livestock/health',
        },
      ];
    },
  },
  {
    key: 'quarantine_animals',
    async run(r) {
      const [row] = await query<{ n: string }>(sql`
        select count(*) as n from animals where farm_id = ${r.farmId} and status = 'quarantine'`);
      if (num(row.n) === 0) return [];
      return [{ dedupKey: 'quarantine_animals', severity: 'info', params: { count: num(row.n) }, link: '/livestock/health' }];
    },
  },
  {
    key: 'quarantine_ended',
    async run(r) {
      const [row] = await query<{ n: string }>(sql`
        select count(*) as n from animals
        where farm_id = ${r.farmId} and status = 'quarantine' and quarantine_until < ${r.today}::date`);
      if (num(row.n) === 0) return [];
      return [{ dedupKey: 'quarantine_ended', severity: 'attention', params: { count: num(row.n) }, link: '/livestock/health' }];
    },
  },
  {
    key: 'mortality_spike',
    async run(r) {
      const windowStart = addDays(r.today, -30);
      const previousStart = addDays(r.today, -60);
      const [row] = await query<{ dead: string; previous: string; head: string }>(sql`
        select
          count(*) filter (where e.date > ${windowStart}::date) as dead,
          count(*) filter (where e.date <= ${windowStart}::date) as previous,
          (select count(*) from animals a where a.farm_id = ${r.farmId} and a.status in ${onFarm}) as head
        from animal_exits e
        where e.farm_id = ${r.farmId} and e.type = 'death' and e.date > ${previousStart}::date`);
      const dead = num(row.dead);
      const previous = num(row.previous);
      // Three deaths is the smallest number that says more than chance on a farm of this size.
      if (dead < 3) return [];
      const percent = mortalityPercent(dead, num(row.head) + dead / 2);
      const spike = (percent !== null && percent >= 2) || dead >= 2 * Math.max(previous, 1);
      if (!spike) return [];
      return [
        {
          dedupKey: 'mortality_spike',
          severity: percent !== null && percent >= 5 ? 'urgent' : 'attention',
          params: { count: dead, percent: percent === null ? null : round(percent, 1), previous },
          link: '/livestock/exits',
        },
      ];
    },
  },
  {
    key: 'budget_overrun',
    permission: 'finance.view',
    async run(r) {
      const month = monthOf(r.today);
      const { from, to } = monthRange(month);
      const rows = await query<{ id: string; name: unknown; planned: string; actual: string }>(sql`
        with plan as (
          select category_id, sum(amount) as planned from budgets
          where farm_id = ${r.farmId} and month = ${month} group by category_id
        ), fact as (
          select category_id, sum(amount_base) as actual from transactions
          where farm_id = ${r.farmId} and status = 'approved' and type = 'expense'
            and date between ${from}::date and ${to}::date
          group by category_id
        )
        select c.id, c.name, p.planned, coalesce(f.actual, 0) as actual
        from plan p
        join finance_categories c on c.id = p.category_id
        left join fact f on f.category_id = p.category_id
        where p.planned > 0 and coalesce(f.actual, 0) > p.planned`);
      return rows.map((row) => {
        const percent = budgetExecutionPercent(num(row.actual), num(row.planned))!;
        return {
          dedupKey: `budget_overrun:${row.id}:${month}`,
          severity: percent >= 120 ? ('urgent' as const) : ('attention' as const),
          params: { category: row.name, percent: round(percent, 1), month },
          link: '/finance/budget',
        };
      });
    },
  },
  {
    key: 'tasks_overdue',
    async run(r) {
      const [row] = await query<{ n: string }>(sql`
        select count(*) as n from tasks
        where farm_id = ${r.farmId} and status in ('open', 'in_progress')
          and recurrence = 'none' and due_date < ${r.today}::date`);
      if (num(row.n) === 0) return [];
      return [{ dedupKey: 'tasks_overdue', severity: 'attention', params: { count: num(row.n) }, link: '/tasks' }];
    },
  },
  {
    key: 'operations_overdue',
    async run(r) {
      const [row] = await query<{ n: string; first: string | null }>(sql`
        select count(*) as n, min(date)::text as first from field_operations
        where farm_id = ${r.farmId} and status = 'planned' and date < ${r.today}::date`);
      if (num(row.n) === 0) return [];
      return [
        {
          dedupKey: 'operations_overdue',
          severity: 'attention',
          params: { count: num(row.n), date: row.first },
          link: '/crops/operations',
        },
      ];
    },
  },
  {
    key: 'document_expiring',
    async run(r) {
      const to = addDays(r.today, 30);
      const rows = await query<{ id: string; title: string; expiry_date: string }>(sql`
        select id, title, expiry_date::text as expiry_date from documents
        where farm_id = ${r.farmId} and expiry_date <= ${to}::date`);
      return rows.map((row) => ({
        dedupKey: `document_expiring:${row.id}`,
        severity: row.expiry_date < r.today ? ('urgent' as const) : ('attention' as const),
        textKey: row.expiry_date < r.today ? 'document_expired' : undefined,
        params: { title: row.title, date: row.expiry_date },
        link: '/farm/documents',
        entityType: 'document',
        entityId: row.id,
      }));
    },
  },
  {
    key: 'contract_expiring',
    permission: 'finance.view',
    async run(r) {
      const to = addDays(r.today, 30);
      const rows = await query<{ id: string; number: string; end_date: string; counterparty: string }>(sql`
        select c.id, c.number, c.end_date::text as end_date, p.name as counterparty
        from contracts c join counterparties p on p.id = c.counterparty_id
        where c.farm_id = ${r.farmId} and c.status = 'active' and c.end_date <= ${to}::date`);
      return rows.map((row) => ({
        dedupKey: `contract_expiring:${row.id}`,
        severity: 'attention' as const,
        params: { number: row.number, counterparty: row.counterparty, date: row.end_date },
        link: '/sales',
        entityType: 'contract',
        entityId: row.id,
      }));
    },
  },
  {
    key: 'batch_expiring',
    async run(r) {
      const to = addDays(r.today, 30);
      const rows = await query<{ id: string; item: string; expiry_date: string; qty: string; unit: string }>(sql`
        select b.id, i.name as item, b.expiry_date::text as expiry_date, b.qty_remaining as qty, i.unit
        from stock_batches b join items i on i.id = b.item_id
        where b.farm_id = ${r.farmId} and b.qty_remaining > 0 and b.expiry_date <= ${to}::date`);
      return rows.map((row) => ({
        dedupKey: `batch_expiring:${row.id}`,
        severity: row.expiry_date < r.today ? ('urgent' as const) : ('attention' as const),
        textKey: row.expiry_date < r.today ? 'batch_expired' : undefined,
        params: { item: row.item, date: row.expiry_date, qty: num(row.qty), unit: row.unit },
        link: '/inventory/stock',
        entityType: 'stock_batch',
        entityId: row.id,
      }));
    },
  },
  {
    key: 'approvals_pending',
    permission: 'finance.approve',
    async run(r) {
      const [row] = await query<{ n: string }>(sql`
        select count(*) as n from transactions where farm_id = ${r.farmId} and status = 'pending'`);
      if (num(row.n) === 0) return [];
      return [{ dedupKey: 'approvals_pending', severity: 'attention', params: { count: num(row.n) }, link: '/finance/transactions' }];
    },
  },
  {
    key: 'loan_payment_due',
    permission: 'finance.view',
    async run(r) {
      const to = addDays(r.today, 7);
      const rows = await query<{ id: string; name: string; due_date: string }>(sql`
        select i.id, l.name, i.due_date::text as due_date
        from loan_instalments i join loans l on l.id = i.loan_id
        where i.farm_id = ${r.farmId} and i.paid_date is null and i.due_date <= ${to}::date`);
      return rows.map((row) => ({
        dedupKey: `loan_payment_due:${row.id}`,
        severity: row.due_date < r.today ? ('urgent' as const) : ('attention' as const),
        textKey: row.due_date < r.today ? 'loan_payment_overdue' : undefined,
        params: { loan: row.name, date: row.due_date },
        link: '/finance/loans',
      }));
    },
  },
  {
    key: 'maintenance_due',
    async run(r) {
      const to = addDays(r.today, 7);
      const rows = await query<{ id: string; asset_id: string; name: string; due: string }>(sql`
        select m.id, m.asset_id, a.name, m.next_due_date::text as due
        from maintenance_records m join assets a on a.id = m.asset_id
        where m.farm_id = ${r.farmId} and m.next_due_date <= ${to}::date and a.status <> 'written_off'
          and not exists (
            select 1 from maintenance_records later
            where later.asset_id = m.asset_id and later.date > m.date
          )`);
      return rows.map((row) => ({
        dedupKey: `maintenance_due:${row.asset_id}`,
        severity: row.due < r.today ? ('attention' as const) : ('info' as const),
        textKey: row.due < r.today ? 'maintenance_overdue' : undefined,
        params: { asset: row.name, date: row.due },
        link: `/assets/${row.asset_id}`,
        entityType: 'asset',
        entityId: row.asset_id,
      }));
    },
  },
  {
    key: 'camera_offline',
    // The devices.offline-check job sets the status from each device's own offlineAfterMinutes, and
    // raises under the same dedup key, so this rule and that job make one alert per outage.
    async run(r) {
      const rows = await query<{ id: string; name: string }>(sql`
        select id, name from devices
        where farm_id = ${r.farmId} and type = 'camera' and status = 'offline'`);
      return rows.map((row) => ({
        dedupKey: `camera_offline:${row.id}`,
        severity: 'attention' as const,
        params: { camera: row.name },
        link: '/cameras',
        entityType: 'device',
        entityId: row.id,
      }));
    },
  },
];

export interface EvaluationResult {
  raised: number;
  refreshed: number;
  escalated: number;
  resolved: number;
  failedRules: string[];
}

export async function evaluateRules(): Promise<EvaluationResult> {
  const c = ctx();
  const context: RuleContext = { farmId: c.farmId, today: today(), settings: c.settings };
  const result: EvaluationResult = { raised: 0, refreshed: 0, escalated: 0, resolved: 0, failedRules: [] };
  const seen = new Set<string>();

  for (const rule of RULES) {
    let findings: Finding[];
    try {
      // A savepoint: a rule that throws must not abort the shared transaction for the rest.
      findings = await tx().transaction(() => rule.run(context));
    } catch (err) {
      result.failedRules.push(rule.key);
      console.error(`[alerts] rule ${rule.key} failed`, safeError(err));
      continue;
    }
    for (const finding of findings) {
      seen.add(finding.dedupKey);
      const text = finding.textKey ?? rule.key;
      const raised = await raiseAlert({
        ruleKey: rule.key,
        dedupKey: finding.dedupKey,
        severity: finding.severity,
        title: tr('uz', 'alerts', `rules.${text}.title`, finding.params),
        body: tr('uz', 'alerts', `rules.${text}.body`, finding.params),
        link: finding.link,
        entityType: finding.entityType,
        entityId: finding.entityId,
        data: finding.textKey ? { ...finding.params, textKey: finding.textKey } : finding.params,
        notify: rule.notify,
        permission: rule.permission,
      });
      if (raised.created) result.raised++;
      else if (raised.escalated) result.escalated++;
      else result.refreshed++;
    }
  }

  // A rule that failed tells us nothing, so its alerts stay as they are.
  const evaluated = RULES.map((r) => r.key).filter((key) => !result.failedRules.includes(key));
  const unresolved = await tx()
    .select({ id: alerts.id, dedupKey: alerts.dedupKey })
    .from(alerts)
    .where(
      and(
        eq(alerts.farmId, c.farmId),
        eq(alerts.source, 'rule'),
        ne(alerts.status, 'resolved'),
        inArray(alerts.ruleKey, evaluated),
      ),
    );
  const gone = unresolved.filter((a) => !seen.has(a.dedupKey)).map((a) => a.id);
  if (gone.length > 0) {
    await tx()
      .update(alerts)
      .set({ status: 'resolved', resolvedAt: new Date(), nextNotifyAt: null })
      .where(inArray(alerts.id, gone));
    result.resolved = gone.length;
  }
  return result;
}
