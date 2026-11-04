import { Camera, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui';
import { api, type UploadedFile } from '@/lib/api';
import { errorMessage } from '@/lib/query';

interface FileButtonProps {
  onUploaded: (file: UploadedFile) => void;
  /** Open the phone camera directly and accept images only. */
  camera?: boolean;
  label: string;
  accept?: string;
}

/** Picks a file and uploads it at once, so the form only ever holds finished uploads. */
export function FileButton({ onUploaded, camera, label, accept }: FileButtonProps) {
  const { t } = useTranslation('vet');
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const onChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      onUploaded(await api.upload(file));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setUploading(false);
    }
  };

  const Icon = camera ? Camera : Upload;
  return (
    <>
      <input
        ref={input}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label={label}
        accept={camera ? 'image/*' : (accept ?? 'image/jpeg,image/png,image/webp,application/pdf')}
        capture={camera ? 'environment' : undefined}
        onChange={(event) => void onChange(event)}
      />
      <Button type="button" variant="outline" loading={uploading} onClick={() => input.current?.click()}>
        <Icon aria-hidden />
        {uploading ? t('common.uploading') : label}
      </Button>
    </>
  );
}
