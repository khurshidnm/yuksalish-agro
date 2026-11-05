import { KPI_METRICS, KPI_REWARD_TYPES } from '@yap/shared/formulas/payroll';
import { todayIso } from '@yap/shared';
import { Banknote, Gauge, HandCoins, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, ComboboxField, DataTable, DataTableView, DateField, FormDialog, FormGrid, MoneyText, NumberField, PageHeader, SelectField, SwitchField, TextField, TextareaField, UrlTabs, useConfirm, useUrlParam } from '@/components';
import { Badge, Button, apiOptions } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { currencyLabel, formatDate, formatMonth, formatNumber } from '@/lib/format';
import { zDate, zEnum, zNonNegative, zOptionalText, zPositive, zRef, zText } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';
import { RUN_STATUS_VARIANT, RunDetail, type PayrollRun, type RunStatus } from './RunDetail';
import { MonthSwitcher, currentMonth, shiftMonth, type EmployeeLookup } from './shared';

const PATH = '/hr/payroll';

const runSchema = z.object({ month: zText(7), notes: zOptionalText(500) });

interface RunRow {
  id: string;
  month: string;
  status: RunStatus;
  totalGross: number;
  totalNet: number;
}

/** The last year of months, newest first. */
function monthOptions() {
  const now = currentMonth();
  return Array.from({ length: 12 }, (_, i) => {
    const value = shiftMonth(now, -i);
    return { value, label: formatMonth(value) };
  });
}

function RunsTab() {
  const { t } = useTranslation('hr');
  const canCreate = usePermission('payroll.create');
  const [runId, setRunId] = useUrlParam('run');
  const [creating, setCreating] = useState(false);

  const create = useApiMutation<z.output<typeof runSchema>, PayrollRun>({
    mutationFn: (values) => api.postOnce<PayrollRun>(PATH, values),
    invalidate: [PATH],
    silentError: true,
    onSuccess: (run) => setRunId(run.id),
  });

  if (runId) return <RunDetail runId={runId} onBack={() => setRunId('')} />;

  const columns: Column<RunRow>[] = [
    { key: 'month', header: t('payroll.fields.month'), cell: (row) => formatMonth(row.month), sortable: true, mobile: 'title' },
    {
      key: 'status',
      header: t('payroll.fields.status'),
      cell: (row) => <Badge variant={RUN_STATUS_VARIANT[row.status]}>{t(`enums:payrollStatus.${row.status}`)}</Badge>,
      sortable: true,
      mobile: 'subtitle',
    },
    { key: 'totalGross', header: t('payroll.fields.gross'), cell: (row) => <MoneyText value={row.totalGross} />, align: 'right' },
    { key: 'totalNet', header: t('payroll.fields.net'), cell: (row) => <MoneyText value={row.totalNet} />, align: 'right' },
  ];

  const add = canCreate && (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('payroll.add')}
    </Button>
  );

  return (
    <>
      <div className="mb-3 flex justify-end empty:hidden">{add}</div>
      <DataTable<RunRow>
        path={PATH}
        columns={columns}
        searchable={false}
        defaultSort="-month"
        urlPrefix="runs_"
        onRowClick={(row) => setRunId(row.id)}
        empty={{ icon: Banknote, title: t('payroll.emptyTitle'), description: t('payroll.emptyBody'), action: add }}
      />
      <FormDialog
        open={creating}
        onOpenChange={setCreating}
        title={t('payroll.add')}
        description={t('payroll.addBody')}
        schema={runSchema}
        defaultValues={{ month: shiftMonth(currentMonth(), -1), notes: '' }}
        onSubmit={(values) => create.mutateAsync(values)}
        submitLabel={t('payroll.calculate')}
        size="sm"
      >
        {(form) => (
          <>
            <SelectField form={form} name="month" label={t('payroll.fields.month')} required options={monthOptions()} />
            <TextareaField form={form} name="notes" label={t('employees.fields.notes')} rows={2} />
          </>
        )}
      </FormDialog>
    </>
  );
}

interface AdvanceRow {
  id: string;
  employeeId: string;
  fullName: string;
  date: string;
  month: string;
  amount: number;
  accountName: string | null;
  transactionStatus: string | null;
  notes: string | null;
}

