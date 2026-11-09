import { Camera, CheckCircle2, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormDialog, FormField, SelectField, TextareaField } from '@/components';
import { Alert, Button, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { zOptionalRef, zOptionalText, zRef } from '@/lib/forms';
import { errorMessage, useApiMutation, useDetail } from '@/lib/query';
import type { RECORD_TYPES, Task } from './types';

interface Candidate {
  id: string;
  date: string;
  label: string | null;
}

/** The enum that names each kind of record in the picker. */
const RECORD_LABEL_GROUP: Record<(typeof RECORD_TYPES)[number], string> = {
  health_record: 'healthRecordType',
  vaccination_record: 'healthRecordType',
  field_operation: 'operationType',
  daily_log: 'herdCondition',
  weight_record: 'weightMethod',
};

/** Where to create the record a task is waiting for. */
const RECORD_PAGES: Record<(typeof RECORD_TYPES)[number], string> = {
  health_record: '/livestock/health',
  vaccination_record: '/livestock/health',
  field_operation: '/crops/operations',
  daily_log: '/livestock/daily-logs',
  weight_record: '/livestock/animals',
};

interface PhotoPickerProps {
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  invalid?: boolean;
  id?: string;
}

/** Opens the rear camera on phones; uploads at once, so the form only carries the file id. */
function PhotoPicker({ value, onChange, invalid, id }: PhotoPickerProps) {
  const { t } = useTranslation('tasks');
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const uploaded = await api.upload(file);
      onChange(uploaded.id);
      setPreview(uploaded.url);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="space-y-2">
      <input
        ref={input}
        id={id}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      {value && preview ? (
        <div className="relative w-fit">
          <img src={preview} alt={t('complete.photoPreview')} className="max-h-48 rounded-lg border border-border object-cover" />
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            className="absolute top-1 right-1"
            aria-label={t('complete.removePhoto')}
            onClick={() => {
              onChange(null);
              setPreview(null);
            }}
          >
            <X aria-hidden />
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full"
          loading={uploading}
          aria-invalid={invalid}
          onClick={() => input.current?.click()}
        >
          <Camera aria-hidden />
          {t('complete.takePhoto')}
        </Button>
      )}
    </div>
  );
}

interface CompleteTaskDialogProps {
  task: Task | null;
  onOpenChange: (open: boolean) => void;
}

export function CompleteTaskDialog({ task, onOpenChange }: CompleteTaskDialogProps) {
  const { t } = useTranslation('tasks');
  const requiresRecord = task?.requiresRecord ?? null;

  const candidates = useDetail<Candidate[]>(requiresRecord ? `/tasks/${task!.id}/record-candidates` : null);

  // What the form demands depends on the task, matching the server's own check.
  const schema = useMemo(
    () =>
      z.object({
        note: zOptionalText(1000),
        photoFileId: task?.requiresPhoto ? zRef() : zOptionalRef(),
        recordId: requiresRecord ? zRef() : zOptionalRef(),
      }),
    [task?.requiresPhoto, requiresRecord],
  );

  const complete = useApiMutation<z.output<typeof schema>>({
    mutationFn: (values) => api.post(`/tasks/${task!.id}/complete`, values),
    invalidate: ['/tasks'],
    silentError: true,
  });

  const noRecords = requiresRecord && candidates.data?.length === 0;

  return (
    <FormDialog
      open={task !== null}
      onOpenChange={onOpenChange}
      title={t('complete.title')}
      description={task?.title}
      schema={schema}
      defaultValues={{ note: '', photoFileId: '', recordId: '' }}
      onSubmit={(values) => complete.mutateAsync(values)}
      submitLabel={
        <>
          <CheckCircle2 aria-hidden />
          {t('actions.complete')}
        </>
      }
      successMessage="tasks:toast.completed"
    >
      {(form) => (
        <>
          {requiresRecord && (
            <>
              {candidates.isLoading && <Skeleton className="h-11 w-full" />}
              {noRecords && (
                <Alert tone="warning" title={t('complete.noRecordTitle', { record: t(`record.${requiresRecord}`) })}>
                  <p>{t('complete.noRecordBody')}</p>
                  <Link to={RECORD_PAGES[requiresRecord]} className="mt-1 inline-block font-medium underline">
                    {t('complete.goCreateRecord')}
                  </Link>
                </Alert>
              )}
              {!noRecords && candidates.data && (
                <SelectField
                  form={form}
                  name="recordId"
                  label={t(`record.${requiresRecord}`)}
                  hint={t('complete.recordHint')}
                  required
                  placeholder={t('complete.chooseRecord')}
                  options={candidates.data.map((r) => ({
                    value: r.id,
                    label: r.label ? `${formatDate(r.date)} · ${t(`enums:${RECORD_LABEL_GROUP[requiresRecord]}.${r.label}`)}` : formatDate(r.date),
                  }))}
                />
              )}
            </>
          )}
          {task?.requiresPhoto && (
            <FormField form={form} name="photoFileId" label={t('complete.photo')} required>
              {(field) => <PhotoPicker id={field.id} value={field.value} onChange={field.onChange} invalid={field['aria-invalid']} />}
            </FormField>
          )}
          <TextareaField form={form} name="note" label={t('complete.note')} />
        </>
      )}
    </FormDialog>
  );
}
