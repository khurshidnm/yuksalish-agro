import { TIMESHEET_STATUSES, monthRange, todayIso } from '@yap/shared';
import { CalendarCheck, CalendarDays, ChevronDown, MapPin, UserCheck, UserX } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { DateField, EmptyState, ErrorCard, FormDialog, FormField, FormGrid, NumberField, PageHeader, SelectField, StatCard, SwitchField, TextareaField, useConfirm, useUrlParam } from '@/components';
import { Alert, Button, Card, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDate, formatNumber, formatPercent } from '@/lib/format';
import { zDate, zEnum, zOptionalNumber, zOptionalText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { cn } from '@/lib/utils';
import { MonthSwitcher, currentMonth, formatTime } from './shared';

type Status = (typeof TIMESHEET_STATUSES)[number];

interface DayCell {
  id: string;
  status: Status;
  hours: number | null;
  checkIn: string | null;
  checkOut: string | null;
  lat: number | null;
  lng: number | null;
  notes: string | null;
}

interface Totals {
  present: number;
  absent: number;
  sick: number;
  vacation: number;
  dayOff: number;
  hours: number;
}

interface Person {
  id: string;
  fullName: string;
  position: string;
  hireDate: string;
  terminationDate: string | null;
  days: Record<string, DayCell | undefined>;
  totals: Totals;
  attendancePercent: number | null;
}

interface Grid {
  month: string;
  days: string[];
  employees: Person[];
  totals: Totals & { attendancePercent: number | null };
  closed: boolean;
}

const PATH = '/hr/timesheets';
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

const STATUS_CLASS: Record<Status, string> = {
  present: 'bg-success-soft text-success',
  absent: 'bg-danger-soft text-danger',
  sick: 'bg-warning-soft text-warning',
  vacation: 'bg-info-soft text-info',
  day_off: 'bg-muted text-muted-foreground',
};

const dayOfMonth = (date: string) => Number(date.slice(8));
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

function isEmployed(person: Person, date: string): boolean {
  return date >= person.hireDate && (!person.terminationDate || date <= person.terminationDate);
}

function Legend() {
  const { t } = useTranslation('hr');
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {TIMESHEET_STATUSES.map((status) => (
        <li key={status} className="flex items-center gap-1.5">
          <span className={cn('flex size-5 items-center justify-center rounded font-semibold', STATUS_CLASS[status])}>{t(`timesheet.short.${status}`)}</span>
          {t(`enums:timesheetStatus.${status}`)}
        </li>
      ))}
    </ul>
  );
}

interface CellTarget {
  person: Person;
  date: string;
}

interface CellProps extends CellTarget {
  onOpen: (target: CellTarget) => void;
  /** Open empty days too. Without edit rights only filled days have something to show. */
  editable: boolean;
  className?: string;
  children?: ReactNode;
}

function DayButton({ person, date, onOpen, editable, className, children }: CellProps) {
  const { t } = useTranslation('hr');
  const cell = person.days[date];
  const employed = isEmployed(person, date);
  const status = cell?.status;
  const label = t('timesheet.cellLabel', {
    name: person.fullName,
    date: formatDate(date),
    status: status ? t(`enums:timesheetStatus.${status}`) : t('timesheet.notMarked'),
  });

  if (!employed) return <span aria-hidden className={cn('rounded opacity-40', className)} />;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={!cell && !editable}
      onClick={() => onOpen({ person, date })}
      className={cn(
        'focus-ring flex items-center justify-center rounded font-semibold transition-opacity hover:opacity-80 disabled:hover:opacity-100',
        status ? STATUS_CLASS[status] : 'border border-dashed border-border text-muted-foreground',
        className,
      )}
    >
      {children ?? (status ? t(`timesheet.short.${status}`) : '')}
    </button>
  );
}

