import { todayIso } from '@yap/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui';
import { outbox, useOutbox, uuidv7 } from '@/lib/outbox';
import { useNightWatch } from './data';
import { AnimalPicker, ChoiceButtons, FieldLabel, FieldScreen, SaveBar } from './field-ui';
import { afterLambingRecords, careReady, pensTaken, type DirectoryAnimal, type LambCareDraft, type Mothering } from './logic';

type YesNo = 'yes' | 'no';
const NO_PEN = 'none';

interface Props {
  ewe: DirectoryAnimal;
  lambingId: string;
  /** Live lambs only, with the number each had on the lambing form. */
  lambs: { id: string; n: number }[];
  /** Ewes a lamb can be fostered to. */
  ewes: DirectoryAnimal[];
  backTo: string;
  onDone: () => void;
}

/** Right after the lambing is saved: colostrum, navel, who raises each lamb, and the pen. */
export function LambCareStep({ ewe, lambingId, lambs, ewes, backTo, onDone }: Props) {
  const { t } = useTranslation('today');
  const watch = useNightWatch();
  const { records, sent } = useOutbox();
  const [drafts, setDrafts] = useState<LambCareDraft[]>(() =>
    lambs.map((lamb) => ({ lambId: lamb.id, colostrum: false, navelTreated: false, mothering: 'with_dam', fosterEweId: null })),
  );
  const [fosters, setFosters] = useState<Record<string, DirectoryAnimal | null>>({});
  const [pen, setPen] = useState<string>(NO_PEN);
  const [saving, setSaving] = useState(false);

  const taken = pensTaken(records, sent);
  const pens = (watch.data?.freePens ?? []).filter((item) => !taken.has(item.id));
  const patch = (lambId: string, change: Partial<LambCareDraft>) =>
    setDrafts((current) => current.map((draft) => (draft.lambId === lambId ? { ...draft, ...change } : draft)));
  const yesNo = (yes: string, no: string): { value: YesNo; label: string }[] => [
    { value: 'yes', label: yes },
    { value: 'no', label: no },
  ];

  const save = async () => {
    setSaving(true);
    const penName = pens.find((item) => item.id === pen)?.name ?? '';
    try {
      const queued = afterLambingRecords({
        ewe,
        lambingId,
        at: new Date().toISOString(),
        date: todayIso(),
        lambs: drafts,
        penId: pen === NO_PEN ? null : pen,
        titles: { care: (n) => t('care.recordTitle', { tag: ewe.tag, n: lambs[n - 1]?.n ?? n }), pen: t('care.penTitle', { tag: ewe.tag, pen: penName }) },
      });
      for (const record of queued) {
        // A pen stay carries its own id, so the server knows a repeat of it even without the stored answer.
        const id = uuidv7();
        await outbox.enqueue(record.kind === 'pen_stay' ? { ...record, id, body: { ...record.body, id } } : record);
      }
      if (queued.length > 0) toast.success(t(navigator.onLine ? 'saved.sending' : 'saved.queued'));
      onDone();
    } catch {
      toast.error(t('saved.failed'));
      setSaving(false);
    }
  };

  return (
    <FieldScreen title={t('care.title')} subtitle={t('care.subtitle', { tag: ewe.tag })} backTo={backTo}>
      {drafts.map((draft, index) => (
        <div key={draft.lambId} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
          <p className="text-base font-bold">{t('lambing.lamb', { n: lambs[index].n })}</p>
          <FieldLabel>{t('care.colostrum')}</FieldLabel>
          <ChoiceButtons
            label={t('care.colostrum')}
            value={draft.colostrum ? 'yes' : 'no'}
            onChange={(value: YesNo) => patch(draft.lambId, { colostrum: value === 'yes' })}
            options={yesNo(t('care.given'), t('care.notYet'))}
          />
          <FieldLabel>{t('care.navel')}</FieldLabel>
          <ChoiceButtons
            label={t('care.navel')}
            value={draft.navelTreated ? 'yes' : 'no'}
            onChange={(value: YesNo) => patch(draft.lambId, { navelTreated: value === 'yes' })}
            options={yesNo(t('care.treated'), t('care.notYet'))}
          />
          <FieldLabel>{t('care.mothering')}</FieldLabel>
          <ChoiceButtons<Mothering>
            label={t('care.mothering')}
            columns={3}
            value={draft.mothering}
            onChange={(mothering) => patch(draft.lambId, { mothering })}
            options={[
              { value: 'with_dam', label: t('enums:lambMothering.with_dam') },
              { value: 'fostered', label: t('enums:lambMothering.fostered') },
              { value: 'bottle', label: t('enums:lambMothering.bottle') },
            ]}
          />
          {draft.mothering === 'fostered' && (
            <AnimalPicker
              id={`foster-${draft.lambId}`}
              animals={ewes}
              value={fosters[draft.lambId] ?? null}
              label={t('care.fosterEwe')}
              onChange={(animal) => {
                setFosters((current) => ({ ...current, [draft.lambId]: animal }));
                patch(draft.lambId, { fosterEweId: animal?.id ?? null });
              }}
            />
          )}
        </div>
      ))}
      {pens.length > 0 && (
        <div className="flex flex-col gap-2">
          <FieldLabel>{t('care.pen')}</FieldLabel>
          <ChoiceButtons
            label={t('care.pen')}
            value={pen}
            onChange={setPen}
            options={[{ value: NO_PEN, label: t('care.noPen') }, ...pens.map((item) => ({ value: item.id, label: item.name }))]}
          />
        </div>
      )}
      <Button variant="outline" size="lg" className="min-h-14 w-full" onClick={onDone} disabled={saving}>
        {t('care.skip')}
      </Button>
      <SaveBar label={t('care.save')} onClick={() => void save()} disabled={!careReady(drafts)} busy={saving} />
    </FieldScreen>
  );
}
