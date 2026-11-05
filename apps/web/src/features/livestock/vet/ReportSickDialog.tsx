import { X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ComboboxField, FormDialog, TextareaField } from '@/components';
import { Button } from '@/components/ui';
import { api, type UploadedFile } from '@/lib/api';
import { zRef, zText } from '@/lib/forms';
import { useApiMutation } from '@/lib/query';
import { FileButton } from './FileButton';
import { ANIMALS_PATH, HEALTH_PATH, animalOptions } from './options';

const schema = z.object({ animalId: zRef(), note: zText(1000) });

export function ReportSickDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('vet');
  const [photos, setPhotos] = useState<UploadedFile[]>([]);

  const report = useApiMutation<z.output<typeof schema>>({
    mutationFn: (values) =>
      api.postOnce(`${HEALTH_PATH}/report-sick`, { ...values, photoFileIds: photos.map((p) => p.id) }),
    invalidate: [HEALTH_PATH, ANIMALS_PATH],
    silentError: true,
    onSuccess: () => setPhotos([]),
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('sick.report')}
      description={t('sick.reportHint')}
      schema={schema}
      defaultValues={{ animalId: '', note: '' }}
      onSubmit={(values) => report.mutateAsync(values)}
      submitLabel={t('sick.send')}
      successMessage={t('sick.sent')}
    >
      {(form) => (
        <>
          <ComboboxField form={form} name="animalId" label={t('common.animal')} required loadOptions={animalOptions()} />
          <TextareaField form={form} name="note" label={t('sick.whatHappened')} required rows={3} placeholder={t('sick.notePlaceholder')} />
          <div className="space-y-2">
            <FileButton camera label={t('sick.addPhoto')} onUploaded={(file) => setPhotos((current) => [...current, file])} />
            {photos.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {photos.map((photo) => (
                  <li key={photo.id} className="relative">
                    <img src={photo.url} alt={photo.name} className="size-20 rounded-lg object-cover" />
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon-sm"
                      aria-label={t('common.removePhoto')}
                      className="absolute -top-2 -right-2"
                      onClick={() => setPhotos((current) => current.filter((p) => p.id !== photo.id))}
                    >
                      <X aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </FormDialog>
  );
}
