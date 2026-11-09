import { EMPLOYEE_STATUSES, monthRange, todayIso } from '@yap/shared';
import { BellRing, Pencil, Plus, RotateCcw, ShieldCheck, Trash2, UserMinus, Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { type Column, DataTable, DataTableView, DateField, FormDialog, FormGrid, ComboboxField, MoneyText, PageHeader, SelectField, TextField, TextareaField, UrlTabs, useConfirm, useUrlParam } from '@/components';
import { Badge, type BadgeVariant, Button, Select, apiOptions } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber, formatQty } from '@/lib/format';
import { zDate, zOptionalDate, zOptionalRef, zOptionalText, zRef, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { EmployeeCard } from './EmployeeCard';
import { EmployeeForm, type LinkableUser } from './EmployeeForm';
import { EMPLOYEE_STATUS_VARIANT, MonthSwitcher, currentMonth, type Employee, type EmployeeLookup } from './shared';

const PATH = '/hr/employees';

const terminateSchema = z.object({ date: zDate(), reason: zOptionalText(500), userId: zOptionalRef() });

function EmployeesTab() {
  const { t } = useTranslation('hr');
  const canCreate = usePermission('hr.create');
  const canUpdate = usePermission('hr.update');
  const canDelete = usePermission('hr.delete');
  const confirm = useConfirm();

  const [status, setStatus] = useUrlParam('status');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [viewing, setViewing] = useState<Employee | null>(null);
  const [leaving, setLeaving] = useState<Employee | null>(null);

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: [PATH],
    successMessage: 'common:toast.deleted',
  });

  const reinstate = useApiMutation<string>({
    mutationFn: (id) => api.post(`${PATH}/${id}/reinstate`),
    invalidate: [PATH],
    successMessage: 'hr:employees.reinstated',
  });

  // The list is what a person answers from when the record has no login, so a login on it is still linked to nobody.
  const logins = useDetail<LinkableUser[]>(leaving && !leaving.userId ? '/hr/linkable-users' : null);
  const loginOptions = (logins.data ?? [])
    .filter((user) => user.employeeId === null)
    .map((user) => ({ value: user.id, label: `${user.fullName} (${t(`enums:role.${user.roleKey}`)})` }));

  const terminate = useApiMutation<z.output<typeof terminateSchema>, { accessEnded: boolean }>({
    mutationFn: (values) => api.post(`${PATH}/${leaving?.id}/terminate`, values),
    invalidate: [PATH, '/hr/linkable-users', '/settings/users'],
    silentError: true,
    // What the server did, not what was hoped for: there may have been no login to end.
    onSuccess: (result) => toast.success(t(result.accessEnded ? 'employees.terminated' : 'employees.terminatedNoLogin')),
  });

  const openForm = (employee: Employee | null) => {
    setEditing(employee);
    setFormOpen(true);
  };

  const columns: Column<Employee>[] = [
    { key: 'fullName', header: t('employees.fields.fullName'), cell: (row) => row.fullName, sortable: true, mobile: 'title' },
    { key: 'position', header: t('employees.fields.position'), cell: (row) => row.position, sortable: true, mobile: 'subtitle' },
    { key: 'payType', header: t('employees.fields.payType'), cell: (row) => t(`enums:payType.${row.payType}`) },
    {
      key: 'baseRate',
      header: t('employees.fields.rate'),
      // A piece worker has no base rate, so a dash says more than "0". The rest say what the rate is for.
      cell: (row) =>
        row.payType === 'piece' || row.baseRate === null ? (
          <MoneyText value={null} />
        ) : (
          <span className="whitespace-nowrap">
            <MoneyText value={row.baseRate} /> <span className="text-muted-foreground">/ {t(`employees.ratePer.${row.payType}`)}</span>
          </span>
        ),
      align: 'right',
    },
    { key: 'hireDate', header: t('employees.fields.hireDate'), cell: (row) => formatDate(row.hireDate), sortable: true, mobile: 'hidden' },
    {
      key: 'status',
      header: t('employees.fields.status'),
      cell: (row) => <Badge variant={EMPLOYEE_STATUS_VARIANT[row.status]}>{t(`enums:employeeStatus.${row.status}`)}</Badge>,
      sortable: true,
    },
  ];

  const add = canCreate && (
    <Button onClick={() => openForm(null)}>
      <Plus aria-hidden />
      {t('employees.add')}
    </Button>
  );

  return (
    <>
      <div className="mb-3 flex justify-end empty:hidden">{add}</div>
      <DataTable<Employee>
        path={PATH}
        params={{ status: status || undefined }}
        columns={columns}
        defaultSort="fullName"
        searchPlaceholder={t('employees.searchPlaceholder')}
        onRowClick={setViewing}
        filters={
          <Select
            aria-label={t('employees.statusFilter')}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={enumOptions('employeeStatus', EMPLOYEE_STATUSES)}
            placeholder={t('employees.allStatuses')}
            className="md:w-56"
          />
        }
        empty={{ icon: Users, title: t('employees.emptyTitle'), description: t('employees.emptyBody'), action: add }}
        rowActions={(row) => [
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => openForm(row) },
          { label: t('employees.terminate'), icon: UserMinus, hidden: !canUpdate || row.status === 'terminated', onClick: () => setLeaving(row) },
          {
            label: t('employees.reinstate'),
            icon: RotateCcw,
            hidden: !canUpdate || row.status !== 'terminated',
            onClick: async () => {
              const ok = await confirm({
                title: t('employees.reinstateTitle'),
                description: t(row.userId ? 'employees.reinstateBody' : 'employees.reinstateBodyNoLogin', { name: row.fullName }),
              });
              if (ok) reinstate.mutate(row.id);
            },
          },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({
                title: t('employees.deleteTitle'),
                description: t('employees.deleteBody', { name: row.fullName }),
                destructive: true,
              });
              if (ok) remove.mutate(row.id);
            },
          },
        ]}
      />

      <EmployeeForm open={formOpen} onOpenChange={setFormOpen} employee={editing} />
      <EmployeeCard employee={viewing} onOpenChange={(open) => !open && setViewing(null)} />

      <FormDialog
        open={leaving !== null}
        onOpenChange={(open) => !open && setLeaving(null)}
        title={t('employees.terminateTitle', { name: leaving?.fullName })}
        description={t(leaving?.userId ? 'employees.terminateBody' : 'employees.terminateBodyNoLogin')}
        schema={terminateSchema}
        defaultValues={{ date: todayIso(), reason: '', userId: '' }}
        onSubmit={(values) => terminate.mutateAsync(values)}
        submitLabel={t('employees.terminate')}
        size="sm"
      >
        {(form) => (
          <>
            <DateField form={form} name="date" label={t('employees.fields.terminationDate')} required max={todayIso()} />
            <TextareaField form={form} name="reason" label={t('employees.fields.terminationReason')} />
            {!leaving?.userId && (
              <SelectField form={form} name="userId" label={t('employees.terminateLogin')} placeholder={t('employees.terminateLoginNone')} options={loginOptions} />
            )}
          </>
        )}
      </FormDialog>
    </>
  );
}