const advanceSchema = z.object({
  employeeId: zRef(),
  date: zDate(),
  amount: zPositive(),
  accountId: zRef(),
  notes: zOptionalText(300),
});

function AdvancesTab() {
  const { t } = useTranslation('hr');
  const canCreate = usePermission('payroll.create');
  const [month, setMonth] = useUrlParam('advMonth', currentMonth());
  const [creating, setCreating] = useState(false);
  const advances = useDetail<AdvanceRow[]>('/hr/advances', { month });
  const accounts = useDetail<{ id: string; name: string }[]>(creating ? '/finance/accounts/lookup' : null);

  const save = useApiMutation<z.output<typeof advanceSchema>>({
    mutationFn: (values) => api.postOnce('/hr/advances', values),
    invalidate: ['/hr/advances'],
    silentError: true,
  });

  const columns: Column<AdvanceRow>[] = [
    { key: 'fullName', header: t('employees.fields.fullName'), cell: (row) => row.fullName, mobile: 'title' },
    { key: 'date', header: t('advances.date'), cell: (row) => formatDate(row.date), mobile: 'subtitle' },
    { key: 'amount', header: t('advances.amount'), cell: (row) => <MoneyText value={row.amount} />, align: 'right' },
    { key: 'accountName', header: t('payroll.account'), cell: (row) => row.accountName ?? '—' },
    {
      key: 'status',
      header: t('payroll.fields.status'),
      cell: (row) =>
        row.transactionStatus && (
          <Badge variant={row.transactionStatus === 'approved' ? 'success' : row.transactionStatus === 'pending' ? 'warning' : 'danger'}>
            {t(`enums:transactionStatus.${row.transactionStatus}`)}
          </Badge>
        ),
    },
  ];

  const add = canCreate && (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('advances.add')}
    </Button>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <MonthSwitcher value={month} onChange={setMonth} />
        {add}
      </div>
      <DataTableView<AdvanceRow>
        rows={advances.data ?? []}
        columns={columns}
        loading={advances.isLoading}
        error={advances.error}
        onRetry={() => void advances.refetch()}
        empty={{ icon: HandCoins, title: t('advances.emptyTitle'), description: t('advances.emptyBody'), action: add }}
      />
      <FormDialog
        open={creating}
        onOpenChange={setCreating}
        title={t('advances.add')}
        description={t('advances.addBody')}
        schema={advanceSchema}
        defaultValues={{ employeeId: '', date: todayIso(), amount: 0, accountId: '', notes: '' }}
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage="common:toast.created"
      >
        {(form) => (
          <>
            <ComboboxField
              form={form}
              name="employeeId"
              label={t('employees.fields.fullName')}
              required
              loadOptions={apiOptions<EmployeeLookup>('/hr/employees/lookup', (p) => ({ value: p.id, label: p.name, hint: p.position }))}
            />
            <FormGrid>
              <DateField form={form} name="date" label={t('advances.date')} required />
              <NumberField money form={form} name="amount" label={t('advances.amount')} suffix={currencyLabel()} required maxDigits={2} />
            </FormGrid>
            <SelectField
              form={form}
              name="accountId"
              label={t('payroll.account')}
              required
              options={(accounts.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
            />
            <TextareaField form={form} name="notes" label={t('employees.fields.notes')} rows={2} />
          </>
        )}
      </FormDialog>
    </div>
  );
}

interface KpiRule {
  id: string;
  name: string;
  metric: (typeof KPI_METRICS)[number];
  position: string | null;
  threshold: number;
  rewardType: (typeof KPI_REWARD_TYPES)[number];
  amount: number;
  active: boolean;
}

const kpiSchema = z.object({
  name: zText(120),
  metric: zEnum(KPI_METRICS),
  position: zOptionalText(120),
  threshold: zNonNegative(),
  rewardType: zEnum(KPI_REWARD_TYPES),
  amount: zNonNegative(),
  active: z.boolean(),
});

function KpiRulesTab() {
  const { t } = useTranslation('hr');
  const canCreate = usePermission('payroll.create');
  const canUpdate = usePermission('payroll.update');
  const canDelete = usePermission('payroll.delete');
  const confirm = useConfirm();
  const rules = useDetail<KpiRule[]>('/hr/kpi-rules');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<KpiRule | null>(null);

  const save = useApiMutation<z.output<typeof kpiSchema>>({
    mutationFn: (values) => (editing ? api.patch(`/hr/kpi-rules/${editing.id}`, values) : api.post('/hr/kpi-rules', values)),
    invalidate: ['/hr/kpi-rules'],
    silentError: true,
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`/hr/kpi-rules/${id}`),
    invalidate: ['/hr/kpi-rules'],
    successMessage: 'common:toast.deleted',
  });

  const metricOptions = KPI_METRICS.map((value) => ({ value, label: t(`kpi.metric.${value}`) }));
  const rewardOptions = KPI_REWARD_TYPES.map((value) => ({ value, label: t(`kpi.reward.${value}`) }));

  const columns: Column<KpiRule>[] = [
    { key: 'name', header: t('kpi.fields.name'), cell: (row) => row.name, mobile: 'title' },
    { key: 'position', header: t('employees.fields.position'), cell: (row) => row.position ?? t('kpi.everyone'), mobile: 'subtitle' },
    { key: 'metric', header: t('kpi.fields.metric'), cell: (row) => t(`kpi.metric.${row.metric}`) },
    { key: 'threshold', header: t('kpi.fields.threshold'), cell: (row) => formatNumber(row.threshold), align: 'right' },
    {
      key: 'amount',
      header: t('kpi.fields.amount'),
      cell: (row) => (
        <>
          <MoneyText value={row.amount} /> <span className="text-muted-foreground">{t(`kpi.rewardShort.${row.rewardType}`)}</span>
        </>
      ),
      align: 'right',
    },
    {
      key: 'active',
      header: t('kpi.fields.active'),
      cell: (row) => <Badge variant={row.active ? 'success' : 'neutral'}>{row.active ? t('kpi.on') : t('kpi.off')}</Badge>,
    },
  ];

  const add = canCreate && (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('kpi.add')}
    </Button>
  );

  return (
    <>
      <p className="mb-3 text-sm text-muted-foreground">{t('kpi.description')}</p>
      <div className="mb-3 flex justify-end empty:hidden">{add}</div>
      <DataTableView<KpiRule>
        rows={rules.data ?? []}
        columns={columns}
        loading={rules.isLoading}
        error={rules.error}
        onRetry={() => void rules.refetch()}
        empty={{ icon: Gauge, title: t('kpi.emptyTitle'), description: t('kpi.emptyBody'), action: add }}
        rowActions={(row) => [
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(row) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({ title: t('kpi.deleteTitle'), description: row.name, destructive: true });
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
        title={editing ? t('kpi.edit') : t('kpi.add')}
        schema={kpiSchema}
        defaultValues={
          editing
            ? { ...editing, position: editing.position ?? '' }
            : { name: '', metric: 'hectares', position: '', threshold: 0, rewardType: 'fixed', amount: 0, active: true }
        }
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
      >
        {(form) => (
          <>
            <TextField form={form} name="name" label={t('kpi.fields.name')} required autoFocus />
            <FormGrid>
              <SelectField form={form} name="metric" label={t('kpi.fields.metric')} required options={metricOptions} />
              <TextField form={form} name="position" label={t('employees.fields.position')} placeholder={t('kpi.everyone')} />
              <NumberField form={form} name="threshold" label={t('kpi.fields.threshold')} required maxDigits={3} />
              <SelectField form={form} name="rewardType" label={t('kpi.fields.rewardType')} required options={rewardOptions} />
              <NumberField money form={form} name="amount" label={t('kpi.fields.amount')} suffix={currencyLabel()} required maxDigits={2} />
            </FormGrid>
            <SwitchField form={form} name="active" label={t('kpi.fields.active')} />
          </>
        )}
      </FormDialog>
    </>
  );
}

export default function PayrollPage() {
  const { t } = useTranslation('hr');
  return (
    <>
      <PageHeader title={t('payroll.title')} description={t('payroll.description')} />
      <UrlTabs
        tabs={[
          { value: 'runs', label: t('tabs.runs'), content: <RunsTab /> },
          { value: 'advances', label: t('tabs.advances'), content: <AdvancesTab /> },
          { value: 'kpi', label: t('tabs.kpi'), content: <KpiRulesTab /> },
        ]}
      />
    </>
  );
}
