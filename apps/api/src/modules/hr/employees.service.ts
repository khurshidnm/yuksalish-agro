import { and, asc, eq, gte, isNull, lte, ne, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { EMPLOYEE_STATUSES, PAY_TYPES, PII_VIEW, type Permission } from '@yap/shared';
import { PIECE_UNITS } from '@yap/shared/formulas/payroll';
import { schema } from '../../db/client';
import { ctx, hasPermission, today, tx } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { recordEvent } from '../../core/journal';
import { hidePii } from '../../core/privacy';
import { clientId, isoDate, listQuery, paged, searchAny, sortBy } from '../../core/query';
import { blockMember, unblockMember } from '../settings/users.service';
import { loginForPhone } from './login-link.service';

const { divisions, employees: t, herds, memberships, roles, users } = schema;

export type Employee = typeof t.$inferSelect;

const money = z.number().min(0).max(1_000_000_000_000);

export const employeeInput = z.object({
  id: clientId,
  fullName: z.string().trim().min(2).max(160),
  position: z.string().trim().min(1).max(120),
  division: z.string().trim().max(60).nullish(),
  phone: z.string().trim().max(30).nullish(),
  passport: z.string().trim().max(30).nullish(),
  hireDate: isoDate,
  payType: z.enum(PAY_TYPES),
  baseRate: money,
  pieceRates: z.partialRecord(z.enum(PIECE_UNITS), money).optional(),
  userId: z.uuid().nullish(),
  herdId: z.uuid().nullish(),
  contractFileId: z.uuid().nullish(),
  contractEndDate: isoDate.nullish(),
  medicalCheckDate: isoDate.nullish(),
  notes: z.string().max(1000).nullish(),
});
export type EmployeeInput = z.infer<typeof employeeInput>;

export const employeePatch = employeeInput.omit({ id: true }).partial().extend({
  /** 'terminated' is reached only through the termination flow. */
  status: z.enum(['active', 'on_leave']).optional(),
});
export type EmployeePatch = z.infer<typeof employeePatch>;

export const employeeListQuery = listQuery.extend({
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  division: z.string().optional(),
  payType: z.enum(PAY_TYPES).optional(),
});

export const terminateInput = z.object({
  date: isoDate,
  reason: z.string().trim().max(500).nullish(),
  /** The login to end, chosen by hand when the record has none and no phone matches one. */
  userId: z.uuid().nullish(),
});

const canSeePii = () => hasPermission(PII_VIEW);

/** Pay rates are personal data and money at once, so they need both (CLAUDE.md rules 7 and 8). */
const canSeeRates = () =>
  canSeePii() && (hasPermission('finance.view' as Permission) || hasPermission('payroll.view' as Permission));

function protect(rows: Employee[]): Employee[] {
  const visible = hidePii(rows, ['phone', 'passport']);
  if (canSeeRates()) return visible;
  return visible.map((row) => ({ ...row, baseRate: null, pieceRates: null }) as unknown as Employee);
}

/** Employed for at least one day of the range. */
export function employedDuring(from: string, to: string): SQL {
  return and(lte(t.hireDate, to), or(isNull(t.terminationDate), gte(t.terminationDate, from)))!;
}

export async function getRow(id: string): Promise<Employee> {
  const [row] = await tx().select().from(t).where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  if (!row) throw notFound('Employee');
  return row;
}

async function assertLinks(input: Pick<Partial<EmployeeInput>, 'userId' | 'herdId'>): Promise<void> {
  const { farmId } = ctx();
  if (input.userId) {
    const [member] = await tx()
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, input.userId), eq(memberships.farmId, farmId)));
    if (!member) throw badRequest('USER_NOT_ON_FARM', 'This login does not belong to this farm');
  }
  if (input.herdId) {
    const [herd] = await tx()
      .select({ id: herds.id })
      .from(herds)
      .where(and(eq(herds.id, input.herdId), eq(herds.farmId, farmId)));
    if (!herd) throw badRequest('HERD_NOT_FOUND', 'This herd does not belong to this farm');
  }
}

