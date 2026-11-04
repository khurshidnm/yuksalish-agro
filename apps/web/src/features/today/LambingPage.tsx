import { todayIso } from '@yap/shared';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Alert, Textarea } from '@/components/ui';
import { outbox, uuidv7 } from '@/lib/outbox';
import { useAnimalDirectory } from './data';
import { AnimalPicker, ChoiceButtons, FieldLabel, FieldScreen, SaveBar, Stepper } from './field-ui';
import type { DirectoryAnimal } from './logic';

interface Lamb {
  id: string;
  sex: 'female' | 'male' | null;
  alive: 'alive' | 'dead';
  birthWeightKg: number | null;
}

const newLamb = (): Lamb => ({ id: uuidv7(), sex: null, alive: 'alive', birthWeightKg: null });

/** Done at night in a barn, so the tag, the count and each lamb's sex are all it asks for. */
export default function LambingPage() {
  const { t } = useTranslation('today');
  const navigate = useNavigate();
  const { animals, known } = useAnimalDirectory();
  const [ewe, setEwe] = useState<DirectoryAnimal | null>(null);
  const [lambs, setLambs] = useState<Lamb[]>([newLamb()]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const ewes = useMemo(() => animals.filter((a) => a.sex === 'female' && !a.category.startsWith('lamb')), [animals]);

  const setCount = (value: '1' | '2' | '3') => {
    const count = Number(value);
    setLambs((current) => [...current.slice(0, count), ...Array.from({ length: Math.max(0, count - current.length) }, newLamb)]);
  };
  const patch = (id: string, change: Partial<Lamb>) =>
    setLambs((current) => current.map((lamb) => (lamb.id === id ? { ...lamb, ...change } : lamb)));

  const ready = ewe !== null && lambs.every((lamb) => lamb.sex !== null);

  const save = async () => {
    if (!ewe) return;
    setSaving(true);
    const id = uuidv7();
    try {
      await outbox.enqueue({
        id,
        kind: 'lambing',
        path: '/livestock/lambings',
        body: {
          id,
          eweId: ewe.id,
          date: todayIso(),
          lambs: lambs.map((lamb) => ({ id: lamb.id, sex: lamb.sex, birthWeightKg: lamb.birthWeightKg, alive: lamb.alive === 'alive' })),
          notes: notes.trim() || null,
        },
        title: t('lambing.recordTitle', { tag: ewe.tag, n: lambs.length }),
        meta: { tag: ewe.tag },
      });
      toast.success(t(navigator.onLine ? 'saved.sending' : 'saved.queued'));
      void navigate('/today');
    } catch {
      toast.error(t('saved.failed'));
      setSaving(false);
    }
  };

  return (
    <FieldScreen title={t('actions.lambing')}>
      {!known && <Alert tone="warning">{t('animal.noList')}</Alert>}
      <AnimalPicker animals={ewes} value={ewe} onChange={setEwe} label={t('lambing.ewe')} />
      <div className="flex flex-col gap-2">
        <FieldLabel>{t('lambing.count')}</FieldLabel>
        <ChoiceButtons
          label={t('lambing.count')}
          columns={3}
          value={String(lambs.length) as '1' | '2' | '3'}
          onChange={setCount}
          options={[
            { value: '1', label: '1' },
            { value: '2', label: '2' },
            { value: '3', label: '3' },
          ]}
        />
      </div>
      {lambs.map((lamb, index) => (
        <div key={lamb.id} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
          <p className="text-base font-bold">{t('lambing.lamb', { n: index + 1 })}</p>
          <ChoiceButtons
            label={t('lambing.sex')}
            value={lamb.sex}
            onChange={(sex) => patch(lamb.id, { sex })}
            options={[
              { value: 'female', label: t('lambing.female') },
              { value: 'male', label: t('lambing.male') },
            ]}
          />
          <ChoiceButtons
            label={t('lambing.state')}
            value={lamb.alive}
            onChange={(alive) => patch(lamb.id, { alive })}
            options={[
              { value: 'alive', label: t('lambing.alive') },
              { value: 'dead', label: t('lambing.dead') },
            ]}
          />
          <Stepper label={t('lambing.weight')} value={lamb.birthWeightKg} onChange={(birthWeightKg) => patch(lamb.id, { birthWeightKg })} step={0.5} unit={t('enums:unit.kg')} />
        </div>
      ))}
      <div className="flex flex-col gap-2">
        <FieldLabel htmlFor="lambing-notes">{t('log.notes')}</FieldLabel>
        <Textarea id="lambing-notes" rows={2} className="text-base" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      </div>
      <SaveBar label={t('lambing.save')} onClick={() => void save()} disabled={!ready} busy={saving} />
    </FieldScreen>
  );
}
