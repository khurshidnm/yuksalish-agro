/**
 * Reference feature. New pages copy this shape:
 *  - DataTable reads the list endpoint; search, sort and page live in the URL.
 *  - FormDialog handles validation, submit state and server errors.
 *  - Mutations go through useApiMutation, which invalidates the list and shows toasts.
 *  - Buttons appear only with the permission, and the server enforces it regardless.
 *  - Every string is translated, and every option list comes from a shared enum.
 */
import { COUNTERPARTY_TYPES } from '@yap/shared';
import { BookUser, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, DataTable, FormDialog, FormGrid, PageHeader, SelectField, TextField, TextareaField, useConfirm, useUrlParam } from '@/components';
import { Badge, Button, Select, Separator } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { zEnum, zOptionalText, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';

const PATH = '/finance/counterparties';

interface BankDetails {
  bankName?: string | null;
  account?: string | null;
  mfo?: string | null;
}

interface Counterparty {
  id: string;
  name: string;
  tin: string | null;
  type: (typeof COUNTERPARTY_TYPES)[number];
  phone: string | null;
  address: string | null;
  contactPerson: string | null;
  notes: string | null;
  bankDetails: BankDetails | null;
}

const schema = z.object({
  name: zText(200),
  tin: zOptionalText(14),
  type: zEnum(COUNTERPARTY_TYPES),
  phone: zOptionalText(32),
  address: zOptionalText(300),
  contactPerson: zOptionalText(200),
  notes: zOptionalText(),
  bankDetails: z.object({
    bankName: zOptionalText(200),
    account: zOptionalText(34),
    mfo: zOptionalText(10),
  }),
});

type FormValues = z.input<typeof schema>;

const EMPTY: FormValues = {
  name: '',
  tin: '',
  type: 'supplier',
  phone: '',
  address: '',
  contactPerson: '',
  notes: '',
  bankDetails: { bankName: '', account: '', mfo: '' },
};

function toForm(row: Counterparty): FormValues {
  return {
    ...EMPTY,
    ...row,
    bankDetails: {
      bankName: row.bankDetails?.bankName ?? '',
      account: row.bankDetails?.account ?? '',
      mfo: row.bankDetails?.mfo ?? '',
    },
  };
}

export default function CounterpartiesPage() {
  const { t } = useTranslation('finance');
  const canCreate = usePermission('finance.create');
  const canUpdate = usePermission('finance.update');
  const canDelete = usePermission('finance.delete');
  const confirm = useConfirm();

  const [type, setType] = useUrlParam('type');
  const [editing, setEditing] = useState<Counterparty | null>(null);
  const [creating, setCreating] = useState(false);

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: [PATH],
    successMessage: 'common:toast.deleted',
  });

  const save = (values: z.output<typeof schema>) => (editing ? api.patch(`${PATH}/${editing.id}`, values) : api.post(PATH, values));
  const saveMutation = useApiMutation({
    mutationFn: save,
    invalidate: [PATH],
    // FormDialog shows the error inside the form, so no toast as well.
    silentError: true,
  });

  const columns: Column<Counterparty>[] = [
    { key: 'name', header: t('counterparties.fields.name'), cell: (row) => row.name, sortable: true, mobile: 'title' },
    {
      key: 'type',
      header: t('counterparties.fields.type'),
      cell: (row) => <Badge>{t(`enums:counterpartyType.${row.type}`)}</Badge>,
      sortable: true,
      mobile: 'subtitle',
    },
    { key: 'tin', header: t('counterparties.fields.tin'), cell: (row) => row.tin ?? '—' },
    { key: 'phone', header: t('counterparties.fields.phone'), cell: (row) => row.phone ?? '—' },
    { key: 'contactPerson', header: t('counterparties.fields.contactPerson'), cell: (row) => row.contactPerson ?? '—', mobile: 'hidden' },
  ];

  return (
    <>
      <PageHeader
        title={t('counterparties.title')}
        description={t('counterparties.description')}
        actions={
          canCreate && (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('counterparties.add')}
            </Button>
          )
        }
      />

      <DataTable<Counterparty>
        path={PATH}
        params={{ type: type || undefined }}
        columns={columns}
        defaultSort="name"
        searchPlaceholder={t('counterparties.searchPlaceholder')}
        filters={
          <Select
            aria-label={t('counterparties.typeFilter')}
            value={type}
            onChange={(e) => setType(e.target.value)}
            options={enumOptions('counterpartyType', COUNTERPARTY_TYPES)}
            placeholder={t('counterparties.allTypes')}
            className="md:w-56"
          />
        }
        empty={{
          icon: BookUser,
          title: t('counterparties.emptyTitle'),
          description: t('counterparties.emptyBody'),
          action: canCreate && (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('counterparties.add')}
            </Button>
          ),
        }}
        rowActions={(row) => [
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(row) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({
                title: t('counterparties.deleteTitle'),
                description: t('counterparties.deleteBody', { name: row.name }),
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
        title={editing ? t('counterparties.edit') : t('counterparties.add')}
        schema={schema}
        defaultValues={editing ? toForm(editing) : EMPTY}
        onSubmit={(values) => saveMutation.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
        size="lg"
      >
        {(form) => (
          <>
            <TextField form={form} name="name" label={t('counterparties.fields.name')} required autoFocus />
            <FormGrid>
              <SelectField form={form} name="type" label={t('counterparties.fields.type')} required options={enumOptions('counterpartyType', COUNTERPARTY_TYPES)} />
              <TextField form={form} name="tin" label={t('counterparties.fields.tin')} hint={t('counterparties.fields.tinHint')} inputMode="numeric" />
              <TextField form={form} name="phone" label={t('counterparties.fields.phone')} type="tel" inputMode="tel" />
              <TextField form={form} name="contactPerson" label={t('counterparties.fields.contactPerson')} />
            </FormGrid>
            <TextField form={form} name="address" label={t('counterparties.fields.address')} />
            <Separator />
            <p className="text-sm font-medium">{t('counterparties.fields.bankSection')}</p>
            <FormGrid>
              <TextField form={form} name="bankDetails.bankName" label={t('counterparties.fields.bankName')} />
              <TextField form={form} name="bankDetails.mfo" label={t('counterparties.fields.mfo')} inputMode="numeric" />
            </FormGrid>
            <TextField form={form} name="bankDetails.account" label={t('counterparties.fields.account')} inputMode="numeric" />
            <TextareaField form={form} name="notes" label={t('counterparties.fields.notes')} />
          </>
        )}
      </FormDialog>
    </>
  );
}
