import { DOCUMENT_TYPES } from '@yap/shared';
import { ExternalLink, FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, DataTable, DateField, FormDialog, FormGrid, SelectField, TextField, TextareaField, useConfirm, useUrlParam } from '@/components';
import { Badge, type BadgeVariant, Button, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { zEnum, zOptionalDate, zOptionalRef, zOptionalText, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { FileAttachField } from './FileAttachField';
import type { ExpiryState, FarmDocument } from './types';

const PATH = '/farm/documents';

const EXPIRY_BADGE: Record<ExpiryState, BadgeVariant> = { expired: 'danger', expiring: 'warning', valid: 'success' };

const schema = z.object({
  type: zEnum(DOCUMENT_TYPES),
  title: zText(200),
  number: zOptionalText(80),
  issueDate: zOptionalDate(),
  expiryDate: zOptionalDate(),
  fileId: zOptionalRef(),
  notes: zOptionalText(1000),
});

function toForm(doc: FarmDocument | null, defaultType: FarmDocument['type']): z.input<typeof schema> {
  return {
    type: doc?.type ?? defaultType,
    title: doc?.title ?? '',
    number: doc?.number ?? '',
    issueDate: doc?.issueDate ?? '',
    expiryDate: doc?.expiryDate ?? '',
    fileId: doc?.fileId ?? null,
    notes: doc?.notes ?? '',
  };
}

export interface DocumentsPanelProps {
  /** Show only one object's documents; new documents link to it. */
  entity?: { type: string; id: string };
  defaultType?: FarmDocument['type'];
  /** Rendered beside the filters by a parent page, or left out for a compact tab. */
  header?: (add: ReactNode) => ReactNode;
  /** Needed when two tables share a page. */
  urlPrefix?: string;
}

/** The document archive. Stands alone on its page and fits inside any object's card. */
export function DocumentsPanel({ entity, defaultType = 'other', header, urlPrefix }: DocumentsPanelProps) {
  const { t } = useTranslation('farm');
  const canCreate = usePermission('farm.create');
  const canUpdate = usePermission('farm.update');
  const canDelete = usePermission('farm.delete');
  const confirm = useConfirm();

  const [type, setType] = useUrlParam(`${urlPrefix ?? ''}type`);
  const [expiry, setExpiry] = useUrlParam(`${urlPrefix ?? ''}expiry`);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<FarmDocument | null>(null);

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: [PATH],
    successMessage: 'common:toast.deleted',
  });

  const save = useApiMutation<z.output<typeof schema>>({
    mutationFn: (values) =>
      editing ? api.patch(`${PATH}/${editing.id}`, values) : api.post(PATH, { ...values, ...(entity ? { entityType: entity.type, entityId: entity.id } : {}) }),
    invalidate: [PATH],
    silentError: true,
  });

  const columns: Column<FarmDocument>[] = [
    { key: 'title', header: t('documents.docTitle'), cell: (row) => row.title, sortable: true, mobile: 'title' },
    { key: 'type', header: t('documents.type'), cell: (row) => <Badge>{t(`enums:documentType.${row.type}`)}</Badge>, sortable: true, mobile: 'subtitle' },
    { key: 'number', header: t('documents.number'), cell: (row) => row.number ?? '—' },
    { key: 'issueDate', header: t('documents.issueDate'), cell: (row) => formatDate(row.issueDate), sortable: true, mobile: 'hidden' },
    {
      key: 'expiryDate',
      header: t('documents.expiryDate'),
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          {formatDate(row.expiryDate)}
          {row.expiryState && row.expiryState !== 'valid' && <Badge variant={EXPIRY_BADGE[row.expiryState]}>{t(`documents.state.${row.expiryState}`)}</Badge>}
        </span>
      ),
      sortable: true,
    },
    {
      key: 'file',
      header: t('documents.file'),
      cell: (row) =>
        row.fileUrl ? (
          <a href={row.fileUrl} target="_blank" rel="noreferrer" className="focus-ring inline-flex items-center gap-1 rounded text-primary underline-offset-2 hover:underline">
            <ExternalLink className="size-4" aria-hidden />
            {t('documents.openFile')}
          </a>
        ) : (
          '—'
        ),
    },
  ];

  const addButton = canCreate && (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('documents.add')}
    </Button>
  );

  return (
    <>
      {header ? header(addButton) : <div className="mb-3 flex justify-end empty:hidden">{addButton}</div>}

      <DataTable<FarmDocument>
        path={PATH}
        urlPrefix={urlPrefix}
        params={{
          type: type || undefined,
          expiry: expiry || undefined,
          entityType: entity?.type,
          entityId: entity?.id,
        }}
        columns={columns}
        searchPlaceholder={t('documents.searchPlaceholder')}
        filters={
          <>
            <Select
              aria-label={t('documents.typeFilter')}
              value={type}
              onChange={(e) => setType(e.target.value)}
              options={enumOptions('documentType', DOCUMENT_TYPES)}
              placeholder={t('documents.allTypes')}
              className="md:w-52"
            />
            <Select
              aria-label={t('documents.expiryFilter')}
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              options={[
                { value: 'expiring', label: t('documents.state.expiring') },
                { value: 'expired', label: t('documents.state.expired') },
              ]}
              placeholder={t('documents.anyExpiry')}
              className="md:w-52"
            />
          </>
        }
        empty={{ icon: FileText, title: t('documents.emptyTitle'), description: t('documents.emptyBody'), action: addButton }}
        rowActions={(row) => [
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(row) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({
                title: t('documents.deleteTitle'),
                description: t('documents.deleteBody', { name: row.title }),
                destructive: true,
              });
              if (ok) remove.mutate(row.id);
            },
          },
        ]}
      />

      <FormDialog
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        title={editing ? t('documents.edit') : t('documents.add')}
        schema={schema}
        defaultValues={toForm(editing, defaultType)}
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
        size="lg"
      >
        {(form) => (
          <>
            <FormGrid>
              <SelectField form={form} name="type" label={t('documents.type')} required options={enumOptions('documentType', DOCUMENT_TYPES)} />
              <TextField form={form} name="number" label={t('documents.number')} />
            </FormGrid>
            <TextField form={form} name="title" label={t('documents.docTitle')} required autoFocus />
            <FormGrid>
              <DateField form={form} name="issueDate" label={t('documents.issueDate')} />
              <DateField form={form} name="expiryDate" label={t('documents.expiryDate')} hint={t('documents.expiryHint')} />
            </FormGrid>
            <FileAttachField form={form} name="fileId" label={t('documents.file')} currentName={editing?.fileName} />
            <TextareaField form={form} name="notes" label={t('notes')} rows={3} />
          </>
        )}
      </FormDialog>
    </>
  );
}
