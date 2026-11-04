import { todayIso } from '@yap/shared';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Alert, Textarea } from '@/components/ui';
import { outbox, useOutbox, uuidv7 } from '@/lib/outbox';
import { useAnimalDirectory } from './data';
import { AnimalPicker, ChoiceButtons, FieldLabel, FieldScreen, PhotoCapture, SaveBar, type LocalPhoto } from './field-ui';
import { animalsLeaving, type DirectoryAnimal } from './logic';

const REASONS = ['disease', 'predator', 'accident', 'unknown'] as const;
type Reason = (typeof REASONS)[number];

export default function DeathPage() {
  const { t } = useTranslation('today');
  const navigate = useNavigate();
  const { animals, known } = useAnimalDirectory();
  const { records } = useOutbox();
  const [animal, setAnimal] = useState<DirectoryAnimal | null>(null);
  const [reason, setReason] = useState<Reason | null>(null);
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [saving, setSaving] = useState(false);

  const available = useMemo(() => {
    const leaving = animalsLeaving(records);
    return animals.filter((a) => !leaving.has(a.id));
  }, [animals, records]);

  const save = async () => {
    if (!animal || !reason) return;
    setSaving(true);
    const id = uuidv7();
    try {
      await outbox.enqueue({
        id,
        kind: 'death',
        path: '/livestock/exits',
        body: { id, animalId: animal.id, type: 'death', date: todayIso(), reason: t(`death.reasons.${reason}`), notes: notes.trim() || null },
        title: t('death.recordTitle', { tag: animal.tag }),
        meta: { tag: animal.tag },
        photoField: 'photoFileIds',
        photos: photos.map(({ name, blob }) => ({ name, blob })),
      });
      toast.success(t(navigator.onLine ? 'saved.sending' : 'saved.queued'));
      void navigate('/today');
    } catch {
      toast.error(t('saved.failed'));
      setSaving(false);
    }
  };

  return (
    <FieldScreen title={t('actions.record_death')}>
      {!known && <Alert tone="warning">{t('animal.noList')}</Alert>}
      <AnimalPicker animals={available} value={animal} onChange={setAnimal} />
      <div className="flex flex-col gap-2">
        <FieldLabel>{t('death.reason')}</FieldLabel>
        <ChoiceButtons label={t('death.reason')} value={reason} onChange={setReason} options={REASONS.map((r) => ({ value: r, label: t(`death.reasons.${r}`) }))} />
      </div>
      <div className="flex flex-col gap-2">
        <FieldLabel htmlFor="death-notes">{t('log.notes')}</FieldLabel>
        <Textarea id="death-notes" rows={2} className="text-base" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      </div>
      <PhotoCapture photos={photos} onChange={setPhotos} max={3} />
      <SaveBar label={t('death.save')} onClick={() => void save()} disabled={!animal || !reason} busy={saving} />
    </FieldScreen>
  );
}