function assertSeasonal(payType: string, contractEndDate: string | null | undefined): void {
  if (payType === 'seasonal' && !contractEndDate) {
    throw badRequest('SEASON_END_REQUIRED', 'A seasonal contract needs an end date');
  }
}

function assertMayChangeRates(input: Partial<EmployeeInput>): void {
  if (!canSeeRates() && (input.baseRate !== undefined || input.pieceRates !== undefined)) {
    throw forbidden('You cannot change pay rates', 'RATES_NOT_ALLOWED');
  }
}

export async function list(q: z.infer<typeof employeeListQuery>) {
  const where = and(
    eq(t.farmId, ctx().farmId),
    q.status ? eq(t.status, q.status) : undefined,
    q.division ? eq(t.division, q.division) : undefined,
    q.payType ? eq(t.payType, q.payType) : undefined,
    // Only people who can see phone numbers may search by them.
    searchAny(q.search, canSeePii() ? [t.fullName, t.position, t.phone] : [t.fullName, t.position]),
  );
  const page = await paged(q, t, where, (limit, offset) =>
    tx()
      .select()
      .from(t)
      .where(where)
      .orderBy(
        ...sortBy(
          q.sort,
          { fullName: t.fullName, position: t.position, hireDate: t.hireDate, status: t.status },
          asc(t.fullName),
          t.id,
        ),
      )
      .limit(limit)
      .offset(offset),
  );
  return { ...page, data: protect(page.data) };
}

/**
 * Staff for dropdowns. Open to any signed-in user because forms in other modules need it, but a
 * read-only outsider such as an investor gets positions instead of names (spec section 5).
 */
export async function lookup(search: string | undefined) {
  const rows = await tx()
    .select({ id: t.id, name: t.fullName, position: t.position, userId: t.userId })
    .from(t)
    .where(and(eq(t.farmId, ctx().farmId), ne(t.status, 'terminated'), searchAny(search, [t.fullName, t.position])))
    .orderBy(asc(t.fullName))
    .limit(50);
  const works = (['hr.view', 'crops.create', 'livestock.create', 'health.create', 'inventory.create', 'tasks.update'] as Permission[]).some(
    hasPermission,
  );
  return canSeePii() || works ? rows : rows.map((r) => ({ ...r, name: r.position, userId: null }));
}

export async function get(id: string) {
  const [row] = protect([await getRow(id)]);
  return row;
}

export async function createEmployee(input: EmployeeInput) {
  const c = ctx();
  assertSeasonal(input.payType, input.contractEndDate);
  assertMayChangeRates(input);
  await assertLinks(input);
  const { id, ...values } = input;
  const userId = values.userId ?? (await loginForPhone(values.phone));
  const [row] = await tx()
    .insert(t)
    .values({ ...(id ? { id } : {}), ...values, userId, tenantId: c.tenantId, farmId: c.farmId, createdBy: c.userId })
    .returning();
  await recordEvent({
    type: 'employee.hired',
    entityType: 'employee',
    entityId: row.id,
    occurredAt: row.hireDate,
    data: { position: row.position },
  });
  return protect([row])[0];
}

export async function updateEmployee(id: string, input: EmployeePatch) {
  const existing = await getRow(id);
  if (existing.status === 'terminated' && input.status) {
    throw conflict('EMPLOYEE_TERMINATED', 'Reinstate this person first');
  }
  assertSeasonal(input.payType ?? existing.payType, input.contractEndDate === undefined ? existing.contractEndDate : input.contractEndDate);
  assertMayChangeRates(input);
  await assertLinks(input);
  // Clearing a link on purpose stays cleared: only a record that has none picks one up.
  const found = !existing.userId && !input.userId && input.phone ? await loginForPhone(input.phone) : null;
  const [row] = await tx()
    .update(t)
    .set(found ? { ...input, userId: found } : input)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)))
    .returning();
  return protect([row])[0];
}

/** Only a person with no records can be deleted. Anyone else is terminated, so history stays. */
export async function deleteEmployee(id: string) {
  await getRow(id);
  await tx()
    .delete(t)
    .where(and(eq(t.id, id), eq(t.farmId, ctx().farmId)));
  return { id };
}

