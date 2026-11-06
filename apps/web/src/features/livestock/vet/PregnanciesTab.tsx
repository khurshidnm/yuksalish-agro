import { BREEDING_SOURCES } from '@yap/shared';
import { Baby, HeartPulse, Pencil, Plus, Trash2, Users, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { ComboboxField, type Column, DataTable, DateField, FormDialog, FormGrid, SelectField, TextareaField, useConfirm, useUrlParam } from '@/components';
import { Alert, Badge, Button, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { zDate, zEnum, zOptionalRef, zOptionalText, zRef } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { ANIMALS_PATH, BREEDING_PATH, animalOptions, herdOptions } from './options';
import type { BulkResult, InbreedingCheck, Pregnancy } from './types';

const STATUSES = ['pregnant', 'lambed', 'aborted', 'failed'] as const;

const createSchema = z.object({
  eweId: zRef(),
  ramId: zOptionalRef(),
  matingDate: zDate(),
  source: zEnum(BREEDING_SOURCES),
  notes: zOptionalText(1000),
});

const editSchema = z.object({ ramId: zOptionalRef(), matingDate: zDate(), notes: zOptionalText(1000) });

const bulkSchema = z.object({
  herdId: zRef(),
  ramId: zOptionalRef(),
  matingDate: zDate(),
  source: zEnum(BREEDING_SOURCES),
  notes: zOptionalText(1000),
});

const closeSchema = z.object({ status: zEnum(['aborted', 'failed'] as const), notes: zOptionalText(1000) });

function InbreedingNotice({ eweId, ramId }: { eweId?: string | null; ramId?: string | null }) {
  const { t } = useTranslation('vet');
  const { data } = useDetail<InbreedingCheck>(eweId && ramId ? `${BREEDING_PATH}/inbreeding-check` : null, eweId && ramId ? { eweId, ramId } : undefined);
  if (!data?.related) return null;
  return (
    <Alert tone="warning" title={t('pregnancies.inbreedingTitle')}>
      {t('pregnancies.inbreedingBody', { tags: data.common.map((c) => c.tag ?? '?').join(', ') })}
    </Alert>
  );
}

function dueBadge(row: Pregnancy, t: (key: string, options?: Record<string, unknown>) => string) {
  if (row.status !== 'pregnant') return <Badge>{t(`enums:breedingStatus.${row.status}`)}</Badge>;
  if (row.daysToExpected < 0) return <Badge variant="danger">{t('pregnancies.daysLate', { count: -row.daysToExpected })}</Badge>;
  if (row.daysToExpected <= 7) return <Badge variant="warning">{t('pregnancies.daysLeft', { count: row.daysToExpected })}</Badge>;
  return <Badge variant="info">{t('pregnancies.daysLeft', { count: row.daysToExpected })}</Badge>;
}

export function PregnanciesTab() {
  const { t } = useTranslation('vet');
  const navigate = useNavigate();
  const confirm = useConfirm();
  const canRecord = usePermission('livestock.create');
  const canRecordVet = usePermission('health.update');
  const canChange = usePermission('livestock.update') || canRecordVet;
  const canDelete = usePermission('livestock.delete');
  const canCreate = canRecord || canRecordVet;

  const [status, setStatus] = useUrlParam('pStatus', 'pregnant');
  const [creating, setCreating] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [editing, setEditing] = useState<Pregnancy | null>(null);
  const [closing, setClosing] = useState<Pregnancy | null>(null);

  const invalidate = [BREEDING_PATH, ANIMALS_PATH];
  const create = useApiMutation<z.output<typeof createSchema>, { inbreeding: InbreedingCheck | null }>({
    mutationFn: (values) => api.post(BREEDING_PATH, values),
    invalidate,
    silentError: true,
  });
  const update = useApiMutation<z.output<typeof editSchema>>({
    mutationFn: (values) => api.patch(`${BREEDING_PATH}/${editing!.id}`, values),
    invalidate,
    silentError: true,
  });
  const close = useApiMutation<z.output<typeof closeSchema>>({
    mutationFn: (values) => api.post(`${BREEDING_PATH}/${closing!.id}/close`, values),
    invalidate,
    silentError: true,
  });
  const bulkCreate = useApiMutation<z.output<typeof bulkSchema>, BulkResult>({
    mutationFn: (values) => api.post(`${BREEDING_PATH}/bulk`, values),
    invalidate,
    silentError: true,
    onSuccess: (result) => {
      toast.success(t('pregnancies.bulkDone', { count: result.created }));
      if (result.skipped.length) toast.warning(t('pregnancies.bulkSkipped', { count: result.skipped.length }));
      if (result.inbreeding.length) toast.warning(t('pregnancies.bulkInbreeding', { count: result.inbreeding.length }));
    },
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${BREEDING_PATH}/${id}`),
    invalidate,
    successMessage: 'common:toast.deleted',
  });

  const columns: Column<Pregnancy>[] = [
    {
      key: 'tag',
      header: t('common.ewe'),
      sortable: true,
      mobile: 'title',
      cell: (row) => (
        <Link className="relative font-medium text-primary after:absolute after:inset-x-0 after:-inset-y-3 hover:underline" to={`/livestock/animals/${row.eweId}`}>
          {row.eweTag}
        </Link>
      ),
    },
    { key: 'expectedDate', header: t('pregnancies.expected'), sortable: true, mobile: 'subtitle', cell: (row) => formatDate(row.expectedDate) },
    { key: 'due', header: t('pregnancies.due'), cell: (row) => dueBadge(row, t) },
    { key: 'matingDate', header: t('pregnancies.matingDate'), sortable: true, cell: (row) => formatDate(row.matingDate) },
    {
      key: 'window',
      header: t('pregnancies.window'),
      mobile: 'hidden',
      cell: (row) => `${formatDate(row.expectedEarliest)} – ${formatDate(row.expectedLatest)}`,
    },
    { key: 'ram', header: t('common.ram'), cell: (row) => row.ramTag ?? '—' },
    { key: 'herd', header: t('common.herd'), mobile: 'hidden', cell: (row) => row.herdName ?? '—' },
    { key: 'source', header: t('pregnancies.source'), mobile: 'hidden', cell: (row) => t(`enums:breedingSource.${row.source}`) },
  ];

  return (
    <>
      <DataTable<Pregnancy>
        path={BREEDING_PATH}
        urlPrefix="p"
        params={{ status: status === 'all' ? undefined : status }}
        columns={columns}
        defaultSort="expectedDate"
        searchPlaceholder={t('common.searchTag')}
        filters={
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <Select
              aria-label={t('pregnancies.statusFilter')}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              options={[{ value: 'all', label: t('common.all') }, ...enumOptions('breedingStatus', STATUSES)]}
              className="md:w-48"
            />
            {canCreate && (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setCreating(true)} className="flex-1 md:flex-none">
                  <Plus aria-hidden />
                  {t('pregnancies.add')}
                </Button>
                <Button variant="outline" onClick={() => setBulk(true)} className="flex-1 md:flex-none">
                  <Users aria-hidden />
                  {t('pregnancies.bulkAdd')}
                </Button>
              </div>
            )}
          </div>
        }
        empty={{ icon: HeartPulse, title: t('pregnancies.emptyTitle'), description: t('pregnancies.emptyBody') }}
        rowActions={(row) => {
          const open = row.status === 'pregnant';
          return [
            {
              label: t('pregnancies.recordLambing'),
              icon: Baby,
              hidden: !open || !canCreate,
              onClick: () => navigate(`?tab=lambing&ewe=${row.eweId}&tag=${encodeURIComponent(row.eweTag)}`),
            },
            { label: t('common:actions.edit'), icon: Pencil, hidden: !open || !canChange, onClick: () => setEditing(row) },
            { label: t('pregnancies.close'), icon: XCircle, hidden: !open || !canChange, onClick: () => setClosing(row) },
            {
              label: t('common:actions.delete'),
              icon: Trash2,
              destructive: true,
              hidden: !open || !canDelete,
              onClick: async () => {
                const ok = await confirm({
                  title: t('pregnancies.deleteTitle'),
                  description: t('pregnancies.deleteBody', { tag: row.eweTag }),
                  destructive: true,
                });
                if (ok) remove.mutate(row.id);
              },
            },
          ];
        }}
      />

      <FormDialog
        open={creating}
        onOpenChange={setCreating}
        title={t('pregnancies.add')}
        description={t('pregnancies.addHint')}
        schema={createSchema}
        defaultValues={{ eweId: '', ramId: null, matingDate: '', source: 'mating', notes: '' }}
        onSubmit={async (values) => {
          const result = await create.mutateAsync(values);
          if (result.inbreeding?.related) toast.warning(t('pregnancies.inbreedingTitle'));
        }}
        successMessage="common:toast.created"
      >
        {(form) => (
          <>
            <ComboboxField form={form} name="eweId" label={t('common.ewe')} required loadOptions={animalOptions({ sex: 'female', forBreeding: 'true' })} />
            <FormGrid>
              <DateField form={form} name="matingDate" label={t('pregnancies.matingDate')} required />
              <SelectField form={form} name="source" label={t('pregnancies.source')} required options={enumOptions('breedingSource', BREEDING_SOURCES)} />
            </FormGrid>
            <ComboboxField form={form} name="ramId" label={t('common.ram')} loadOptions={animalOptions({ sex: 'male', forBreeding: 'true' })} />
            <InbreedingNotice eweId={form.watch('eweId')} ramId={form.watch('ramId')} />
            <TextareaField form={form} name="notes" label={t('common.notes')} />
          </>
        )}
      </FormDialog>

      <FormDialog
        open={bulk}
        onOpenChange={setBulk}
        title={t('pregnancies.bulkAdd')}
        description={t('pregnancies.bulkHint')}
        schema={bulkSchema}
        defaultValues={{ herdId: '', ramId: null, matingDate: '', source: 'mating', notes: '' }}
        onSubmit={(values) => bulkCreate.mutateAsync(values)}
      >
        {(form) => (
          <>
            <ComboboxField form={form} name="herdId" label={t('common.herd')} required loadOptions={herdOptions()} />
            <FormGrid>
              <DateField form={form} name="matingDate" label={t('pregnancies.matingDate')} required />
              <SelectField form={form} name="source" label={t('pregnancies.source')} required options={enumOptions('breedingSource', BREEDING_SOURCES)} />
            </FormGrid>
            <ComboboxField form={form} name="ramId" label={t('common.ram')} loadOptions={animalOptions({ sex: 'male', forBreeding: 'true' })} />
            <TextareaField form={form} name="notes" label={t('common.notes')} />
          </>
        )}
      </FormDialog>

      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={t('pregnancies.edit', { tag: editing?.eweTag })}
        description={t('pregnancies.editHint')}
        schema={editSchema}
        defaultValues={{ ramId: editing?.ramId ?? null, matingDate: editing?.matingDate ?? '', notes: editing?.notes ?? '' }}
        onSubmit={(values) => update.mutateAsync(values)}
        successMessage="common:toast.updated"
      >
        {(form) => (
          <>
            <DateField form={form} name="matingDate" label={t('pregnancies.matingDate')} required />
            <ComboboxField form={form} name="ramId" label={t('common.ram')} loadOptions={animalOptions({ sex: 'male', forBreeding: 'true' })} selectedLabel={editing?.ramTag} />
            <InbreedingNotice eweId={editing?.eweId} ramId={form.watch('ramId')} />
            <TextareaField form={form} name="notes" label={t('common.notes')} />
          </>
        )}
      </FormDialog>

      <FormDialog
        open={closing !== null}
        onOpenChange={(open) => !open && setClosing(null)}
        title={t('pregnancies.closeTitle', { tag: closing?.eweTag })}
        description={t('pregnancies.closeHint')}
        schema={closeSchema}
        defaultValues={{ status: 'aborted', notes: closing?.notes ?? '' }}
        onSubmit={(values) => close.mutateAsync(values)}
        successMessage="common:toast.updated"
      >
        {(form) => (
          <>
            <SelectField form={form} name="status" label={t('pregnancies.outcome')} required options={enumOptions('breedingStatus', ['aborted', 'failed'])} />
            <TextareaField form={form} name="notes" label={t('common.notes')} />
          </>
        )}
      </FormDialog>
    </>
  );
}
