import { eq } from 'drizzle-orm';
import { addDays, todayIso, type RoleKey } from '@yap/shared';
import { hoursBetween } from '@yap/shared/formulas/payroll';
import { schema } from '../db/client';
import { ctx, tx } from '../core/context';
import { approveRun, createAdvance, createKpiRule, createRun } from '../modules/hr/payroll.service';
import { findAccount, findEmployee, findHerd } from './lookup';
import { SEED } from './names';
import type { SeedContext } from './types';

const { employees, safetyInstructions, timesheets } = schema;

type EmployeeRow = typeof employees.$inferInsert;

interface Person extends Pick<EmployeeRow, 'fullName' | 'position' | 'division' | 'hireDate' | 'payType' | 'baseRate'> {
  role?: RoleKey;
  phone: string;
  passport: string;
  pieceRates?: Record<string, number>;
  contractEndDate?: string;
  medicalCheckDate?: string;
}

const P = SEED.position;

/**
 * Full staff of the pilot farm. Names and documents are fictional. Pay is at rural Bukhara levels
 * and adds up to the salary line of the 2026/27 budget in seed/finance.ts.
 */
const PEOPLE: Person[] = [
  { role: 'director', fullName: 'Bahodir Rahimov', position: P.director, division: 'admin', phone: '+998900000002', passport: 'AD0000102', hireDate: '2026-08-01', payType: 'monthly', baseRate: 5_000_000 },
  { role: 'accountant', fullName: 'Nodira Karimova', position: P.accountant, division: 'admin', phone: '+998900000003', passport: 'AD0000103', hireDate: '2026-08-01', payType: 'monthly', baseRate: 3_500_000 },
  { role: 'agronomist', fullName: 'Sardor Toshev', position: P.agronomist, division: 'crops', phone: '+998900000004', passport: 'AD0000104', hireDate: '2026-08-15', payType: 'monthly', baseRate: 4_000_000, contractEndDate: '2027-08-14' },
  { role: 'zootechnician', fullName: 'Jasur Ergashev', position: P.zootechnician, division: 'livestock', phone: '+998900000005', passport: 'AD0000105', hireDate: '2026-09-01', payType: 'monthly', baseRate: 4_000_000, medicalCheckDate: '2027-03-01' },
  { role: 'veterinarian', fullName: 'Dilshod Olimov', position: P.veterinarian, division: 'livestock', phone: '+998900000006', passport: 'AD0000106', hireDate: '2026-09-01', payType: 'monthly', baseRate: 3_500_000, pieceRates: { head: 500 } },
  { role: 'storekeeper', fullName: 'Rustam Sobirov', position: P.storekeeper, division: 'admin', phone: '+998900000007', passport: 'AD0000107', hireDate: '2026-09-01', payType: 'monthly', baseRate: 2_500_000, contractEndDate: '2026-11-25' },
  { role: 'mechanic', fullName: 'Akmal Qodirov', position: P.mechanic, division: 'machinery', phone: '+998900000008', passport: 'AD0000108', hireDate: '2026-08-15', payType: 'monthly', baseRate: 3_000_000, pieceRates: { ha: 15_000 } },
  { fullName: 'Otabek Hamroyev', position: P.mechanic, division: 'machinery', phone: '+998900000021', passport: 'AD0000121', hireDate: '2026-11-01', payType: 'piece', baseRate: 0, pieceRates: { ha: 45_000 } },
  { role: 'shepherd', fullName: 'Sherzod Boboyev', position: P.shepherd, division: 'livestock', phone: '+998900000009', passport: 'AD0000109', hireDate: '2026-10-15', payType: 'monthly', baseRate: 2_200_000, medicalCheckDate: '2026-11-20' },
  { fullName: "Ulug'bek Nazarov", position: P.shepherd, division: 'livestock', phone: '+998900000022', passport: 'AD0000122', hireDate: '2026-10-15', payType: 'monthly', baseRate: 2_200_000 },
  { fullName: 'Farhod Jumayev', position: P.shepherd, division: 'livestock', phone: '+998900000023', passport: 'AD0000123', hireDate: '2026-10-20', payType: 'daily', baseRate: 90_000 },
  { fullName: 'Temur Sattorov', position: P.shepherd, division: 'livestock', phone: '+998900000024', passport: 'AD0000124', hireDate: '2026-10-20', payType: 'seasonal', baseRate: 13_200_000, contractEndDate: '2027-04-20' },
  { fullName: 'Ilhom Murodov', position: P.guard, division: 'admin', phone: '+998900000025', passport: 'AD0000125', hireDate: '2026-08-01', payType: 'monthly', baseRate: 2_000_000 },
];

/** Exceptions to a normal working day, by employee name and date. */
const EXCEPTIONS: Record<string, Record<string, 'sick' | 'absent' | 'vacation'>> = {
  'Nodira Karimova': { '2026-10-12': 'vacation', '2026-10-13': 'vacation', '2026-10-14': 'vacation' },
  "Ulug'bek Nazarov": { '2026-10-27': 'sick', '2026-10-28': 'sick' },
  'Ilhom Murodov': { '2026-10-19': 'absent' },
  'Farhod Jumayev': { '2026-11-02': 'absent' },
};

