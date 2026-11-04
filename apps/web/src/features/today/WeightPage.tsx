import { todayIso } from '@yap/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert } from '@/components/ui';
import { outbox, uuidv7 } from '@/lib/outbox';
import { useAnimalDirectory } from './data';
import { AnimalPicker, FieldScreen, SaveBar, Stepper } from './field-ui';
import type { DirectoryAnimal } from './logic';

/** Stays on the page after saving: weighing is one animal after another. */
export default function WeightPage() {
  const { t } = useTranslation('today');
  const { animals, known } = useAnimalDirectory();
  const [animal, setAnimal] = useState<DirectoryAnimal | null>(null);
  const [weightKg, setWeightKg] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [count, setCount] = useState(0);

  const save = async () => {
    if (!animal || !weightKg) return;
    setSaving(true);
    const id = uuidv7();
    try {
      await outbox.enqueue({
        id,
        kind: 'weight',
        path: '/livestock/weights',
        body: { id, animalId: animal.id, date: todayIso(), weightKg, method: 'manual' },
        title: t('weight.recordTitle', { tag: animal.tag, kg: weightKg }),
        meta: { tag: animal.tag },
      });
      setCount((n) => n + 1);
      setAnimal(null);
      setWeightKg(null);
    } catch {
      toast.error(t('saved.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FieldScreen title={t('actions.weight')} subtitle={count > 0 ? t('weight.count', { n: count }) : undefined}>
      {!known && <Alert tone="warning">{t('animal.noList')}</Alert>}
      <AnimalPicker animals={animals} value={animal} onChange={setAnimal} />
      <Stepper label={t('weight.kg')} value={weightKg} onChange={setWeightKg} step={0.5} unit={t('enums:unit.kg')} />
      <SaveBar label={t('weight.save')} onClick={() => void save()} disabled={!animal || !weightKg || weightKg <= 0} busy={saving} />
    </FieldScreen>
  );
}
