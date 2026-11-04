import { todayIso } from '@yap/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Textarea } from '@/components/ui';
import { outbox, uuidv7 } from '@/lib/outbox';
import { useAnimalDirectory } from './data';
import { AnimalPicker, FieldLabel, FieldScreen, PhotoCapture, QuickPhrases, SaveBar, type LocalPhoto } from './field-ui';
import type { DirectoryAnimal } from './logic';

const SYMPTOMS = ['notEating', 'limping', 'coughing', 'diarrhea', 'lyingDown'] as const;

export default function ReportSickPage() {
  const { t } = useTranslation('today');
  const navigate = useNavigate();
  const { animals } = useAnimalDirectory();
  const [animal, setAnimal] = useState<DirectoryAnimal | null>(null);
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [saving, setSaving] = useState(false);

  const tag = typed.trim();
  // The server can still resolve a tag this phone has not heard of, e.g. a lamb born today.
  const ready = (animal !== null || tag !== '') && note.trim() !== '';

  const save = async () => {
    setSaving(true);
    const id = uuidv7();
    try {
      await outbox.enqueue({
        id,
        kind: 'sick_report',
        path: '/livestock/health/report-sick',
        body: { id, ...(animal ? { animalId: animal.id } : { tag }), date: todayIso(), note: note.trim() },
        title: t('sick.recordTitle', { tag: animal?.tag ?? tag }),
        meta: { tag: animal?.tag ?? tag },
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

  const addPhrase = (phrase: string) => setNote((current) => (current.trim() ? `${current.trim()}, ${phrase.toLowerCase()}` : phrase));

  return (
    <FieldScreen title={t('actions.report_sick')}>
      <AnimalPicker animals={animals} value={animal} onChange={setAnimal} onTextChange={setTyped} />
      <div className="flex flex-col gap-2">
        <FieldLabel htmlFor="sick-note">{t('sick.note')}</FieldLabel>
        <QuickPhrases phrases={SYMPTOMS.map((s) => t(`sick.symptoms.${s}`))} onPick={addPhrase} />
        <Textarea id="sick-note" rows={2} className="text-base" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </div>
      <PhotoCapture photos={photos} onChange={setPhotos} max={3} />
      <SaveBar label={t('sick.save')} onClick={() => void save()} disabled={!ready} busy={saving} />
    </FieldScreen>
  );
}
