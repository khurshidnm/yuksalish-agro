/**
 * Scheduled delivery of saved reports (spec 14.2). The job runs as the system, which may see
 * everything, so each recipient's report is built with that recipient's own permissions. A saved
 * report with salary columns reaches a shepherd without them, or not at all.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { diffDays, todayIso } from '@yap/shared';
import { schema } from '../../db/client';
import { ctx, today, tx, updateCtx } from '../../core/context';
import { AppError } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { notifyUser } from '../notifications/notify.service';
import { canRun, periodLine, runReport } from './engine';
import { displayCell } from './export';
import { resolveLang, t } from './i18n';
import { REPORTS_BY_KEY } from './registry';
import type { SavedConfig, SavedRow } from './saved.service';
import type { ReportResult, ResultColumn } from './types';

const { memberships, roles, savedReports, users } = schema;

const MESSAGE_ROWS = 8;
const VALUES_PER_ROW = 2;
/** Telegram refuses messages over 4096 characters. */
const MESSAGE_LIMIT = 3500;

const isValue = (c: ResultColumn) => ['money', 'number', 'integer', 'percent'].includes(c.type);

/** A readable summary: the first rows and the totals, with a link to the rest. */
export function reportMessage(result: ReportResult): string {
  const { lang, columns, rows, totals } = result;
  const labels = columns.filter((c) => !isValue(c)).slice(0, 2);
  const values = columns.filter(isValue).slice(0, VALUES_PER_ROW);
  const lines: string[] = [];
  const period = periodLine(result);
  if (period) lines.push(period);

  for (const row of rows.slice(0, MESSAGE_ROWS)) {
    const name = labels.map((c) => displayCell(c, row[c.key], lang)).join(' · ');
    const figures = values.map((c) => displayCell(c, row[c.key], lang)).join(' / ');
    lines.push(`• ${[name, figures].filter(Boolean).join(': ')}`);
  }
  if (result.rowCount > MESSAGE_ROWS) lines.push(t(lang, 'delivery.more', { count: result.rowCount - MESSAGE_ROWS }));
  if (rows.length === 0) lines.push(t(lang, 'delivery.empty'));

  if (totals) {
    const summed = columns.filter((c) => c.key in totals).slice(0, 3);
    const parts = summed.map((c) => `${c.label}: ${displayCell(c, totals[c.key], lang)}`);
    if (parts.length) lines.push(`${t(lang, 'export.total')} — ${parts.join(', ')}`);
  }
  return lines.join('\n').slice(0, MESSAGE_LIMIT);
}

/** True on the day a schedule fires, unless it has already been sent that day. */
export function isDue(schedule: string | null, lastSentAt: Date | null, date: string, timezone: string): boolean {
  if (!schedule) return false;
  if (lastSentAt && diffDays(todayIso(timezone, lastSentAt), date) < 1) return false;
  const utc = new Date(`${date}T00:00:00Z`);
  if (schedule === 'weekly') return utc.getUTCDay() === 1; // Monday
  if (schedule === 'monthly') return utc.getUTCDate() === 1;
  return schedule === 'daily';
}

export function reportLink(saved: Pick<SavedRow, 'id' | 'reportKey'>): string {
  return `/reports/${saved.reportKey}?saved=${saved.id}`;
}

export function savedRunOptions(config: SavedConfig) {
  return { raw: config.filters ?? {}, columns: config.columns, groupBy: config.groupBy ?? undefined };
}

/** Build and send one saved report to each of its recipients. Returns how many received it. */
export async function deliverSaved(saved: SavedRow): Promise<number> {
  const def = REPORTS_BY_KEY.get(saved.reportKey);
  if (!def || saved.recipients.length === 0) return 0;
  const c = ctx();
  const members = await tx()
    .select({ userId: memberships.userId, permissions: roles.permissions, locale: users.locale })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.farmId, c.farmId),
        eq(memberships.status, 'active'),
        eq(users.status, 'active'),
        inArray(memberships.userId, saved.recipients),
      ),
    );

  const permissions = c.permissions;
  let sent = 0;
  try {
    for (const member of members) {
      updateCtx({ permissions: new Set(member.permissions) });
      if (!canRun(def)) continue;
      const lang = resolveLang(member.locale);
      let result: ReportResult;
      try {
        result = await runReport(def, { ...savedRunOptions(saved.config as SavedConfig), lang });
      } catch (err) {
        // One recipient's refused report must not stop the others. Real failures still surface.
        if (err instanceof AppError) continue;
        throw err;
      }
      await notifyUser(member.userId, {
        severity: 'info',
        title: saved.name,
        body: reportMessage(result),
        link: reportLink(saved),
        // The event type selects the channels: 'daily_summary' reaches Telegram, 'alert_info' stays in-app.
        eventType: saved.channels.includes('telegram') ? 'daily_summary' : 'alert_info',
      });
      sent += 1;
    }
  } finally {
    updateCtx({ permissions });
  }
  await tx().update(savedReports).set({ lastSentAt: new Date() }).where(eq(savedReports.id, saved.id));
  await recordEvent({ type: 'report.delivered', entityType: 'saved_report', entityId: saved.id, data: { recipients: sent } });
  return sent;
}

export async function deliverDueReports(): Promise<{ delivered: number; recipients: number }> {
  const c = ctx();
  const date = today();
  const rows = await tx()
    .select()
    .from(savedReports)
    .where(and(eq(savedReports.farmId, c.farmId), isNotNull(savedReports.schedule)));
  let delivered = 0;
  let recipients = 0;
  for (const saved of rows) {
    if (!isDue(saved.schedule, saved.lastSentAt, date, c.timezone)) continue;
    recipients += await deliverSaved(saved);
    delivered += 1;
  }
  return { delivered, recipients };
}
