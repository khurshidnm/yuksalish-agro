import { FileBadge, FileText, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ComboboxField, type Column, DataTable, DateField, FormDialog, FormGrid, SelectField, TextField, TextareaField, useConfirm } from '@/components';
import { Badge, Button } from '@/components/ui';
import { api, type UploadedFile } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { zOptionalDate, zOptionalEnum, zOptionalRef, zOptionalText, zText } from '@/lib/forms';
import { useApiMutation } from '@/lib/query';
import { todayIso } from '@yap/shared';
import { FileButton } from './FileButton';
import { HEALTH_PATH, animalOptions, herdOptions } from './options';
import type { VetDocument } from './types';

const PATH = `${HEALTH_PATH}/documents`;

const schema = z.object({
  title: zText(200),
  number: zOptionalText(60),
  issueDate: zOptionalDate(),
  expiryDate: zOptionalDate(),
  entityType: zOptionalEnum(['animal', 'herd'] as const),
  entityId: zOptionalRef(),
  notes: zOptionalText(1000),
});

export function DocumentsTab() {
  const { t } = useTranslation('vet');
  const confirm = useConfirm();
  const canWrite = usePermission('health.update');
  const canDelete = usePermission('health.delete');
  const [adding, setAdding] = useState(false);
  const [file, setFile] = useState<UploadedFile | null>(null);

  const create = useApiMutation<z.output<typeof schema>>({
    mutationFn: (values) => api.post(PATH, { ...values, fileId: file?.id ?? null }),
    invalidate: [PATH],
    silentError: true,
    onSuccess: () => setFile(null),
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: [PATH],
    successMessage: 'common:toast.deleted',
  });

  const today = todayIso();
  const columns: Column<VetDocument>[] = [
    {
      key: 'title',
      header: t('documents.name'),
      sortable: true,
      mobile: 'title',
      cell: (row) =>
        row.fileUrl ? (
          <a className="inline-flex items-center gap-1 font-medium text-primary hover:underline" href={row.fileUrl} target="_blank" rel="noreferrer">
            <FileText className="size-4" aria-hidden />
            {row.title}
          </a>
        ) : (
          <span className="font-medium">{row.title}</span>
        ),
    },
    { key: 'number', header: t('documents.number'), cell: (row) => row.number ?? '—' },
    { key: 'issueDate', header: t('documents.issued'), sortable: true, mobile: 'subtitle', cell: (row) => formatDate(row.issueDate) },
    {
      key: 'expiry',
      header: t('documents.expires'),
      cell: (row) =>
        row.expiryDate && row.expiryDate < today ? <Badge variant="danger">{formatDate(row.expiryDate)}</Badge> : formatDate(row.expiryDate),
    },
  ];

  return (
    <>
      <DataTable<VetDocument>
        path={PATH}
        urlPrefix="d"
        columns={columns}
        searchPlaceholder={t('documents.searchPlaceholder')}
        filters={
          canWrite && (
            <Button onClick={() => setAdding(true)}>
              <Plus aria-hidden />
              {t('documents.add')}
            </Button>
          )
        }
        empty={{ icon: FileBadge, title: t('documents.emptyTitle'), description: t('documents.emptyBody') }}
        rowActions={(row) => [
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({ title: t('documents.deleteTitle'), description: t('documents.deleteBody', { name: row.title }), destructive: true });
              if (ok) remove.mutate(row.id);
            },
          },
        ]}
      />
      <FormDialog
        open={adding}
        onOpenChange={(open) => {
          setAdding(open);
          if (!open) setFile(null);
        }}
        title={t('documents.add')}
        schema={schema}
        defaultValues={{ title: '', number: '', issueDate: todayIso(), expiryDate: '', entityType: '' as never, entityId: null, notes: '' }}
        onSubmit={(values) => create.mutateAsync(values)}
        successMessage="common:toast.created"
      >
        {(form) => {
          const entityType = form.watch('entityType');
          return (
            <>
              <TextField form={form} name="title" label={t('documents.name')} required autoFocus placeholder={t('documents.namePlaceholder')} />
              <FormGrid>
                <TextField form={form} name="number" label={t('documents.number')} />
                <SelectField
                  form={form}
                  name="entityType"
                  label={t('documents.linkedTo')}
                  placeholder={t('documents.notLinked')}
                  options={[
                    { value: 'herd', label: t('common.herd') },
                    { value: 'animal', label: t('common.animal') },
                  ]}
                />
                <DateField form={form} name="issueDate" label={t('documents.issued')} />
                <DateField form={form} name="expiryDate" label={t('documents.expires')} />
              </FormGrid>
              {entityType === 'herd' && <ComboboxField form={form} name="entityId" label={t('common.herd')} loadOptions={herdOptions()} />}
              {entityType === 'animal' && <ComboboxField form={form} name="entityId" label={t('common.animal')} loadOptions={animalOptions()} />}
              <div className="flex flex-wrap items-center gap-2">
                <FileButton label={t('documents.attach')} onUploaded={setFile} />
                {file && <span className="text-sm text-muted-foreground">{file.name}</span>}
              </div>
              <TextareaField form={form} name="notes" label={t('common.notes')} />
            </>
          );
        }}
      </FormDialog>
    </>
  );
}
