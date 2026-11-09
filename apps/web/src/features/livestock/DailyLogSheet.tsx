import { HERD_CONDITIONS, round, todayIso } from '@yap/shared';
import { Check, CircleAlert, ClipboardCheck, Minus, Plus, TriangleAlert } from 'lucide-react';
import { type FocusEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, Button, Combobox, Label, NumberInput, Sheet, SheetContent, SheetDescription, SheetTitle, Skeleton, Textarea, apiOptions } from '@/components/ui';
import { ErrorCard } from '@/components';
import { api } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { formatDateLong, formatNumber, formatQty } from '@/lib/format';
import { errorMessage, useApiMutation, useDetail } from '@/lib/query';
import { cn } from '@/lib/utils';
import { PhotoPicker } from './PhotoPicker';
import { newClientId } from './shared';

const PATH = '/livestock/daily-logs';

interface PlanLine {
  itemId: string;
  itemName: string;
  unit: string;
  kgPerHeadDay: number;
  plannedQty: number;
  qtyOnHand: number;
}

interface Plan {
  herd: { id: string; name: string; rationId: string | null; headCount: number };
  date: string;
  logId: string | null;
  lines: PlanLine[];
}

export interface LogLine {
  itemId: string;
  itemName: string;
  unit: string;
  plannedQty: number;
  actualQty: number;
  totalCost: number | null;
  warehouseName: string | null;
}

export interface LogDetail {
  id: string;
  herdId: string;
  herdName: string | null;
  date: string;
  headCount: number;
  waterL: number | null;
  condition: (typeof HERD_CONDITIONS)[number];
  notes: string | null;
  createdBy: string | null;
  updatedAt: string;
  photos: { id: string; url: string }[];
  photoFileIds: string[];
  lines: LogLine[];
}

interface FeedLine {
  itemId: string;
  name: string;
  unit: string;
  plannedQty: number;
  onHand: number | null;
  qty: number | null;
}

/** A step that moves the number by a useful amount: 10 kg of hay for 600 kg, 0.5 kg of salt for 6 kg. */
function stepFor(planned: number): number {
  if (planned <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(planned));
  return planned >= 10 ? magnitude / 10 : magnitude / 2;
}

/**
 * The field arrives prefilled, so typing must replace the number. Otherwise changing 600 to 650 gives
 * 600650, and a small feed could go from 6 to 66 unnoticed. Deferred one frame because NumberInput
 * rewrites its text on focus, which would clear a selection made now.
 */
function selectAll(event: FocusEvent<HTMLInputElement>) {
  const input = event.currentTarget;
  requestAnimationFrame(() => input.setSelectionRange(0, input.value.length));
}

function FeedStepper({ line, threshold, onChange }: { line: FeedLine; threshold: number; onChange: (qty: number | null) => void }) {
  const { t } = useTranslation('livestock');
  const step = stepFor(line.plannedQty);
  const qty = line.qty || 0;
  const percent = line.plannedQty > 0 ? round(((qty - line.plannedQty) / line.plannedQty) * 100, 1) : null;
  const strayed = percent !== null && Math.abs(percent) > threshold;
  const shortOfStock = line.onHand !== null && qty > line.onHand;

  return (
    <div className={cn('rounded-xl border bg-card p-3', strayed ? 'border-warning' : 'border-border')}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-lg font-semibold">{line.name}</p>
        {line.plannedQty > 0 && (
          <p className="text-sm text-muted-foreground">
            {t('dailyLogs.planned')}: {formatQty(line.plannedQty, line.unit)}
          </p>
        )}
      </div>
      <div className="mt-2 grid grid-cols-[3.75rem_1fr_3.75rem] gap-2">
        <Button
          type="button"
          variant="secondary"
          className="h-16 w-full"
          aria-label={t('dailyLogs.less', { name: line.name })}
          onClick={() => onChange(Math.max(0, round(qty - step, 3)))}
        >
          <Minus className="size-7" aria-hidden />
        </Button>
        <NumberInput
          aria-label={t('dailyLogs.givenOf', { name: line.name })}
          className="h-16 text-center text-2xl font-semibold tabular-nums"
          value={line.qty}
          onChange={onChange}
          // Not null: an empty field saves as none given, and text nobody can read is not that.
          onUnreadable={() => onChange(Number.NaN)}
          onFocus={selectAll}
          suffix={t(`enums:unit.${line.unit}`)}
          maxDigits={3}
        />
        <Button
          type="button"
          variant="secondary"
          className="h-16 w-full"
          aria-label={t('dailyLogs.more', { name: line.name })}
          onClick={() => onChange(round(qty + step, 3))}
        >
          <Plus className="size-7" aria-hidden />
        </Button>
      </div>
      {strayed && (
        <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-warning">
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          {t('dailyLogs.strayed', { percent: `${percent > 0 ? '+' : ''}${formatNumber(percent, 1)}` })}
        </p>
      )}
      {shortOfStock && (
        <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-destructive">
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          {t('dailyLogs.shortOfStock', { qty: formatQty(line.onHand, line.unit) })}
        </p>
      )}
    </div>
  );
}

