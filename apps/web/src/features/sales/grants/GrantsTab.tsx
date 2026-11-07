import { addDays, todayIso } from '@yap/shared';
import { CalendarClock, CheckCircle2, HandCoins, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, DataTable, DateField, FormDialog, FormGrid, MoneyText, NumberField, SelectField, TextField, TextareaField, useConfirm, useUrlParam } from '@/components';
import { Badge, Button, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { zDate, zEnum, zOptionalDate, zOptionalNumber, zOptionalText, zText } from '@/lib/forms';
import { useApiMutation } from '@/lib/query';
import { GRANT_KINDS, GRANT_STATUSES, type GrantRow, REPORT_AUTHORITIES, REPORT_PERIODS, type StateReportRow } from '../types';

const GRANTS = '/sales/grants';
const REPORTS = '/sales/state-reports';

const grantSchema = z.object({
  title: zText(200),
  program: zOptionalText(200),
  kind: zEnum(GRANT_KINDS),
  amount: zOptionalNumber(),
  status: zEnum(GRANT_STATUSES),
  submittedOn: zOptionalDate(),
  decisionOn: zOptionalDate(),
  notes: zOptionalText(1000),
});

const reportSchema = z.object({
  title: zText(200),
  authority: zEnum(REPORT_AUTHORITIES),
  period: zEnum(REPORT_PERIODS),
  dueDate: zDate(),
  notes: zOptionalText(1000),
});

const GRANT_VARIANT: Record<GrantRow['status'], 'neutral' | 'info' | 'warning' | 'success' | 'outline'> = {
  draft: 'neutral',
  submitted: 'info',
  in_review: 'warning',
  approved: 'success',
  rejected: 'outline',
  received: 'success',
};

function GrantsSection() {
  const { t } = useTranslation('sales');
  const can = useCan();
  const canCreate = can('sales.create') || can('finance.create');
  const canUpdate = can('sales.update') || can('finance.update');
  const canDelete = can('sales.delete') || can('finance.delete');
  const confirm = useConfirm();
  const [status, setStatus] = useUrlParam('grantStatus');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<GrantRow | null>(null);

  const statusOptions = GRANT_STATUSES.map((value) => ({ value, label: t(`grants.status.${value}`) }));

  const save = useApiMutation<z.output<typeof grantSchema>>({
    mutationFn: (values) => (editing ? api.patch(`${GRANTS}/${editing.id}`, values) : api.postOnce(GRANTS, values)),
    invalidate: [GRANTS],
    silentError: true,
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${GRANTS}/${id}`),
    invalidate: [GRANTS],
    successMessage: 'common:toast.deleted',
  });

  const columns: Column<GrantRow>[] = [
    {
      key: 'title',
      header: t('grants.fields.title'),
      cell: (row) => (
        <>
          {row.title}
          {row.program && <span className="block text-sm font-normal text-muted-foreground">{row.program}</span>}
        </>
      ),
      sortable: true,
      mobile: 'title',
    },
    { key: 'kind', header: t('grants.fields.kind'), cell: (row) => t(`grants.kind.${row.kind}`), mobile: 'subtitle' },
    {
      key: 'status',
      header: t('grants.fields.status'),
      cell: (row) => <Badge variant={GRANT_VARIANT[row.status]}>{t(`grants.status.${row.status}`)}</Badge>,
      sortable: true,
    },
    { key: 'submittedOn', header: t('grants.fields.submittedOn'), cell: (row) => formatDate(row.submittedOn), sortable: true, mobile: 'hidden' },
    { key: 'amount', header: t('grants.fields.amount'), cell: (row) => <MoneyText value={row.amount} />, sortable: true, align: 'right' },
  ];

  const add = (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('grants.add')}
    </Button>
  );

  return (
    <section className="flex flex-col gap-3" aria-label={t('grants.title')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t('grants.title')}</h2>
        {canCreate && add}
      </div>
      <DataTable<GrantRow>
        path={GRANTS}
        urlPrefix="grants"
        params={{ status: status || undefined }}
        columns={columns}
        searchPlaceholder={t('grants.searchPlaceholder')}
        filters={
          <Select
            aria-label={t('grants.fields.status')}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={statusOptions}
            placeholder={t('grants.allStatuses')}
            className="md:w-56"
          />
        }
        empty={{ icon: HandCoins, title: t('grants.emptyTitle'), description: t('grants.emptyBody'), action: canCreate && add }}
        rowActions={(row) => [
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(row) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({ title: t('grants.deleteTitle'), destructive: true });
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
        title={editing ? t('grants.edit') : t('grants.add')}
        schema={grantSchema}
        defaultValues={
          editing ?? { title: '', program: '', kind: 'subsidy', amount: null, status: 'draft', submittedOn: null, decisionOn: null, notes: '' }
        }
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
        size="lg"
      >
        {(form) => (
          <>
            <TextField form={form} name="title" label={t('grants.fields.title')} required />
            <TextField form={form} name="program" label={t('grants.fields.program')} />
            <FormGrid>
              <SelectField
                form={form}
                name="kind"
                label={t('grants.fields.kind')}
                required
                options={GRANT_KINDS.map((value) => ({ value, label: t(`grants.kind.${value}`) }))}
              />
              <NumberField money form={form} name="amount" label={t('grants.fields.amount')} />
              <SelectField form={form} name="status" label={t('grants.fields.status')} required options={statusOptions} />
              <DateField form={form} name="submittedOn" label={t('grants.fields.submittedOn')} />
              <DateField form={form} name="decisionOn" label={t('grants.fields.decisionOn')} />
            </FormGrid>
            <TextareaField form={form} name="notes" label={t('grants.fields.notes')} rows={2} />
          </>
        )}
      </FormDialog>
    </section>
  );
}

function ReportsSection() {
  const { t } = useTranslation('sales');
  const can = useCan();
  const canCreate = can('sales.create') || can('finance.create');
  const canUpdate = can('sales.update') || can('finance.update');
  const canDelete = can('sales.delete') || can('finance.delete');
  const confirm = useConfirm();
  const [showDone, setShowDone] = useUrlParam('reportsDone');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<StateReportRow | null>(null);

  const save = useApiMutation<z.output<typeof reportSchema>>({
    mutationFn: (values) => (editing ? api.patch(`${REPORTS}/${editing.id}`, values) : api.post(REPORTS, values)),
    invalidate: [REPORTS],
    silentError: true,
  });
  const submit = useApiMutation<string>({
    mutationFn: (id) => api.post(`${REPORTS}/${id}/submit`, {}),
    invalidate: [REPORTS],
    successMessage: 'sales:reports.submitted',
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${REPORTS}/${id}`),
    invalidate: [REPORTS],
    successMessage: 'common:toast.deleted',
  });

  const columns: Column<StateReportRow>[] = [
    { key: 'dueDate', header: t('reports.fields.dueDate'), cell: (row) => formatDate(row.dueDate), sortable: true, mobile: 'subtitle' },
    { key: 'title', header: t('reports.fields.title'), cell: (row) => row.title, sortable: true, mobile: 'title' },
    { key: 'authority', header: t('reports.fields.authority'), cell: (row) => t(`reports.authority.${row.authority}`) },
    { key: 'period', header: t('reports.fields.period'), cell: (row) => t(`reports.period.${row.period}`), mobile: 'hidden' },
    {
      key: 'status',
      header: t('reports.fields.status'),
      cell: (row) => {
        if (row.status === 'submitted') return <Badge variant="success">{t('reports.status.submitted')}</Badge>;
        return row.overdue ? <Badge variant="danger">{t('reports.overdue')}</Badge> : <Badge>{t('reports.status.planned')}</Badge>;
      },
    },
  ];

  const add = (
    <Button variant="outline" onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('reports.add')}
    </Button>
  );

  return (
    <section className="flex flex-col gap-3" aria-label={t('reports.title')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t('reports.title')}</h2>
        {canCreate && add}
      </div>
      <DataTable<StateReportRow>
        path={REPORTS}
        urlPrefix="reports"
        params={{ status: showDone ? undefined : 'planned' }}
        columns={columns}
        defaultSort="dueDate"
        searchable={false}
        filters={
          <Select
            aria-label={t('reports.fields.status')}
            value={showDone}
            onChange={(e) => setShowDone(e.target.value)}
            options={[{ value: 'all', label: t('reports.showAll') }]}
            placeholder={t('reports.showPlanned')}
            className="md:w-56"
          />
        }
        empty={{ icon: CalendarClock, title: t('reports.emptyTitle'), description: t('reports.emptyBody'), action: canCreate && add }}
        rowActions={(row) => [
          {
            label: t('reports.submit'),
            icon: CheckCircle2,
            hidden: !canUpdate || row.status === 'submitted',
            onClick: async () => {
              const ok = await confirm({
                title: t('reports.submitTitle', { title: row.title }),
                description: row.period === 'once' ? undefined : t('reports.submitBody'),
              });
              if (ok) submit.mutate(row.id);
            },
          },
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(row) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({ title: t('reports.deleteTitle'), destructive: true });
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
        title={editing ? t('reports.edit') : t('reports.add')}
        schema={reportSchema}
        defaultValues={
          editing
            ? { title: editing.title, authority: editing.authority, period: editing.period, dueDate: editing.dueDate, notes: editing.notes }
            : { title: '', authority: 'tax', period: 'quarterly', dueDate: addDays(todayIso(), 30), notes: '' }
        }
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
      >
        {(form) => (
          <>
            <TextField form={form} name="title" label={t('reports.fields.title')} required />
            <FormGrid>
              <SelectField
                form={form}
                name="authority"
                label={t('reports.fields.authority')}
                required
                options={REPORT_AUTHORITIES.map((value) => ({ value, label: t(`reports.authority.${value}`) }))}
              />
              <SelectField
                form={form}
                name="period"
                label={t('reports.fields.period')}
                required
                options={REPORT_PERIODS.map((value) => ({ value, label: t(`reports.period.${value}`) }))}
              />
            </FormGrid>
            <DateField form={form} name="dueDate" label={t('reports.fields.dueDate')} required />
            <TextareaField form={form} name="notes" label={t('reports.fields.notes')} rows={2} />
          </>
        )}
      </FormDialog>
    </section>
  );
}

export function GrantsTab() {
  return (
    <div className="flex flex-col gap-8">
      <GrantsSection />
      <ReportsSection />
    </div>
  );
}
