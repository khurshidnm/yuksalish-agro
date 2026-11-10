import { SEXES, addDays, todayIso } from '@yap/shared';
import { Check, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, Button, DateInput, Input, NumberInput, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { errorMessage, useApiMutation, useList } from '@/lib/query';
import { cn } from '@/lib/utils';
import { ScanAnimalButton, type ScannedAnimal } from '../ScanAnimal';
import { ANIMALS_PATH, BREEDING_PATH, LAMBINGS_PATH } from './options';
import type { Lambing, Pregnancy } from './types';

type Sex = (typeof SEXES)[number];

interface LambDraft {
  sex: Sex | null;
  birthWeightKg: number | null;
  alive: boolean;
}

const emptyLamb = (): LambDraft => ({ sex: null, birthWeightKg: null, alive: true });
const COMPLICATIONS = ['assisted', 'difficult', 'malposition', 'retainedPlacenta', 'weakLamb'] as const;

interface PickedEwe {
  id: string;
  tag: string;
  breedingId?: string;
  expectedDate?: string;
  /** The start of the lambing window: a date well before it is a slip or an abortion. */
  expectedEarliest?: string;
}

/** Thick, thumb-sized choice. Fits a phone held in one hand with a torch in the other. */
function BigChoice({ selected, onClick, children, label }: { selected: boolean; onClick: () => void; children: React.ReactNode; label?: string }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'focus-ring flex min-h-14 flex-1 items-center justify-center gap-2 rounded-lg border-2 px-3 text-lg font-semibold transition-colors',
        selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-foreground hover:border-input',
      )}
    >
      {children}
    </button>
  );
}