const isSunday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() === 0;

/** Same inputs always give the same small variation, so reseeding is reproducible. */
const wiggle = (seed: number, range: number) => (seed * 7919) % range;

function timesheetRows(people: { id: string; fullName: string; hireDate: string; position: string }[]) {
  const c = ctx();
  const today = todayIso();
  const rows: (typeof timesheets.$inferInsert)[] = [];
  people.forEach((person, personIndex) => {
    const start = person.hireDate > '2026-10-01' ? person.hireDate : '2026-10-01';
    let dayIndex = 0;
    for (let date = start; date <= today; date = addDays(date, 1)) {
      dayIndex += 1;
      const base = { tenantId: c.tenantId, farmId: c.farmId, employeeId: person.id, date };
      const exception = EXCEPTIONS[person.fullName]?.[date];
      if (exception) {
        rows.push({ ...base, status: exception });
        continue;
      }
      if (isSunday(date)) {
        rows.push({ ...base, status: 'day_off' });
        continue;
      }
      // The demo shepherd has not checked in yet today, so the check-in card has something to do.
      if (date === today && person.position === P.shepherd) continue;

      const seed = personIndex * 31 + dayIndex;
      const checkIn = new Date(`${date}T08:${String(wiggle(seed, 30)).padStart(2, '0')}:00+05:00`);
      const checkOut = date === today ? null : new Date(`${date}T18:${String(wiggle(seed + 1, 30)).padStart(2, '0')}:00+05:00`);
      const located = date >= '2026-11-01';
      rows.push({
        ...base,
        status: 'present',
        // October was filled in by hand from the paper timesheet, November by self check-in.
        hours: located ? hoursBetween(checkIn, checkOut) : 9,
        checkIn: located ? checkIn : null,
        checkOut: located ? checkOut : null,
        lat: located ? 39.5 + wiggle(seed, 40) / 10_000 : null,
        lng: located ? 64.8 + wiggle(seed + 2, 40) / 10_000 : null,
      });
    }
  });
  return rows;
}

export async function seedHr(s: SeedContext): Promise<void> {
  const people = await s.run(async () => {
    const inserted = await tx()
      .insert(employees)
      .values(
        PEOPLE.map(({ role, ...person }) => ({
          ...person,
          tenantId: s.tenantId,
          farmId: s.farmId,
          createdBy: s.users.owner,
          userId: role ? s.users[role] : null,
        })),
      )
      .returning();

    await tx().insert(timesheets).values(timesheetRows(inserted));

    const safety = inserted.flatMap((person) => [
      {
        tenantId: s.tenantId,
        farmId: s.farmId,
        employeeId: person.id,
        title: "Mehnat muhofazasi bo'yicha yo'riqnoma",
        signedOn: person.hireDate,
        validUntil: addDays(person.hireDate, 365),
      },
    ]);
    await tx().insert(safetyInstructions).values(safety);
    const mechanics = inserted.filter((p) => p.position === P.mechanic);
    await tx()
      .insert(safetyInstructions)
      .values(
        mechanics.map((person) => ({
          tenantId: s.tenantId,
          farmId: s.farmId,
          employeeId: person.id,
          title: 'Texnika xavfsizligi',
          signedOn: '2025-11-20',
          // Renewal falls due this month, so the reminders list shows it.
          validUntil: '2026-11-20',
        })),
      );
    return inserted;
  });

  await s.run(async () => {
    await createKpiRule({
      name: "Qo'zilar saqlanishi",
      metric: 'survival_percent',
      position: P.shepherd,
      threshold: 90,
      rewardType: 'fixed',
      amount: 800_000,
    });
    await createKpiRule({
      name: 'Bajarilgan gektar',
      metric: 'hectares',
      position: P.mechanic,
      threshold: 30,
      rewardType: 'per_unit',
      amount: 10_000,
    });
  }, 'accountant');

}

/**
 * After the livestock step, because a shepherd's wage reaches the herd through the employee's herd.
 * October is approved and posted, and left unpaid so that wages show as a payable to settle. No field
 * work is logged yet at this step, so the other wages land on the general cost center. The piece-rate
 * mechanic joined in November, so he has no line that would show zero pay for October.
 */
export async function seedPayroll(s: SeedContext): Promise<void> {
  await s.run(async () => {
    const herd = await findHerd(SEED.herd.pregnant);
    await tx().update(schema.employees).set({ herdId: herd.id }).where(eq(schema.employees.position, P.shepherd));
  });
  const run = await s.run(() => createRun({ month: '2026-10' }), 'accountant');
  await s.run(() => approveRun(run.id), 'director');

  const shepherd = await s.run(() => findEmployee(P.shepherd));
  await s.run(async () => {
    const cash = await findAccount(SEED.account.cash);
    await createAdvance({
      employeeId: shepherd.id,
      date: addDays(todayIso(), -1),
      amount: 1_000_000,
      accountId: cash.id,
      notes: "Avans so'rovi bo'yicha",
    });
  }, 'accountant');
}