/**
 * The person leaves: login stops at once, and everything they entered stays (spec 5.1). This goes
 * through the same block as the users page, so someone who may not block this person cannot
 * dismiss them either, and the whole dismissal is refused. Only the membership of this farm is
 * blocked: a job at another farm or tenant is untouched. `accessEnded` says what really happened,
 * and it is what the screen reports.
 */
export async function terminate(id: string, input: z.infer<typeof terminateInput>) {
  const c = ctx();
  const employee = await getRow(id);
  if (employee.status === 'terminated') throw conflict('ALREADY_TERMINATED', 'This person has already left');
  if (input.date < employee.hireDate) throw badRequest('TERMINATION_BEFORE_HIRE', 'The last day is before the hire date');
  // Blocking is immediate, so a future date would cut access too early.
  if (input.date > today()) throw badRequest('TERMINATION_IN_FUTURE', 'Enter the termination on the last working day');
  await assertLinks({ userId: input.userId });

  const userId = employee.userId ?? input.userId ?? (await loginForPhone(employee.phone));
  const [row] = await tx()
    .update(t)
    .set({ status: 'terminated', terminationDate: input.date, userId })
    .where(and(eq(t.id, id), eq(t.farmId, c.farmId)))
    .returning();
  const accessEnded = userId ? await endAccess(userId) : false;
  await recordEvent({
    type: 'employee.terminated',
    entityType: 'employee',
    entityId: id,
    occurredAt: input.date,
    data: { reason: input.reason ?? null, accessEnded },
  });
  return { ...protect([row])[0], accessEnded };
}

/** Whether a login on this farm is now blocked. One blocked before counts: it has no access either way. */
async function endAccess(userId: string): Promise<boolean> {
  const [member] = await tx()
    .select({ id: memberships.id, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.farmId, ctx().farmId)));
  if (!member) return false;
  if (member.status !== 'blocked') await blockMember(member.id);
  return true;
}

/** Undo a termination, for a mistake or a rehire. */
export async function reinstate(id: string) {
  const c = ctx();
  const employee = await getRow(id);
  if (employee.status !== 'terminated') throw conflict('NOT_TERMINATED', 'This person has not left');
  const [row] = await tx()
    .update(t)
    .set({ status: 'active', terminationDate: null })
    .where(and(eq(t.id, id), eq(t.farmId, c.farmId)))
    .returning();
  if (employee.userId) {
    const [member] = await tx()
      .select({ id: memberships.id, status: memberships.status })
      .from(memberships)
      .where(and(eq(memberships.userId, employee.userId), eq(memberships.farmId, c.farmId)));
    if (member?.status === 'blocked') await unblockMember(member.id);
  }
  await recordEvent({ type: 'employee.reinstated', entityType: 'employee', entityId: id });
  return protect([row])[0];
}

/** Farm logins, with the employee each is linked to, for the link field of the employee form. */
export async function linkableUsers() {
  const { farmId } = ctx();
  const rows = await tx()
    .select({
      id: users.id,
      fullName: users.fullName,
      phone: users.phone,
      roleKey: roles.key,
      employeeId: t.id,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .leftJoin(t, and(eq(t.userId, users.id), eq(t.farmId, farmId)))
    .where(and(eq(memberships.farmId, farmId), eq(memberships.status, 'active')))
    .orderBy(asc(users.fullName));
  return hidePii(rows, ['phone']);
}

export function listDivisions() {
  return tx()
    .select({ key: divisions.key, name: divisions.name })
    .from(divisions)
    .where(eq(divisions.farmId, ctx().farmId))
    .orderBy(asc(divisions.name));
}

/** The employee record of the signed-in user at this farm, if any. */
export async function findSelf(): Promise<Employee | undefined> {
  const { userId, farmId } = ctx();
  if (!userId) return undefined;
  const [row] = await tx()
    .select()
    .from(t)
    .where(and(eq(t.userId, userId), eq(t.farmId, farmId)));
  return row;
}
