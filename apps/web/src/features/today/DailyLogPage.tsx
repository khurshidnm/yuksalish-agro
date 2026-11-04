import { todayIso } from '@yap/shared';
import { CircleAlert, ThumbsUp } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Alert, Badge, Button, Select, Textarea } from '@/components/ui';
import { EmptyState } from '@/components';
import { useCan, useSession } from '@/lib/auth';
import { formatNumber, formatQty } from '@/lib/format';
import { canEdit, outbox, useOutbox, uuidv7, type OutboxRecord } from '@/lib/outbox';
import { useTodayData, type TodayData, type TodayHerd } from './data';
import { ChoiceButtons, FieldLabel, FieldScreen, FieldSkeleton, PhotoCapture, SaveBar, Stepper, type LocalPhoto } from './field-ui';
import { dailyLogRecord, notableDeviation, queuedFeed, stepFor } from './logic';

const WATER_STEP = 100;

interface Line {
  itemId: string;
  itemName: string;
  unit: string;
  plannedQty: number;
  qtyOnHand: number;
  actualQty: number | null;
}

interface SavedValues {
  lines: { itemId: string; actualQty: number }[];
  waterL: number | null;
  condition: string;
  notes: string | null;
}

/** The ration prefilled, so an ordinary day takes one tap. A saved day opens with its saved amounts. */
function startingLines(herd: TodayHerd, feedItems: TodayData['feedItems'], saved: SavedValues | null): Line[] {
  const lines: Line[] = herd.lines.map((line) => ({
    ...line,
    actualQty: saved ? (saved.lines.find((l) => l.itemId === line.itemId)?.actualQty ?? 0) : line.plannedQty,
  }));
  for (const extra of saved?.lines ?? []) {
    if (lines.some((l) => l.itemId === extra.itemId)) continue;
    const item = feedItems.find((i) => i.id === extra.itemId);
    if (item) lines.push({ itemId: item.id, itemName: item.name, unit: item.unit, plannedQty: 0, qtyOnHand: item.qtyOnHand, actualQty: extra.actualQty });
  }
  return lines;
}

function queuedValues(record: OutboxRecord): SavedValues {
  const { lines, waterL, condition, notes } = record.body as unknown as SavedValues;
  return { lines, waterL, condition, notes };
}