interface Reminder {
  type: 'contract_end' | 'medical_check' | 'vacation_due' | 'safety_expiry';
  employeeId: string;
  fullName: string;
  date: string;
  daysLeft: number;
  detail?: string;
}

function RemindersTab() {
  const { t } = useTranslation('hr');
  const reminders = useDetail<Reminder[]>('/hr/reminders', { days: 60 });

  const when = (row: Reminder) => {
    const variant: BadgeVariant = row.daysLeft < 0 ? 'danger' : row.daysLeft <= 14 ? 'warning' : 'neutral';
    const label = row.daysLeft < 0 ? t('reminders.overdue', { days: -row.daysLeft }) : t('reminders.inDays', { days: row.daysLeft });
    return <Badge variant={variant}>{label}</Badge>;
  };

  const columns: Column<Reminder>[] = [
    { key: 'fullName', header: t('employees.fields.fullName'), cell: (row) => row.fullName, mobile: 'title' },
    {
      key: 'type',
      header: t('reminders.what'),
      cell: (row) => (row.detail ? `${t(`reminders.type.${row.type}`)}: ${row.detail}` : t(`reminders.type.${row.type}`)),
      mobile: 'subtitle',
    },
    { key: 'date', header: t('reminders.date'), cell: (row) => formatDate(row.date) },
    { key: 'daysLeft', header: t('reminders.left'), cell: when },
  ];

  return (
    <DataTableView<Reminder>
      rows={reminders.data ?? []}
      columns={columns}
      rowKey={(row) => `${row.type}-${row.employeeId}-${row.date}-${row.detail ?? ''}`}
      loading={reminders.isLoading}
      error={reminders.error}
      onRetry={() => void reminders.refetch()}
      empty={{ icon: BellRing, title: t('reminders.emptyTitle'), description: t('reminders.emptyBody') }}
    />
  );
}

interface WorkRow {
  employeeId: string;
  fullName: string;
  position: string;
  hectares: number;
  tons: number;
  headTreated: number;
  headDays: number;
  operations: number;
  treatments: number;
  dailyLogs: number;
}