function EwePicker({ onPick }: { onPick: (ewe: PickedEwe) => void }) {
  const { t } = useTranslation('vet');
  const [search, setSearch] = useState('');
  const results = useList<Pregnancy>(BREEDING_PATH, { status: 'pregnant', search: search || undefined, sort: 'expectedDate', pageSize: 6 });
  const rows = results.data?.data ?? [];

  // A scanned tag picks the ewe at once when she is among the pregnant ones; when she is not, the
  // list below is searched for her tag and says so.
  const pickScanned = async (animal: ScannedAnimal) => {
    setSearch(animal.tag);
    try {
      const found = await api.list<Pregnancy>(BREEDING_PATH, { status: 'pregnant', search: animal.tag, sort: 'expectedDate', pageSize: 6 });
      const row = found.data.find((pregnancy) => pregnancy.eweId === animal.id);
      if (row) onPick({ id: row.eweId, tag: row.eweTag, breedingId: row.id, expectedDate: row.expectedDate, expectedEarliest: row.expectedEarliest });
    } catch {
      // The list below runs the same search and shows its own state.
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t('lambing.findEwe')}
            placeholder={t('lambing.findEwe')}
            className="h-14 pl-11 text-lg"
            autoComplete="off"
          />
        </div>
        <ScanAnimalButton onFarmOnly className="size-14 shrink-0" onPick={(animal) => void pickScanned(animal)} />
      </div>
      {rows.length === 0 && !results.isLoading && <p className="py-2 text-center text-muted-foreground">{t('lambing.noEwe')}</p>}
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onPick({ id: row.eweId, tag: row.eweTag, breedingId: row.id, expectedDate: row.expectedDate, expectedEarliest: row.expectedEarliest })}
              className="focus-ring flex min-h-14 w-full items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 text-left hover:border-input"
            >
              <span className="text-lg font-semibold">{row.eweTag}</span>
              <span className="text-muted-foreground">{formatDate(row.expectedDate)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Written for 3 a.m. in a barn. The panel keeps the dark palette whatever the app theme is, so a
 * phone does not light up the shed. Controls are large and inline: nothing depends on a popover,
 * which would open outside this dark panel, and nothing defaults to a sex or a weight.
 */
export function LambingForm({
  presetEwe,
  onDone,
  onSaved,
}: {
  presetEwe?: PickedEwe | null;
  onDone?: () => void;
  /** With the saved record: the lambs now have ids, so their care can be entered. */
  onSaved?: (ewe: { id: string; tag: string }, record: Lambing) => void;
}) {
  const { t } = useTranslation('vet');
  const [ewe, setEwe] = useState<PickedEwe | null>(presetEwe ?? null);
  const [date, setDate] = useState(todayIso());
  const [lambs, setLambs] = useState<LambDraft[]>([emptyLamb()]);
  const [complications, setComplications] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (presetEwe) setEwe(presetEwe);
  }, [presetEwe]);

  // An error is about what was on screen when saving; it goes as soon as that changes.
  useEffect(() => setProblem(null), [ewe, lambs]);

  const submit = useApiMutation<void, Lambing>({
    mutationFn: () => {
      const complicationText = [...complications.map((key) => t(`lambing.complication.${key}`)), notes.trim()].filter(Boolean).join('; ');
      return api.postOnce<Lambing>(LAMBINGS_PATH, {
        eweId: ewe!.id,
        breedingId: ewe!.breedingId,
        date,
        // The hour colostrum is counted from. The server keeps it only for a lambing entered on its own day.
        bornAt: new Date().toISOString(),
        lambs: lambs.map((lamb) => ({ sex: lamb.sex, birthWeightKg: lamb.birthWeightKg, alive: lamb.alive })),
        complications: complicationText || null,
      });
    },
    invalidate: [LAMBINGS_PATH, BREEDING_PATH, ANIMALS_PATH],
    silentError: true,
    onSuccess: (record) => {
      toast.success(t('lambing.saved', { tag: ewe!.tag, count: record.lambsAlive }));
      onSaved?.({ id: ewe!.id, tag: ewe!.tag }, record);
      setEwe(null);
      setLambs([emptyLamb()]);
      setComplications([]);
      setNotes('');
      onDone?.();
    },
    onError: (error) => setProblem(errorMessage(error)),
  });

  const setCount = (count: number) => {
    setLambs((current) => Array.from({ length: count }, (_, i) => current[i] ?? emptyLamb()));
  };
  const updateLamb = (index: number, patch: Partial<LambDraft>) => {
    setLambs((current) => current.map((lamb, i) => (i === index ? { ...lamb, ...patch } : lamb)));
  };

  const save = () => {
    setProblem(null);
    if (!ewe) return setProblem(t('lambing.needEwe'));
    if (lambs.some((lamb) => !lamb.sex)) return setProblem(t('lambing.needSex'));
    submit.mutate();
  };

  return (
    <section aria-label={t('lambing.formTitle')} className="space-y-5 rounded-xl border border-border bg-card p-4 text-foreground">
      <h2 className="text-xl font-semibold">{t('lambing.formTitle')}</h2>

      <div className="space-y-2">
        <p className="text-base font-medium">{t('common.ewe')}</p>
        {ewe ? (
          <div className="flex min-h-14 items-center justify-between gap-3 rounded-lg border border-primary bg-card px-4">
            <div>
              <p className="text-xl font-bold">{ewe.tag}</p>
              {ewe.expectedDate && <p className="text-muted-foreground">{t('lambing.expected', { date: formatDate(ewe.expectedDate) })}</p>}
            </div>
            <Button variant="ghost" size="icon" aria-label={t('lambing.changeEwe')} onClick={() => setEwe(null)}>
              <X aria-hidden />
            </Button>
          </div>
        ) : (
          <EwePicker onPick={setEwe} />
        )}
      </div>

      <div className="space-y-2">
        <label htmlFor="lambing-date" className="block text-base font-medium">
          {t('common.date')}
        </label>
        <DateInput id="lambing-date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} className="h-14 text-lg" />
      </div>

      <div className="space-y-2">
        <p className="text-base font-medium">{t('lambing.howMany')}</p>
        <div className="flex gap-2">
          {[1, 2, 3].map((count) => (
            <BigChoice key={count} selected={lambs.length === count} onClick={() => setCount(count)} label={t('lambing.countLabel', { count })}>
              <span className="text-2xl">{count}</span>
            </BigChoice>
          ))}
        </div>
      </div>

      {lambs.map((lamb, index) => (
        <fieldset key={index} className="space-y-3 rounded-lg border border-border bg-card p-3">
          <legend className="px-1 text-base font-semibold">{t('lambing.lambNumber', { number: index + 1 })}</legend>
          <div className="flex gap-2">
            {SEXES.map((sex) => (
              <BigChoice key={sex} selected={lamb.sex === sex} onClick={() => updateLamb(index, { sex })}>
                {t(`enums:sex.${sex}`)}
              </BigChoice>
            ))}
          </div>
          <div className="space-y-1">
            <label htmlFor={`lamb-weight-${index}`} className="block font-medium">
              {t('lambing.birthWeight')}
            </label>
            <NumberInput
              id={`lamb-weight-${index}`}
              value={lamb.birthWeightKg}
              onChange={(birthWeightKg) => updateLamb(index, { birthWeightKg })}
              suffix={t('enums:unit.kg')}
              className="h-14 text-lg"
            />
          </div>
          <div className="flex gap-2">
            <BigChoice selected={lamb.alive} onClick={() => updateLamb(index, { alive: true })}>
              {t('lambing.alive')}
            </BigChoice>
            <BigChoice selected={!lamb.alive} onClick={() => updateLamb(index, { alive: false })}>
              {t('lambing.stillborn')}
            </BigChoice>
          </div>
        </fieldset>
      ))}

      <div className="space-y-2">
        <p className="text-base font-medium">{t('lambing.complications')}</p>
        <div className="flex flex-wrap gap-2">
          {COMPLICATIONS.map((key) => {
            const on = complications.includes(key);
            return (
              <button
                key={key}
                type="button"
                aria-pressed={on}
                onClick={() => setComplications((current) => (on ? current.filter((c) => c !== key) : [...current, key]))}
                className={cn(
                  'focus-ring flex min-h-12 items-center gap-1.5 rounded-full border px-4 font-medium',
                  on ? 'border-accent bg-accent text-accent-foreground' : 'border-border bg-card text-foreground',
                )}
              >
                {on && <Check className="size-4" aria-hidden />}
                {t(`lambing.complication.${key}`)}
              </button>
            );
          })}
        </div>
        <Textarea
          aria-label={t('common.notes')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t('lambing.notesPlaceholder')}
          rows={2}
          className="text-base"
        />
      </div>

      {/* The server refuses live lambs this early; say so before the form is filled in. */}
      {ewe?.expectedEarliest && date < addDays(ewe.expectedEarliest, -7) && (
        <Alert tone="warning">{t('lambing.tooEarly', { date: formatDate(ewe.expectedEarliest) })}</Alert>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}

      <Button size="lg" className="h-16 w-full text-lg" loading={submit.isPending} onClick={save}>
        {t('lambing.submit')}
      </Button>
    </section>
  );
}
