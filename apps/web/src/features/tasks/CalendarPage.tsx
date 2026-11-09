import { keepPreviousData } from '@tanstack/react-query';
import { addDays, monthOf, todayIso } from '@yap/shared';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { z } from 'zod';
import { useOpenableLink } from '@/app/canOpen';
import { ComboboxField, DateField, EmptyState, ErrorCard, FormDialog, FormGrid, PageHeader, SelectField, TextField, TextareaField, useConfirm, useUrlParam } from '@/components';
import { Badge, type BadgeVariant, Button, Card, CardContent, Combobox, Select, Skeleton, Tabs, TabsList, TabsTrigger } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDateLong, formatMonth } from '@/lib/format';
import { zEnum, zOptionalDate, zOptionalEnum, zOptionalRef, zOptionalText, zDate, zText } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';
import { cn } from '@/lib/utils';
import { monthGrid, shiftDateByMonth, weekDays } from './calendarDates';
import { calendarChipTitle, calendarItemTitle } from './calendarTitle';
import { memberOptions } from './TaskFormDialog';
import { CALENDAR_KINDS, DIVISIONS, type CalendarItem, type CalendarKind } from './types';

const VIEWS = ['month', 'week', 'day'] as const;
type View = (typeof VIEWS)[number];

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

const KIND_TONE: Record<CalendarKind, BadgeVariant> = {
  lambing: 'success',
  vaccination: 'info',
  field_operation: 'neutral',
  loan: 'warning',
  contract: 'warning',
  document: 'danger',
  maintenance: 'neutral',
  state_report: 'warning',
  staff_contract: 'warning',
  staff_medical: 'info',
  task: 'outline',
  manual: 'info',
};

/**
 * One colour per group of kinds; the legend lists each colour once with the kinds it stands for. A
 * task is a ring, so it never reads as the solid green of an event in light mode.
 */
const KIND_DOT: Record<CalendarKind, string> = {
  lambing: 'bg-success',
  vaccination: 'bg-info',
  field_operation: 'bg-muted-foreground',
  loan: 'bg-warning',
  contract: 'bg-warning',
  document: 'bg-danger',
  maintenance: 'bg-muted-foreground',
  state_report: 'bg-warning',
  staff_contract: 'bg-warning',
  staff_medical: 'bg-info',
  task: 'border-2 border-foreground bg-transparent',
  manual: 'bg-primary',
};

/** Kinds on screen grouped by their dot, in CALENDAR_KINDS order: one legend line per colour. */
function legendGroups(kinds: readonly CalendarKind[]): { dot: string; kinds: CalendarKind[] }[] {
  const groups = new Map<string, CalendarKind[]>();
  for (const kind of kinds) groups.set(KIND_DOT[kind], [...(groups.get(KIND_DOT[kind]) ?? []), kind]);
  return [...groups].map(([dot, members]) => ({ dot, kinds: members }));
}

/** Below Tailwind's md breakpoint the month grid shows dots and the agenda sits under it. */
const isPhone = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px)').matches === true;

const EVENT_KINDS = ['meeting', 'inspection', 'delivery', 'other'] as const;

const eventSchema = z.object({
  title: zText(200),
  kind: zEnum(EVENT_KINDS),
  date: zDate(),
  endDate: zOptionalDate(),
  responsibleUserId: zOptionalRef(),
  division: zOptionalEnum(DIVISIONS),
  notes: zOptionalText(1000),
});

type EventValues = z.input<typeof eventSchema>;

function ItemRow({ item, onEdit }: { item: CalendarItem; onEdit: (item: CalendarItem) => void }) {
  const { t } = useTranslation('tasks');
  const canEdit = usePermission('tasks.update');
  const editable = item.editableId !== null && canEdit;
  const to = useOpenableLink()(item.link);

  const body = (
    <>
      <span className={cn('mt-1.5 size-2.5 shrink-0 rounded-full', KIND_DOT[item.kind])} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block font-medium break-words">{calendarItemTitle(item, t)}</span>
        <span className="flex flex-wrap gap-x-2 text-sm text-muted-foreground">
          <span>{t(`calendar.kind.${item.kind}`)}</span>
          {item.responsibleName && <span>{item.responsibleName}</span>}
          {item.status === 'done' && <span>{t('enums:taskStatus.done')}</span>}
        </span>
      </span>
    </>
  );
  const row = 'flex min-h-11 w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted focus-ring';

  if (editable) {
    return (
      <button type="button" className={row} onClick={() => onEdit(item)}>
        {body}
      </button>
    );
  }
  return to ? (
    <Link to={to} className={row}>
      {body}
    </Link>
  ) : (
    <div className={row}>{body}</div>
  );
}

