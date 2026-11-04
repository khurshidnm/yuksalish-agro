import { Upload } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage, useApiMutation } from '@/lib/query';
import type { ImportJob } from './types';

const ACCEPT = '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv';

interface UploadButtonProps {
  template: string;
  label: string;
  variant?: 'primary' | 'secondary' | 'outline';
  onUploaded: (job: ImportJob) => void;
  /** A file problem stays on screen: people need to read it while they go and fix the file. */
  onError: (message: string | null) => void;
}

export function UploadButton({ template, label, variant = 'primary', onUploaded, onError }: UploadButtonProps) {
  const { t, i18n } = useTranslation('import');
  const input = useRef<HTMLInputElement>(null);

  const upload = useApiMutation<File, ImportJob>({
    mutationFn: (file) => api.postFile<ImportJob>(`/import/${template}?lang=${i18n.language}`, file),
    invalidate: ['/import/jobs'],
    silentError: true,
    onSuccess: (job) => {
      onError(null);
      onUploaded(job);
    },
    onError: (error) => onError(errorMessage(error)),
  });

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so that choosing the same file again, after fixing it, fires a change.
          event.target.value = '';
          if (file) upload.mutate(file);
        }}
      />
      <Button variant={variant} loading={upload.isPending} onClick={() => input.current?.click()}>
        <Upload aria-hidden />
        {upload.isPending ? t('page.uploading') : label}
      </Button>
    </>
  );
}