function DailyLogForm({ herd, data, queued }: { herd: TodayHerd; data: TodayData; queued: OutboxRecord | undefined }) {
  const { t } = useTranslation('today');
  const navigate = useNavigate();
  const session = useSession();
  const { records } = useOutbox();
  const date = todayIso();
  const serverLog = data.date === date ? herd.log : null;
  const saved = queued ? queuedValues(queued) : serverLog;

  const [lines, setLines] = useState<Line[]>(() => startingLines(herd, data.feedItems, saved));
  const [waterL, setWaterL] = useState<number | null>(saved?.waterL ?? null);
  const [condition, setCondition] = useState(saved?.condition ?? 'normal');
  const [notes, setNotes] = useState(saved?.notes ?? '');
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const threshold = (session.settings.feed as { deviationPercent?: number } | undefined)?.deviationPercent ?? 15;
  const correcting = !queued && Boolean(serverLog);
  const extras = data.feedItems.filter((item) => !lines.some((line) => line.itemId === item.id));

  const setQty = (itemId: string, actualQty: number | null) =>
    setLines((current) => current.map((line) => (line.itemId === itemId ? { ...line, actualQty } : line)));

  const addExtra = (itemId: string) => {
    const item = data.feedItems.find((i) => i.id === itemId);
    if (!item) return;
    setLines((current) => [...current, { itemId, itemName: item.name, unit: item.unit, plannedQty: 0, qtyOnHand: item.qtyOnHand, actualQty: null }]);
  };

  const save = async () => {
    if (lines.some((line) => line.actualQty === null)) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    const values = {
      waterL,
      condition,
      notes: notes.trim() || null,
      lines: lines.map((line) => ({ itemId: line.itemId, actualQty: line.actualQty as number })),
    };
    const display = {
      herdId: herd.id,
      date,
      herdName: herd.name,
      lines: lines.map((line) => ({ itemId: line.itemId, itemName: line.itemName, unit: line.unit, actualQty: line.actualQty })),
    };
    const newPhotos = photos.map(({ name, blob }) => ({ name, blob }));
    try {
      if (queued) {
        await outbox.revise(queued.id, { body: { ...queued.body, ...values }, meta: display, addPhotos: newPhotos });
      } else if (serverLog) {
        await outbox.enqueue({
          kind: 'daily_log',
          method: 'PATCH',
          path: `/livestock/daily-logs/${serverLog.id}`,
          body: { ...values, baseUpdatedAt: serverLog.updatedAt },
          title: herd.name,
          meta: display,
        });
      } else {
        const id = uuidv7();
        await outbox.enqueue({
          id,
          kind: 'daily_log',
          path: '/livestock/daily-logs',
          body: { id, herdId: herd.id, date, ...values },
          title: herd.name,
          meta: display,
          photoField: 'photoFileIds',
          photos: newPhotos,
        });
      }
      toast.success(t(navigator.onLine ? 'saved.sending' : 'saved.queued'));
      void navigate('/today');
    } catch {
      toast.error(t('saved.failed'));
      setSaving(false);
    }
  };

  return (
    <>
      {correcting && <Alert tone="info">{t('log.correcting')}</Alert>}
      {lines.length === 0 && <Alert tone="info">{t('log.noRation')}</Alert>}

      {lines.map((line) => {
        const available = line.qtyOnHand - queuedFeed(records, line.itemId, queued?.id);
        const deviation = notableDeviation(line.actualQty, line.plannedQty, threshold);
        const short = !correcting && line.actualQty !== null && line.actualQty > available;
        return (
          <Stepper
            key={line.itemId}
            label={line.itemName}
            value={line.actualQty}
            onChange={(value) => setQty(line.itemId, value)}
            step={stepFor(line.plannedQty || line.actualQty || 1)}
            unit={t(`enums:unit.${line.unit}`)}
            invalid={showErrors && line.actualQty === null}
            hint={line.plannedQty > 0 ? t('log.norm', { qty: formatNumber(line.plannedQty) }) : undefined}
          >
            {showErrors && line.actualQty === null && <p className="mt-2 text-base font-medium text-danger">{t('log.qtyRequired')}</p>}
            {deviation !== null && (
              <p className="mt-2 text-base font-medium text-warning">{t(deviation > 0 ? 'log.overNorm' : 'log.underNorm', { percent: Math.abs(deviation) })}</p>
            )}
            {short && <p className="mt-2 text-base font-medium text-danger">{t('log.short', { qty: formatQty(Math.max(0, available), line.unit) })}</p>}
          </Stepper>
        );
      })}

      {extras.length > 0 && (
        <Select
          aria-label={t('log.addFeed')}
          className="h-14 text-base"
          value=""
          placeholder={t('log.addFeed')}
          options={extras.map((item) => ({ value: item.id, label: item.name }))}
          onChange={(event) => addExtra(event.target.value)}
        />
      )}

      <Stepper label={t('log.water')} value={waterL} onChange={setWaterL} step={WATER_STEP} unit={t('log.waterUnit')} />

      <div className="flex flex-col gap-2">
        <FieldLabel>{t('log.condition')}</FieldLabel>
        <ChoiceButtons
          label={t('log.condition')}
          value={condition}
          onChange={setCondition}
          options={[
            { value: 'normal', label: t('log.normal'), icon: ThumbsUp },
            { value: 'deviation', label: t('log.deviation'), icon: CircleAlert },
          ]}
        />
      </div>

      <div className="flex flex-col gap-2">
        <FieldLabel htmlFor="log-notes">{t('log.notes')}</FieldLabel>
        <Textarea id="log-notes" rows={2} className="text-base" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      </div>

      {!correcting && <PhotoCapture photos={photos} onChange={setPhotos} max={3} />}

      <SaveBar label={t(correcting ? 'log.saveCorrection' : 'log.save')} onClick={() => void save()} busy={saving} />
    </>
  );
}

export default function DailyLogPage() {
  const { t } = useTranslation('today');
  const { herdId } = useParams();
  const session = useSession();
  const can = useCan();
  const { data, loading } = useTodayData();
  const { records, ready, sendingId } = useOutbox();
  const date = todayIso();

  if (loading || !ready) return <FieldSkeleton />;

  const herd = data?.herds.find((h) => h.id === herdId);
  if (!data || !herd) {
    return (
      <FieldScreen title={t('log.title')}>
        <EmptyState title={t('log.herdMissing')} description={t('log.herdMissingBody')} />
      </FieldScreen>
    );
  }

  const queued = dailyLogRecord(records, herd.id, date);
  const subtitle = t('herd.head', { n: herd.headCount });

  // The first version may be on the server already, so a change here could be lost.
  if (queued && (!canEdit(queued) || sendingId === queued.id)) {
    return (
      <FieldScreen title={herd.name} subtitle={subtitle}>
        <Alert tone="warning">{t('log.waitingToSend')}</Alert>
        <Button variant="outline" size="lg" className="min-h-14" asChild>
          <Link to="/today/sync">{t('sync.title')}</Link>
        </Button>
      </FieldScreen>
    );
  }

  const serverLog = data.date === date ? herd.log : null;
  if (!queued && serverLog && serverLog.createdBy !== session.user.id && !can('livestock.update')) {
    return (
      <FieldScreen title={herd.name} subtitle={subtitle}>
        <Badge variant="success" className="self-start">
          {t('herd.logged')}
        </Badge>
        <Alert tone="info">{t('log.loggedByOther')}</Alert>
      </FieldScreen>
    );
  }

  return (
    <FieldScreen title={herd.name} subtitle={subtitle}>
      <DailyLogForm key={`${herd.id}:${queued?.id ?? ''}`} herd={herd} data={data} queued={queued} />
    </FieldScreen>
  );
}