function Agenda({ items, onEdit, compact }: { items: CalendarItem[]; onEdit: (item: CalendarItem) => void; compact?: boolean }) {
  const { t } = useTranslation('tasks');
  if (items.length === 0) {
    // In the week view a full sentence on every free day is only noise.
    return compact ? (
      <p className="px-2 pb-1 text-sm text-muted-foreground">{t('calendar.free')}</p>
    ) : (
      <p className="py-6 text-center text-sm text-muted-foreground">{t('calendar.nothing')}</p>
    );
  }
  return (
    <div className="space-y-0.5">
      {items.map((item) => (
        <ItemRow key={item.id} item={item} onEdit={onEdit} />
      ))}
    </div>
  );
}

interface MonthProps {
  anchor: string;
  items: CalendarItem[];
  onPick: (date: string) => void;
}

function occursOn(item: CalendarItem, date: string): boolean {
  return item.date <= date && (item.endDate ?? item.date) >= date;
}

const MAX_CHIPS = 3;

function MonthGrid({ anchor, items, onPick }: MonthProps) {
  const { t } = useTranslation('tasks');
  const month = monthOf(anchor);
  const today = todayIso();

  return (
    <div className="overflow-hidden rounded-lg border border-border" role="grid" aria-label={formatMonth(month)}>
      <div className="grid grid-cols-7 border-b border-border bg-muted" role="row">
        {WEEKDAYS.map((day) => (
          <div key={day} role="columnheader" className="px-1 py-2 text-center text-xs font-medium text-muted-foreground">
            {t(`calendar.weekday.${day}`)}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7" role="row">
        {monthGrid(month).map((date) => {
          const dayItems = items.filter((item) => occursOn(item, date));
          const outside = monthOf(date) !== month;
          return (
            <button
              key={date}
              type="button"
              role="gridcell"
              aria-selected={date === anchor}
              aria-label={`${formatDateLong(date)}: ${t('calendar.itemCount', { count: dayItems.length })}`}
              onClick={() => onPick(date)}
              className={cn(
                'focus-ring flex min-h-14 min-w-0 flex-col gap-1 border-r border-b border-border p-1 text-left nth-[7n]:border-r-0 hover:bg-muted md:min-h-28 md:p-1.5',
                outside && 'bg-muted/40 text-muted-foreground',
                date === anchor && 'ring-2 ring-primary ring-inset',
              )}
            >
              <span
                className={cn(
                  'flex size-6 items-center justify-center rounded-full text-sm tabular-nums',
                  date === today && 'bg-primary font-semibold text-primary-foreground',
                )}
              >
                {Number(date.slice(8))}
              </span>
              {/* Phones get dots, wider screens get readable chips. */}
              <span className="flex flex-wrap gap-1 md:hidden">
                {dayItems.slice(0, 6).map((item) => (
                  <span key={item.id} className={cn('size-2 rounded-full', KIND_DOT[item.kind])} aria-hidden />
                ))}
              </span>
              <span className="hidden min-w-0 flex-col gap-1 md:flex">
                {dayItems.slice(0, MAX_CHIPS).map((item) => (
                  <Badge key={item.id} variant={KIND_TONE[item.kind]} className="block truncate rounded px-1.5" title={calendarItemTitle(item, t)}>
                    {calendarChipTitle(item, t)}
                  </Badge>
                ))}
                {dayItems.length > MAX_CHIPS && (
                  <span className="px-1 text-xs text-muted-foreground">{t('calendar.more', { count: dayItems.length - MAX_CHIPS })}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WeekView({ anchor, items, onPick, onEdit }: MonthProps & { onEdit: (item: CalendarItem) => void }) {
  const { t } = useTranslation('tasks');
  const today = todayIso();
  return (
    // Seven columns beside the sidebar leave no room to read, so days flow into wider cards.
    <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {weekDays(anchor).map((date, index) => (
        <Card key={date} className={cn('min-w-0', date === today && 'border-primary')}>
          <CardContent className="p-2 md:p-2">
            <button type="button" onClick={() => onPick(date)} className="focus-ring mb-1 min-h-11 w-full rounded px-2 text-left text-sm font-semibold hover:bg-muted">
              {t(`calendar.weekday.${WEEKDAYS[index]}`)}, {formatDateLong(date)}
            </button>
            <Agenda compact items={items.filter((item) => occursOn(item, date))} onEdit={onEdit} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function EventDialog({
  open,
  item,
  defaultDate,
  onOpenChange,
}: {
  open: boolean;
  item: CalendarItem | null;
  defaultDate: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('tasks');
  const confirm = useConfirm();
  const canDelete = usePermission('tasks.delete');

  const save = useApiMutation<z.output<typeof eventSchema>>({
    mutationFn: (values) =>
      item ? api.patch(`/tasks/calendar/events/${item.editableId}`, values) : api.post('/tasks/calendar/events', values),
    invalidate: ['/tasks/calendar'],
    silentError: true,
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`/tasks/calendar/events/${id}`),
    invalidate: ['/tasks/calendar'],
    successMessage: 'common:toast.deleted',
    onSuccess: () => onOpenChange(false),
  });

  const defaults: EventValues = item
    ? {
        title: item.title ?? '',
        kind: (item.params.eventKind as EventValues['kind']) ?? 'meeting',
        date: item.date,
        endDate: item.endDate ?? '',
        responsibleUserId: item.responsibleUserId,
        division: (item.division as EventValues['division']) ?? '',
        notes: (item.params.notes as string | null) ?? '',
      }
    : { title: '', kind: 'meeting', date: defaultDate, endDate: '', responsibleUserId: null, division: '', notes: '' };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? t('calendar.editEvent') : t('calendar.addEvent')}
      schema={eventSchema}
      defaultValues={defaults}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage={item ? 'common:toast.updated' : 'common:toast.created'}
    >
      {(form) => (
        <>
          <TextField form={form} name="title" label={t('calendar.eventTitle')} required autoFocus />
          <FormGrid>
            <SelectField form={form} name="kind" label={t('calendar.eventKind')} options={EVENT_KINDS.map((k) => ({ value: k, label: t(`calendar.eventKinds.${k}`) }))} />
            <SelectField
              form={form}
              name="division"
              label={t('fields.division')}
              placeholder={t('fields.noDivision')}
              options={DIVISIONS.map((d) => ({ value: d, label: t(`division.${d}`) }))}
            />
            <DateField form={form} name="date" label={t('calendar.startDate')} required />
            <DateField form={form} name="endDate" label={t('calendar.endDate')} />
          </FormGrid>
          <ComboboxField
            form={form}
            name="responsibleUserId"
            label={t('calendar.responsible')}
            loadOptions={memberOptions}
            selectedLabel={item?.responsibleName}
          />
          <TextareaField form={form} name="notes" label={t('fields.notes')} />
          {item && canDelete && (
            <Button
              type="button"
              variant="ghost"
              className="self-start text-destructive"
              loading={remove.isPending}
              onClick={async () => {
                const ok = await confirm({ title: t('calendar.deleteEvent'), description: item.title ?? '', destructive: true });
                if (ok) remove.mutate(item.editableId!);
              }}
            >
              <Trash2 aria-hidden />
              {t('common:actions.delete')}
            </Button>
          )}
        </>
      )}
    </FormDialog>
  );
}

export default function CalendarPage() {
  const { t } = useTranslation('tasks');
  const canCreate = usePermission('tasks.create');

  const today = todayIso();
  const [view, setView] = useUrlParam('view', 'month');
  // Picking a day must not throw the page back to the top: the agenda under the grid is what it opens.
  const [date, setDate] = useUrlParam('date', today, { keepScroll: true });
  const [division, setDivision] = useUrlParam('division');
  const [person, setPerson] = useUrlParam('person');
  const [personName, setPersonName] = useUrlParam('personName');
  const [dialog, setDialog] = useState<{ item: CalendarItem | null } | null>(null);
  const agendaRef = useRef<HTMLDivElement>(null);

  const current = (VIEWS as readonly string[]).includes(view) ? (view as View) : 'month';

  const range =
    current === 'month'
      ? (() => {
          const grid = monthGrid(monthOf(date));
          return { from: grid[0], to: grid.at(-1)! };
        })()
      : current === 'week'
        ? { from: weekDays(date)[0], to: weekDays(date)[6] }
        : { from: date, to: date };

  const query = useDetail<CalendarItem[]>(
    '/tasks/calendar',
    { ...range, division: division || undefined, responsibleUserId: person || undefined },
    { placeholderData: keepPreviousData },
  );
  const items = query.data ?? [];

  const step = (direction: 1 | -1) => {
    if (current === 'month') setDate(shiftDateByMonth(date, direction));
    else setDate(addDays(date, current === 'week' ? 7 * direction : direction));
  };

  const heading = current === 'month' ? formatMonth(monthOf(date)) : current === 'week' ? `${formatDateLong(weekDays(date)[0])} – ${formatDateLong(weekDays(date)[6])}` : formatDateLong(date);

  return (
    <>
      <PageHeader
        title={t('calendar.title')}
        description={t('calendar.description')}
        actions={
          canCreate && (
            <Button onClick={() => setDialog({ item: null })}>
              <Plus aria-hidden />
              {t('calendar.addEvent')}
            </Button>
          )
        }
      />

      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" aria-label={t('common:actions.previous')} onClick={() => step(-1)}>
              <ChevronLeft aria-hidden />
            </Button>
            <Button variant="outline" onClick={() => setDate(today)}>
              {t('calendar.today')}
            </Button>
            <Button variant="outline" size="icon" aria-label={t('common:actions.next')} onClick={() => step(1)}>
              <ChevronRight aria-hidden />
            </Button>
          </div>
          <Tabs value={current} onValueChange={setView}>
            <TabsList>
              {VIEWS.map((v) => (
                <TabsTrigger key={v} value={v}>
                  {t(`calendar.view.${v}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <h2 className="text-lg font-semibold first-letter:uppercase">{heading}</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select
            aria-label={t('fields.division')}
            value={division}
            onChange={(e) => setDivision(e.target.value)}
            options={DIVISIONS.map((d) => ({ value: d, label: t(`division.${d}`) }))}
            placeholder={t('filters.allDivisions')}
            className="sm:w-52"
          />
          <Combobox
            value={person || null}
            onChange={(value, option) => {
              setPerson(value ?? '');
              setPersonName(option?.label ?? '');
            }}
            loadOptions={memberOptions}
            selectedLabel={personName || undefined}
            placeholder={t('filters.allPeople')}
            className="sm:w-60"
          />
        </div>
      </div>

      {query.isLoading && <Skeleton className="h-96 w-full" />}
      {query.error && <ErrorCard error={query.error} onRetry={() => void query.refetch()} />}

      {query.data && (
        <div className={cn('transition-opacity', query.isPlaceholderData && 'opacity-70')}>
          {current === 'month' && (
            <div className="space-y-4">
              <MonthGrid
                anchor={date}
                items={items}
                onPick={(picked) => {
                  setDate(picked);
                  // On a phone the agenda is below the fold, so a tap would seem to do nothing.
                  if (isPhone()) requestAnimationFrame(() => agendaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
                }}
              />
              <Card ref={agendaRef} className="scroll-mt-16">
                <CardContent className="pt-4 md:pt-5">
                  <h3 className="mb-2 font-semibold first-letter:uppercase">{formatDateLong(date)}</h3>
                  <Agenda items={items.filter((item) => occursOn(item, date))} onEdit={(item) => setDialog({ item })} />
                </CardContent>
              </Card>
            </div>
          )}
          {current === 'week' && (
            <WeekView
              anchor={date}
              items={items}
              onPick={(picked) => {
                setDate(picked);
                setView('day');
              }}
              onEdit={(item) => setDialog({ item })}
            />
          )}
          {current === 'day' &&
            (items.length === 0 ? (
              <EmptyState icon={CalendarDays} title={t('calendar.nothing')} />
            ) : (
              <Card>
                <CardContent className="pt-4 md:pt-5">
                  <Agenda items={items} onEdit={(item) => setDialog({ item })} />
                </CardContent>
              </Card>
            ))}

          <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground" aria-label={t('calendar.legend')}>
            {/* Only what is on screen: a shepherd has no business seeing "loan payment" here. */}
            {legendGroups(CALENDAR_KINDS.filter((kind) => items.some((item) => item.kind === kind))).map((group) => (
              <li key={group.dot} className="flex items-center gap-1.5">
                <span className={cn('size-2.5 shrink-0 rounded-full', group.dot)} aria-hidden />
                {group.kinds.map((kind) => t(`calendar.kind.${kind}`)).join(', ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      <EventDialog
        key={dialog?.item?.id ?? 'new'}
        open={dialog !== null}
        item={dialog?.item ?? null}
        defaultDate={date}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      />
    </>
  );
}