function DesktopGrid({ grid, editable, onOpen }: { grid: Grid; editable: boolean; onOpen: (target: CellTarget) => void }) {
  const { t } = useTranslation('hr');
  return (
    <Card className="hidden overflow-x-auto md:block">
      {/* Sized so a 31-day month fits beside the sidebar on a 1280 px screen. */}
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th scope="col" className="sticky left-0 z-10 w-40 min-w-40 border-b border-border bg-card px-3 py-2 text-left font-medium">
              {t('employees.fields.fullName')}
            </th>
            {grid.days.map((date) => (
              <th key={date} scope="col" className={cn('border-b border-border px-px py-2 text-center font-medium tabular-nums', weekday(date) === 0 && 'text-destructive')}>
                {dayOfMonth(date)}
              </th>
            ))}
            <th scope="col" title={t('card.daysPresent')} className="border-b border-border px-1.5 py-2 text-right font-medium">
              {t('timesheet.short.present')}
            </th>
            <th scope="col" title={t('card.daysAbsent')} className="border-b border-border px-1.5 py-2 text-right font-medium">
              {t('timesheet.short.absent')}
            </th>
            <th scope="col" className="border-b border-border px-2 py-2 text-right font-medium">
              %
            </th>
          </tr>
        </thead>
        <tbody>
          {grid.employees.map((person) => (
            <tr key={person.id}>
              <th scope="row" className="sticky left-0 z-10 border-b border-border bg-card px-3 py-1.5 text-left font-normal">
                <span className="block max-w-36 truncate text-sm font-medium">{person.fullName}</span>
                <span className="block max-w-36 truncate text-muted-foreground">{person.position}</span>
              </th>
              {grid.days.map((date) => (
                <td key={date} className="border-b border-border px-px py-1.5">
                  <DayButton person={person} date={date} editable={editable} onOpen={onOpen} className="mx-auto size-5 text-[11px]" />
                </td>
              ))}
              <td className="border-b border-border px-1.5 text-right tabular-nums">{person.totals.present}</td>
              <td className="border-b border-border px-1.5 text-right tabular-nums">{person.totals.absent}</td>
              <td className="border-b border-border px-2 text-right whitespace-nowrap tabular-nums">{formatPercent(person.attendancePercent, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** On a phone the grid would need sideways scrolling, so each person is a card with a month calendar. */
function PersonCard({ person, grid, editable, onOpen }: { person: Person; grid: Grid; editable: boolean; onOpen: (target: CellTarget) => void }) {
  const { t } = useTranslation('hr');
  const [open, setOpen] = useState(false);
  const leadingBlanks = (weekday(grid.days[0]) + 6) % 7;
  const totalsLabel = t('timesheet.personTotals', { present: person.totals.present, absent: person.totals.absent });

  return (
    <Card>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="focus-ring flex min-h-14 w-full items-center justify-between gap-3 rounded-xl p-3 text-left"
      >
        <span className="min-w-0">
          <span className="block truncate font-medium">{person.fullName}</span>
          <span className="block truncate text-sm text-muted-foreground">{person.position}</span>
        </span>
        {/* The legend's letters say what each number counts; the sentence is for screen readers and a long press. */}
        <span className="flex shrink-0 items-center gap-2 text-sm tabular-nums" title={totalsLabel}>
          <span className="sr-only">{totalsLabel}</span>
          <span aria-hidden className="text-success">
            {t('timesheet.short.present')} {person.totals.present}
          </span>
          {person.totals.absent > 0 && (
            <span aria-hidden className="text-danger">
              {t('timesheet.short.absent')} {person.totals.absent}
            </span>
          )}
          <ChevronDown className={cn('size-5 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
        </span>
      </button>
      {open && (
        <div className="border-t border-border p-3">
          <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
            {WEEKDAYS.map((day) => (
              <span key={day} className={cn('py-1', day === 'sun' && 'text-destructive')}>
                {t(`timesheet.weekday.${day}`)}
              </span>
            ))}
            {Array.from({ length: leadingBlanks }, (_, i) => (
              <span key={i} />
            ))}
            {grid.days.map((date) => (
              <DayButton key={date} person={person} date={date} editable={editable} onOpen={onOpen} className="min-h-11 text-sm">
                {dayOfMonth(date)}
              </DayButton>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function ShiftFacts({ cell }: { cell: DayCell }) {
  const { t } = useTranslation('hr');
  if (!cell.checkIn) return null;
  const hasLocation = cell.lat !== null && cell.lng !== null;
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm">
      <p>{t('timesheet.shift', { from: formatTime(cell.checkIn), to: formatTime(cell.checkOut) })}</p>
      {hasLocation && (
        <a
          href={`https://www.openstreetmap.org/?mlat=${cell.lat}&mlon=${cell.lng}#map=16/${cell.lat}/${cell.lng}`}
          target="_blank"
          rel="noreferrer"
          className="focus-ring inline-flex min-h-11 items-center gap-1 rounded text-primary underline-offset-4 hover:underline md:min-h-0"
        >
          <MapPin className="size-4" aria-hidden />
          {t('timesheet.showOnMap')}
        </a>
      )}
    </div>
  );
}

const daySchema = z.object({
  status: zEnum(TIMESHEET_STATUSES),
  hours: zOptionalNumber(),
  notes: zOptionalText(300),
});

function DayDialog({ target, onClose }: { target: CellTarget | null; onClose: () => void }) {
  const { t } = useTranslation('hr');
  const confirm = useConfirm();
  const url = target ? `${PATH}/${target.person.id}/${target.date}` : '';
  const cell = target?.person.days[target.date];

  const save = useApiMutation<z.output<typeof daySchema>>({
    mutationFn: (values) => api.put(url, values),
    invalidate: [PATH],
    silentError: true,
  });
  const clear = useApiMutation({
    mutationFn: () => api.delete(url),
    invalidate: [PATH],
    onSuccess: onClose,
  });

  return (
    <FormDialog
      open={target !== null}
      onOpenChange={(open) => !open && onClose()}
      title={target?.person.fullName}
      description={target && formatDate(target.date)}
      schema={daySchema}
      defaultValues={{ status: cell?.status ?? 'present', hours: cell?.hours ?? null, notes: cell?.notes ?? '' }}
      onSubmit={(values) => save.mutateAsync(values)}
      size="sm"
    >
      {(form) => (
        <>
          {cell && <ShiftFacts cell={cell} />}
          <FormField form={form} name="status" label={t('timesheet.status')}>
            {(field) => (
              <div role="radiogroup" aria-label={t('timesheet.status')} className="grid grid-cols-2 gap-2">
                {TIMESHEET_STATUSES.map((status) => (
                  <button
                    key={status}
                    type="button"
                    role="radio"
                    aria-checked={field.value === status}
                    onClick={() => field.onChange(status)}
                    className={cn(
                      'focus-ring min-h-12 rounded-lg border border-border px-3 text-sm font-medium transition-colors',
                      field.value === status ? cn(STATUS_CLASS[status], 'border-transparent ring-2 ring-ring') : 'bg-card hover:bg-muted',
                    )}
                  >
                    {t(`enums:timesheetStatus.${status}`)}
                  </button>
                ))}
              </div>
            )}
          </FormField>
          {form.watch('status') === 'present' && <NumberField form={form} name="hours" label={t('timesheet.hours')} suffix={t('units.hour')} maxDigits={2} />}
          <TextareaField form={form} name="notes" label={t('timesheet.notes')} rows={2} />
          {cell && (
            <Button
              variant="ghost"
              className="self-start text-destructive"
              loading={clear.isPending}
              onClick={async () => {
                const ok = await confirm({ title: t('timesheet.clearTitle'), destructive: true });
                if (ok) clear.mutate();
              }}
            >
              {t('timesheet.clear')}
            </Button>
          )}
        </>
      )}
    </FormDialog>
  );
}

/** For people who may look but not change, or for a closed month. */
function DayView({ target, onClose }: { target: CellTarget | null; onClose: () => void }) {
  const { t } = useTranslation('hr');
  const cell = target?.person.days[target.date];
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{target?.person.fullName}</DialogTitle>
          <DialogDescription>{target && formatDate(target.date)}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3 text-sm">
          {cell ? (
            <>
              <p>
                {t(`enums:timesheetStatus.${cell.status}`)}
                {cell.hours !== null && ` · ${t('timesheet.hoursValue', { hours: formatNumber(cell.hours, 1) })}`}
              </p>
              <ShiftFacts cell={cell} />
              {cell.notes && <p className="text-muted-foreground">{cell.notes}</p>}
            </>
          ) : (
            <p className="text-muted-foreground">{t('timesheet.notMarked')}</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common:actions.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const bulkSchema = z.object({
  from: zDate(),
  to: zDate(),
  status: zEnum(TIMESHEET_STATUSES),
  hours: zOptionalNumber(),
  sundaysOff: z.boolean(),
  overwrite: z.boolean(),
});

function BulkDialog({ month, open, onOpenChange }: { month: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('hr');
  const { from, to } = monthRange(month);
  const today = todayIso();

  const fill = useApiMutation<z.output<typeof bulkSchema>, { written: number }>({
    mutationFn: (values) => api.post(`${PATH}/bulk`, values),
    invalidate: [PATH],
    silentError: true,
    onSuccess: ({ written }) => toast.success(t('timesheet.bulk.done', { count: written })),
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('timesheet.bulk.title')}
      description={t('timesheet.bulk.description')}
      schema={bulkSchema}
      defaultValues={{ from, to: to < today ? to : today, status: 'present', hours: null, sundaysOff: true, overwrite: false }}
      onSubmit={(values) => fill.mutateAsync(values)}
      submitLabel={t('timesheet.bulk.submit')}
    >
      {(form) => (
        <>
          <FormGrid>
            <DateField form={form} name="from" label={t('timesheet.bulk.from')} required />
            <DateField form={form} name="to" label={t('timesheet.bulk.to')} required />
            <SelectField form={form} name="status" label={t('timesheet.status')} required options={enumOptions('timesheetStatus', TIMESHEET_STATUSES)} />
            <NumberField form={form} name="hours" label={t('timesheet.hours')} suffix={t('units.hour')} maxDigits={2} />
          </FormGrid>
          <SwitchField form={form} name="sundaysOff" label={t('timesheet.bulk.sundaysOff')} />
          <SwitchField form={form} name="overwrite" label={t('timesheet.bulk.overwrite')} hint={t('timesheet.bulk.overwriteHint')} />
        </>
      )}
    </FormDialog>
  );
}

export default function TimesheetPage() {
  const { t } = useTranslation('hr');
  const can = useCan();
  const [month, setMonth] = useUrlParam('month', currentMonth());
  const [search, setSearch] = useUrlParam('q');
  const [target, setTarget] = useState<CellTarget | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const grid = useDetail<Grid>(PATH, { month, search: search || undefined });
  const editable = (can('hr.update') || can('payroll.update')) && !grid.data?.closed;
  const canFill = editable && !grid.isLoading;
  const totals = grid.data?.totals;

  return (
    <>
      <PageHeader
        title={t('timesheet.title')}
        description={t('timesheet.description')}
        actions={
          <>
            <MonthSwitcher value={month} onChange={setMonth} />
            {canFill && (
              <Button onClick={() => setBulkOpen(true)}>
                <CalendarCheck aria-hidden />
                {t('timesheet.bulk.open')}
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('timesheet.stats.attendance')} value={formatPercent(totals?.attendancePercent)} hint={t('timesheet.stats.attendanceHint')} icon={UserCheck} tone="success" loading={grid.isLoading} />
        {/* Summed over everyone, so the unit is person-days: 13 people for 9 days can make 86. */}
        <StatCard
          label={t('timesheet.stats.present')}
          value={formatNumber(totals?.present ?? 0, 0)}
          hint={grid.data ? t('timesheet.stats.peopleHint', { count: grid.data.employees.length }) : undefined}
          icon={CalendarDays}
          loading={grid.isLoading}
        />
        <StatCard label={t('timesheet.stats.absent')} value={formatNumber(totals?.absent ?? 0, 0)} icon={UserX} tone={totals?.absent ? 'danger' : 'neutral'} loading={grid.isLoading} />
        <StatCard label={t('timesheet.stats.leave')} value={formatNumber((totals?.sick ?? 0) + (totals?.vacation ?? 0), 0)} loading={grid.isLoading} />
      </div>

      {grid.data?.closed && (
        <Alert tone="info" className="mb-4">
          {t('timesheet.closed')}
        </Alert>
      )}

      <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('employees.searchPlaceholder')}
          aria-label={t('employees.searchPlaceholder')}
          className="md:max-w-xs"
        />
        <Legend />
      </div>

      {grid.isLoading ? (
        <Skeleton className="h-72 rounded-xl" />
      ) : grid.error ? (
        <ErrorCard error={grid.error} onRetry={() => void grid.refetch()} />
      ) : grid.data && grid.data.employees.length > 0 ? (
        <>
          <DesktopGrid grid={grid.data} editable={editable} onOpen={setTarget} />
          <ul className="flex flex-col gap-2 md:hidden">
            {grid.data.employees.map((person) => (
              <li key={person.id}>
                <PersonCard person={person} grid={grid.data} editable={editable} onOpen={setTarget} />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Card>
          <EmptyState icon={CalendarDays} title={t('timesheet.emptyTitle')} description={t('timesheet.emptyBody')} />
        </Card>
      )}

      {editable ? <DayDialog target={target} onClose={() => setTarget(null)} /> : <DayView target={target} onClose={() => setTarget(null)} />}
      {canFill && <BulkDialog month={month} open={bulkOpen} onOpenChange={setBulkOpen} />}
    </>
  );
}
