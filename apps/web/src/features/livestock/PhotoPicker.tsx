import { Camera, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui';
import { api, type UploadedFile } from '@/lib/api';
import { errorMessage } from '@/lib/query';
import { compressImage } from './shared';

export interface PhotoPickerProps {
  /** Called with the ids of everything uploaded so far. */
  onChange: (fileIds: string[]) => void;
  max?: number;
}

/** Opens the phone's camera directly. Photos are shrunk before upload and shown as thumbnails. */
export function PhotoPicker({ onChange, max = 5 }: PhotoPickerProps) {
  const { t } = useTranslation('livestock');
  const input = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);

  const update = (next: UploadedFile[]) => {
    setPhotos(next);
    onChange(next.map((p) => p.id));
  };

  const pick = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      update([...photos, await api.upload(await compressImage(file))]);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="space-y-2">
      <input ref={input} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void pick(e.target.files)} />
      {photos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {photos.map((photo) => (
            <div key={photo.id} className="relative">
              <img src={photo.url} alt={photo.name} className="size-20 rounded-lg border border-border object-cover" />
              <button
                type="button"
                aria-label={t('photo.remove')}
                className="focus-ring absolute -top-2 -right-2 flex size-8 items-center justify-center rounded-full bg-foreground text-background"
                onClick={() => update(photos.filter((p) => p.id !== photo.id))}
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
      {photos.length < max && (
        <Button type="button" variant="outline" size="lg" className="w-full" loading={uploading} onClick={() => input.current?.click()}>
          <Camera aria-hidden />
          {t('photo.add')}
        </Button>
      )}
    </div>
  );
}