function ConditionChoice({ value, onChange }: { value: string; onChange: (value: 'normal' | 'deviation') => void }) {
  const { t } = useTranslation('livestock');
  const options = [
    { value: 'normal' as const, icon: Check, selected: 'border-success bg-success-soft text-success' },
    { value: 'deviation' as const, icon: TriangleAlert, selected: 'border-warning bg-warning-soft text-warning' },
  ];
  return (
    <div role="radiogroup" aria-label={t('dailyLogs.condition')} className="grid grid-cols-2 gap-2">
      {options.map((option) => {
        const on = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(option.value)}
            className={cn(
              'focus-ring flex min-h-16 items-center justify-center gap-2 rounded-xl border-2 px-3 text-lg font-semibold',
              on ? option.selected : 'border-border bg-card text-foreground',
            )}
          >
            <option.icon className="size-6" aria-hidden />
            {t(`enums:herdCondition.${option.value}`)}
          </button>
        );
      })}
    </div>
  );
}

interface FormProps {
  plan: Plan | null;
  log: LogDetail | null;
  herdName: string;
  date: string;
  herdId: string;
  onDone: () => void;
}

function DailyLogForm({ plan, log, herdName, date, herdId, onDone }: FormProps) {
  const { t } = useTranslation('livestock');
  const session = useSession();
  const threshold = (session.settings as { feed?: { deviationPercent?: number } }).feed?.deviationPercent ?? 15;

  // A stable id across retries: if the reply is lost in a dead zone, sending again is harmless.
  const clientId = useRef(newClientId());
  const [lines, setLines] = useState<FeedLine[]>(() =>
    log
      ? log.lines.map((l) => ({ itemId: l.itemId, name: l.itemName, unit: l.unit, plannedQty: l.plannedQty, onHand: null, qty: l.actualQty }))
      : (plan?.lines ?? []).map((l) => ({ itemId: l.itemId, name: l.itemName, unit: l.unit, plannedQty: l.plannedQty, onHand: l.qtyOnHand, qty: l.plannedQty })),
  );
  const [water, setWater] = useState<number | null>(log?.waterL ?? null);
  const [condition, setCondition] = useState<'normal' | 'deviation'>(log?.condition ?? 'normal');
  const [notes, setNotes] = useState(log?.notes ?? '');
  const photos = useRef<string[]>(log?.photoFileIds ?? []);

  const headCount = plan?.herd.headCount ?? log?.headCount ?? 0;
  const setQty = (itemId: string, qty: number | null) => setLines((all) => all.map((l) => (l.itemId === itemId ? { ...l, qty } : l)));

  const save = useApiMutation<void>({
    mutationFn: async () => {
      const feed = lines.map((l) => ({ itemId: l.itemId, actualQty: l.qty ?? 0 }));
      const common = { waterL: water, condition, notes: notes.trim() || null, photoFileIds: photos.current, lines: feed };
      if (log) {
        await api.patch(`${PATH}/${log.id}`, { ...common, baseUpdatedAt: log.updatedAt });
      } else {
        await api.postOnce(PATH, { ...common, id: clientId.current, herdId, date });
      }
    },
    invalidate: [PATH, '/livestock/herds', '/inventory', '/feed'],
    silentError: true,
    onSuccess: () => {
      toast.success(t('dailyLogs.saved'));
      onDone();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const addFeed = (itemId: string | null, label: string | undefined, unit: string | undefined) => {
    if (!itemId || lines.some((l) => l.itemId === itemId)) return;
    setLines((all) => [...all, { itemId, name: label ?? '', unit: unit ?? 'kg', plannedQty: 0, onHand: null, qty: null }]);
  };

  return (
    <>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        {lines.length > 0 && !log && (
          <Alert tone="info">{t('dailyLogs.prefilled')}</Alert>
        )}
        {lines.length === 0 && <Alert tone="info">{t('dailyLogs.noRation')}</Alert>}

        <div className="space-y-3">
          {lines.map((line) => (
            <FeedStepper key={line.itemId} line={line} threshold={threshold} onChange={(qty) => setQty(line.itemId, qty)} />
          ))}
        </div>

        <div>
          <Label>{t('dailyLogs.addFeed')}</Label>
          <Combobox
            value={null}
            onChange={(value, option) => addFeed(value, option?.label, (option?.raw as { unit?: string } | undefined)?.unit)}
            placeholder={t('dailyLogs.addFeedPlaceholder')}
            loadOptions={apiOptions<{ id: string; name: string; unit: string }>('/inventory/items/lookup', (i) => ({ value: i.id, label: i.name, hint: t(`enums:unit.${i.unit}`, { defaultValue: i.unit }) }), { category: 'feed' })}
          />
        </div>

        <div>
          <Label htmlFor="daily-water">{t('dailyLogs.water')}</Label>
          <NumberInput id="daily-water" className="h-14 text-xl" value={water} onChange={setWater} suffix={t('enums:unit.l')} />
        </div>

        <div className="space-y-2">
          <Label>{t('dailyLogs.condition')}</Label>
          <ConditionChoice value={condition} onChange={setCondition} />
        </div>

        {condition === 'deviation' && (
          <div>
            <Label htmlFor="daily-notes">{t('dailyLogs.whatHappened')}</Label>
            <Textarea id="daily-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        )}

        <PhotoPicker onChange={(ids) => (photos.current = [...(log?.photoFileIds ?? []), ...ids])} />
      </div>

      <div className="border-t border-border bg-card p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <Button size="lg" className="h-16 w-full text-lg" loading={save.isPending} disabled={lines.some((l) => Number.isNaN(l.qty))} onClick={() => save.mutate()}>
          <ClipboardCheck className="size-6" aria-hidden />
          {t('dailyLogs.save', { herd: herdName, count: headCount })}
        </Button>
      </div>
    </>
  );
}

export interface DailyLogSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  herdId: string;
  herdName: string;
  date?: string;
  /** Set when correcting a saved record. */
  logId?: string | null;
}

/** Full-height sheet on a phone, so the save button stays under the thumb. */
export function DailyLogSheet({ open, onOpenChange, herdId, herdName, date = todayIso(), logId }: DailyLogSheetProps) {
  const { t } = useTranslation('livestock');
  const plan = useDetail<Plan>(open && !logId ? `${PATH}/plan` : null, { herdId, date });
  const existingId = logId ?? plan.data?.logId ?? null;
  const log = useDetail<LogDetail>(open && existingId ? `${PATH}/${existingId}` : null);

  const error = plan.error ?? log.error;
  const loading = (open && !logId && plan.isLoading) || (!!existingId && log.isLoading);

  useEffect(() => {
    if (!open) return;
    void plan.refetch?.();
    // Only when opened: a stale plan would prefill yesterday's head count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto h-[92dvh] w-full max-w-2xl md:rounded-t-2xl">
        <div className="px-4 pt-4 pe-14 pb-3">
          <SheetTitle className="text-xl font-semibold">{herdName}</SheetTitle>
          <SheetDescription className="text-muted-foreground">
            {formatDateLong(date)}
            {plan.data && ` · ${t('head', { count: plan.data.herd.headCount })}`}
          </SheetDescription>
        </div>
        {error ? (
          <div className="p-4">
            <ErrorCard error={error} onRetry={() => void (plan.error ? plan.refetch() : log.refetch())} />
          </div>
        ) : loading ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : (
          <DailyLogForm
            key={`${herdId}:${date}:${existingId ?? 'new'}`}
            plan={plan.data ?? null}
            log={existingId ? (log.data ?? null) : null}
            herdId={herdId}
            herdName={herdName}
            date={date}
            onDone={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
