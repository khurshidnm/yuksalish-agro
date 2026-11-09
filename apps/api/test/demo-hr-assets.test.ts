import { describe, expect, it } from 'vitest';
import { createFixture, type Client } from './helpers';

/** September 2026: 30 days, Sundays on the 6th, 13th, 20th and 27th, so 26 working days. */
const MONTH = '2026-09';

async function hire(owner: Client) {
  const res = await owner.post('/hr/employees', {
    fullName: 'Ulugbek Nazarov',
    position: "Cho'pon",
    hireDate: '2026-01-01',
    payType: 'monthly',
    baseRate: 5_200_000,
  });
  expect(res.status).toBe(201);
  return res.data as { id: string };
}

describe('payroll runs (demo audit)', () => {
  it('a second run for a month is refused with the run that exists, so the app can open it', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await hire(owner);
    const first = await owner.post('/hr/payroll', { month: MONTH });
    expect(first.status).toBe(201);

    const twice = await owner.post('/hr/payroll', { month: MONTH });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('ALREADY_EXISTS');
    expect(twice.body.error.details).toEqual({ month: MONTH, runId: first.data.id });

    // Still exactly one run for the month.
    const list = await owner.get('/hr/payroll');
    expect(list.data.filter((run: { month: string }) => run.month === MONTH)).toHaveLength(1);
  });

  it('the slip basis says which paid days were sick and which were leave (control numbers)', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const e = await hire(owner);
    const filled = await owner.post('/hr/timesheets/bulk', { from: '2026-09-01', to: '2026-09-30', employeeIds: [e.id], status: 'present', sundaysOff: true });
    expect(filled.status).toBe(200);
    for (const [date, status] of [
      ['2026-09-14', 'sick'],
      ['2026-09-15', 'sick'],
      ['2026-09-16', 'vacation'],
    ] as const) {
      const res = await owner.put(`/hr/timesheets/${e.id}/${date}`, { status });
      expect(res.status).toBe(200);
    }

    const run = await owner.post('/hr/payroll', { month: MONTH });
    expect(run.status).toBe(201);
    const line = run.data.lines.find((l: { employeeId: string }) => l.employeeId === e.id);
    // 26 working days: 23 present, 2 sick, 1 on leave. A monthly wage pays all 26, so the full 5 200 000.
    expect(line.daysWorked).toBe(23);
    expect(line.basis).toMatchObject({ presentDays: 23, paidDays: 26, sickDays: 2, vacationDays: 1, expectedDays: 26, employedDays: 30, daysInMonth: 30 });
    expect(line.base).toBe(5_200_000);
  });
});