function WorkDoneTab() {
  const { t } = useTranslation('hr');
  const [month, setMonth] = useUrlParam('month', currentMonth());
  const work = useDetail<WorkRow[]>('/hr/work-done', monthRange(month));
  const num = (value: number) => (value ? formatNumber(value) : '—');

  const columns: Column<WorkRow>[] = [
    { key: 'fullName', header: t('employees.fields.fullName'), cell: (row) => row.fullName, mobile: 'title' },
    { key: 'position', header: t('employees.fields.position'), cell: (row) => row.position, mobile: 'subtitle' },
    { key: 'hectares', header: t('workDone.fields.hectares'), cell: (row) => (row.hectares ? formatQty(row.hectares, t('units.ha')) : '—'), align: 'right' },
    { key: 'tons', header: t('workDone.fields.tons'), cell: (row) => (row.tons ? formatQty(row.tons, t('units.t')) : '—'), align: 'right' },
    { key: 'headTreated', header: t('workDone.fields.headTreated'), cell: (row) => num(row.headTreated), align: 'right' },
    { key: 'headDays', header: t('workDone.fields.headDays'), cell: (row) => num(row.headDays), align: 'right' },
    // Irrigation or a field check has no area, so without a count such work would read as nothing done.
    { key: 'operations', header: t('workDone.fields.operations'), cell: (row) => num(row.operations), align: 'right' },
    { key: 'records', header: t('workDone.fields.records'), cell: (row) => num(row.treatments + row.dailyLogs), align: 'right' },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* The month on the left, as on the advances tab. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <MonthSwitcher value={month} onChange={setMonth} />
        <p className="text-sm text-muted-foreground sm:text-right">{t('workDone.description')}</p>
      </div>
      <DataTableView<WorkRow>
        rows={work.data ?? []}
        columns={columns}
        rowKey={(row) => row.employeeId}
        loading={work.isLoading}
        error={work.error}
        onRetry={() => void work.refetch()}
        empty={{ title: t('workDone.emptyTitle'), description: t('workDone.emptyBody') }}
      />
    </div>
  );
}

interface SafetyRow {
  id: string;
  employeeId: string;
  fullName: string;
  title: string;
  signedOn: string | null;
  validUntil: string | null;
}

const safetySchema = z.object({
  employeeId: zRef(),
  title: zText(200),
  signedOn: zOptionalDate(),
  validUntil: zOptionalDate(),
});

function SafetyTab() {
  const { t } = useTranslation('hr');
  const canCreate = usePermission('hr.create');
  const canUpdate = usePermission('hr.update');
  const canDelete = usePermission('hr.delete');
  const confirm = useConfirm();
  const rows = useDetail<SafetyRow[]>('/hr/safety');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SafetyRow | null>(null);

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`/hr/safety/${id}`),
    invalidate: ['/hr/safety'],
    successMessage: 'common:toast.deleted',
  });
  const save = useApiMutation<z.output<typeof safetySchema>>({
    mutationFn: ({ employeeId, ...values }) =>
      editing ? api.patch(`/hr/safety/${editing.id}`, values) : api.post('/hr/safety', { employeeId, ...values }),
    invalidate: ['/hr/safety', '/hr/reminders'],
    silentError: true,
  });

  const columns: Column<SafetyRow>[] = [
    { key: 'title', header: t('safety.fields.title'), cell: (row) => row.title, mobile: 'title' },
    { key: 'fullName', header: t('employees.fields.fullName'), cell: (row) => row.fullName, mobile: 'subtitle' },
    { key: 'signedOn', header: t('safety.fields.signedOn'), cell: (row) => formatDate(row.signedOn) },
    { key: 'validUntil', header: t('safety.fields.validUntil'), cell: (row) => formatDate(row.validUntil) },
  ];

  const add = canCreate && (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('safety.add')}
    </Button>
  );

  return (
    <>
      <div className="mb-3 flex justify-end empty:hidden">{add}</div>
      <DataTableView<SafetyRow>
        rows={rows.data ?? []}
        columns={columns}
        loading={rows.isLoading}
        error={rows.error}
        onRetry={() => void rows.refetch()}
        empty={{ icon: ShieldCheck, title: t('safety.emptyTitle'), description: t('safety.emptyBody'), action: add }}
        rowActions={(row) => [
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(row) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({ title: t('safety.deleteTitle'), description: row.title, destructive: true });
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
        title={editing ? t('safety.edit') : t('safety.add')}
        schema={safetySchema}
        defaultValues={
          editing
            ? { employeeId: editing.employeeId, title: editing.title, signedOn: editing.signedOn ?? '', validUntil: editing.validUntil ?? '' }
            : { employeeId: '', title: '', signedOn: todayIso(), validUntil: '' }
        }
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
      >
        {(form) => (
          <>
            <ComboboxField
              form={form}
              name="employeeId"
              label={t('employees.fields.fullName')}
              required
              disabled={editing !== null}
              selectedLabel={editing?.fullName}
              loadOptions={apiOptions<EmployeeLookup>('/hr/employees/lookup', (p) => ({ value: p.id, label: p.name, hint: p.position }))}
            />
            <TextField form={form} name="title" label={t('safety.fields.title')} required />
            <FormGrid>
              <DateField form={form} name="signedOn" label={t('safety.fields.signedOn')} />
              <DateField form={form} name="validUntil" label={t('safety.fields.validUntil')} />
            </FormGrid>
          </>
        )}
      </FormDialog>
    </>
  );
}

export default function EmployeesPage() {
  const { t } = useTranslation('hr');
  return (
    <>
      <PageHeader title={t('employees.title')} description={t('employees.description')} />
      <UrlTabs
        tabs={[
          { value: 'staff', label: t('tabs.staff'), content: <EmployeesTab /> },
          { value: 'work', label: t('tabs.workDone'), content: <WorkDoneTab /> },
          { value: 'reminders', label: t('tabs.reminders'), content: <RemindersTab /> },
          { value: 'safety', label: t('tabs.safety'), content: <SafetyTab /> },
        ]}
      />
    </>
  );
}
