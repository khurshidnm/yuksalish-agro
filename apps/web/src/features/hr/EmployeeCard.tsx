import { monthRange } from '@yap/shared';
import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EMPLOYEE_STATUS_VARIANT, currentMonth, type Employee } from './shared';
import { MoneyText } from '@/components';
import { Badge, Sheet, SheetContent, SheetDescription, SheetTitle, Skeleton } from '@/components/ui';
import { formatDate, formatNumber, formatPercent, formatQty } from '@/lib/format';
import { useDetail } from '@/lib/query';

interface GridPerson {
  id: string;
  totals: { present: number; absent: number; sick: number; vacation: number; dayOff: number; hours: number };
  attendancePercent: number | null;
}

interface SafetyRow {
  id: string;
  title: string;
  signedOn: string | null;
  validUntil: string | null;
}

interface WorkRow {
  hectares: number;
  tons: number;
  headTreated: number;
  headDays: number;
  operations: number;
}

function Facts({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.map(([label, value], i) => (
        <Fragment key={i}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 text-right break-words">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

export interface EmployeeCardProps {
  employee: Employee | null;
  onOpenChange: (open: boolean) => void;
}

/** One person's record: employment, this month's attendance and work, safety briefings. */
export function EmployeeCard({ employee, onOpenChange }: EmployeeCardProps) {
  const { t } = useTranslation('hr');
  const month = currentMonth();
  const { from, to } = monthRange(month);
  const open = employee !== null;

  const grid = useDetail<{ employees: GridPerson[] }>(open ? '/hr/timesheets' : null, { month });
  const work = useDetail<WorkRow[]>(open ? '/hr/work-done' : null, { from, to, employeeId: employee?.id });
  const safety = useDetail<SafetyRow[]>(open ? '/hr/safety' : null, { employeeId: employee?.id });

  const attendance = grid.data?.employees.find((p) => p.id === employee?.id);
  const done = work.data?.[0];
  const rates = Object.entries(employee?.pieceRates ?? {});

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto p-4">
        {employee && (
          <div className="flex flex-col gap-5">
            <header className="pr-10">
              <SheetTitle className="text-lg font-semibold">{employee.fullName}</SheetTitle>
              <SheetDescription className="text-sm text-muted-foreground">{employee.position}</SheetDescription>
              <Badge className="mt-2" variant={EMPLOYEE_STATUS_VARIANT[employee.status]}>
                {t(`enums:employeeStatus.${employee.status}`)}
              </Badge>
            </header>

            <Section title={t('card.employment')}>
              <Facts
                items={[
                  [t('employees.fields.phone'), employee.phone ?? '—'],
                  [t('employees.fields.passport'), employee.passport ?? '—'],
                  [t('employees.fields.hireDate'), formatDate(employee.hireDate)],
                  ...(employee.terminationDate
                    ? ([[t('employees.fields.terminationDate'), formatDate(employee.terminationDate)]] as [ReactNode, ReactNode][])
                    : []),
                  [t('employees.fields.contractEnd'), formatDate(employee.contractEndDate)],
                  [t('employees.fields.medicalCheck'), formatDate(employee.medicalCheckDate)],
                  [t('card.login'), employee.userId ? t('card.loginLinked') : t('card.loginNone')],
                ]}
              />
            </Section>

            <Section title={t('employees.sections.pay')}>
              <Facts
                items={[
                  [t('employees.fields.payType'), t(`enums:payType.${employee.payType}`)],
                  ...(employee.payType === 'piece'
                    ? []
                    : ([[t(`employees.rate.${employee.payType}`), <MoneyText key="rate" value={employee.baseRate} />]] as [ReactNode, ReactNode][])),
                  ...rates.map(
                    ([unit, rate]) => [t(`employees.pieceUnit.${unit}`), <MoneyText key={unit} value={rate} />] as [ReactNode, ReactNode],
                  ),
                ]}
              />
            </Section>

            <Section title={t('card.thisMonth')}>
              {grid.isLoading || work.isLoading ? (
                <Skeleton className="h-24" />
              ) : (
                <Facts
                  items={[
                    [t('card.daysPresent'), attendance?.totals.present ?? 0],
                    [t('card.daysAbsent'), attendance?.totals.absent ?? 0],
                    [t('card.daysSick'), attendance?.totals.sick ?? 0],
                    [t('card.attendance'), formatPercent(attendance?.attendancePercent)],
                    [t('workDone.fields.hectares'), formatQty(done?.hectares ?? 0, t('units.ha'))],
                    [t('workDone.fields.headTreated'), formatNumber(done?.headTreated ?? 0, 0)],
                  ]}
                />
              )}
            </Section>

            <Section title={t('safety.title')}>
              {safety.isLoading ? (
                <Skeleton className="h-16" />
              ) : safety.data?.length ? (
                <ul className="flex flex-col gap-2 text-sm">
                  {safety.data.map((row) => (
                    <li key={row.id} className="rounded-lg border border-border p-2">
                      <p className="font-medium">{row.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('safety.signedUntil', { signed: formatDate(row.signedOn), until: formatDate(row.validUntil) })}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('safety.none')}</p>
              )}
            </Section>

            {employee.notes && (
              <Section title={t('employees.fields.notes')}>
                <p className="text-sm whitespace-pre-wrap">{employee.notes}</p>
              </Section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
