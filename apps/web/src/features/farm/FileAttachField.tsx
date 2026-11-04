import { FileText, Paperclip, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { FieldPath, FieldValues, UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/components';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/query';

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.xlsx,.csv';

export interface FileAttachFieldProps<F extends FieldValues, N extends FieldPath<F>> {
  // The form's output type does not matter to a field.
  // biome-ignore lint: react-hook-form's third generic must stay open here.
  form: UseFormReturn<F, any, any>;
  name: N;
  label: string;
  /** Name of the file already attached, when editing. */
  currentName?: string | null;
}

/** A scan or photo for a record: uploads straight away and keeps the file id in the form. */
export function FileAttachField<F extends FieldValues, N extends FieldPath<F>>({ form, name, label, currentName }: FileAttachFieldProps<F, N>) {
  const { t } = useTranslation('farm');
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <FormField form={form} name={name} label={label}>
      {(field) => {
        const shown = field.value ? (uploaded ?? currentName ?? t('documents.fileAttached')) : null;
        return (
          <div className="flex flex-col gap-1.5">
            <input
              id={inputId}
              ref={input}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              tabIndex={-1}
              aria-label={label}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                setUploading(true);
                setError(null);
                try {
                  const stored = await api.upload(file);
                  setUploaded(stored.name);
                  field.onChange(stored.id);
                } catch (cause) {
                  setError(errorMessage(cause));
                } finally {
                  setUploading(false);
                }
              }}
            />
            {shown ? (
              <div className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3">
                <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm">{shown}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('documents.removeFile')}
                  onClick={() => {
                    setUploaded(null);
                    field.onChange(null);
                  }}
                >
                  <X aria-hidden />
                </Button>
              </div>
            ) : (
              <Button variant="outline" className="self-start" loading={uploading} onClick={() => input.current?.click()}>
                <Paperclip aria-hidden />
                {t('documents.chooseFile')}
              </Button>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        );
      }}
    </FormField>
  );
}
