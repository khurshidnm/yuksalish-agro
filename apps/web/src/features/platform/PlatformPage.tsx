import { MODULES } from '@yap/shared';
import { Ban, Building2, CheckCircle2, LayoutGrid, Pencil, Plus, Tractor, Users, WalletCards } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { type Column, DataTable, DataTableView, FormDialog, FormField, FormGrid, NumberField, PageHeader, SelectField, StatCard, TextField, UrlTabs, useConfirm, useUrlParam } from '@/components';
import { Badge, Button, Checkbox, Select } from '@/components/ui';
import { ShowOnceDialog } from '@/features/settings/shared';
import { api } from '@/lib/api';
import { formatDate, formatMoney, formatNumber } from '@/lib/format';
import { zOptionalNumber, zOptionalRef, zOptionalText, zText } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';

const TENANTS = '/platform/tenants';
const PLANS = '/platform/plans';
const STATS = '/platform/stats';

interface Tenant {
  id: string;
  name: string;
  legalName: string | null;
  tin: string | null;
  status: 'active' | 'suspended';
  modules: string[];
  planId: string | null;
  planName: string | null;
  farmCount: number;
  memberCount: number;
  createdAt: string;
}

interface Plan {
  id: string;
  key: string;
  name: string;
  modules: string[];
  priceMonthly: number | null;
  active: boolean;
}

interface Stats {
  tenants: number;
  activeTenants: number;
  farms: number;
  members: number;
}

interface CreatedTenant {
  tenant: Tenant;
  oneTimePassword: string | null;
  existingUser: boolean;
}

function ModulePicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
      {MODULES.map((module) => {
        const checked = value.includes(module);
        return (
          <label key={module} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
            <Checkbox checked={checked} onCheckedChange={(next) => onChange(next === true ? [...value, module] : value.filter((m) => m !== module))} />
            {t(`enums:module.${module}`)}
          </label>
        );
      })}
    </div>
  );
}

const createSchema = z.object({
  tenant: z.object({ name: zText(200), legalName: zOptionalText(300), tin: zOptionalText(20), planId: zOptionalRef() }),
  farm: z.object({ name: zText(200), region: zOptionalText(120), district: zOptionalText(120), totalAreaHa: zOptionalNumber() }),
  owner: z.object({ phone: zText(20), fullName: zText(120) }),
});

const tenantEditSchema = z.object({
  name: zText(200),
  planId: zOptionalRef(),
  modules: z.array(z.string()),
});

function TenantsTab() {
  const { t } = useTranslation('platform');
  const confirm = useConfirm();
  const plans = useDetail<Plan[]>(PLANS);
  const planOptions = (plans.data ?? []).filter((plan) => plan.active).map((plan) => ({ value: plan.id, label: plan.name }));
  const [status, setStatus] = useUrlParam('status');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Tenant | null>(null);
  const [created, setCreated] = useState<{ password: string; name: string } | null>(null);

  const create = useApiMutation<z.output<typeof createSchema>, CreatedTenant>({
    mutationFn: (values) => {
      const { tenant, farm, owner } = values;
      const clean = <T extends Record<string, unknown>>(row: T) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== ''));
      return api.post(TENANTS, { tenant: clean(tenant), farm: clean(farm), owner });
    },
    invalidate: [TENANTS, STATS],
    silentError: true,
    onSuccess: (result) => {
      if (result.oneTimePassword) setCreated({ password: result.oneTimePassword, name: result.tenant.name });
      else toast.success(t('tenants.createdExisting'));
    },
  });
  const update = useApiMutation<z.output<typeof tenantEditSchema>>({
    mutationFn: (values) => api.patch(`${TENANTS}/${editing!.id}`, values),
    invalidate: [TENANTS],
    silentError: true,
  });
  const setSuspended = useApiMutation<{ id: string; suspend: boolean }>({
    mutationFn: ({ id, suspend }) => api.post(`${TENANTS}/${id}/${suspend ? 'suspend' : 'reactivate'}`),
    invalidate: [TENANTS, STATS],
    successMessage: 'common:toast.updated',
  });

  const columns: Column<Tenant>[] = [
    { key: 'name', header: t('tenants.name'), cell: (row) => row.name, mobile: 'title' },
    { key: 'planName', header: t('tenants.plan'), cell: (row) => row.planName ?? t('tenants.noPlan'), mobile: 'subtitle' },
    {
      key: 'status',
      header: t('tenants.status'),
      cell: (row) => <Badge variant={row.status === 'active' ? 'success' : 'danger'}>{t(`tenants.statuses.${row.status}`)}</Badge>,
    },
    { key: 'farmCount', header: t('tenants.farms'), cell: (row) => formatNumber(row.farmCount), align: 'right' },
    { key: 'memberCount', header: t('tenants.members'), cell: (row) => formatNumber(row.memberCount), align: 'right' },
    { key: 'modules', header: t('tenants.modules'), cell: (row) => t('tenants.modulesCount', { count: row.modules.length, total: MODULES.length }), mobile: 'hidden' },
    { key: 'createdAt', header: t('tenants.createdAt'), cell: (row) => formatDate(row.createdAt), mobile: 'hidden' },
  ];

  const addButton = (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('tenants.add')}
    </Button>
  );

  return (
    <>
      <div className="mb-3 flex justify-end">{addButton}</div>
      <DataTable<Tenant>
        path={TENANTS}
        params={{ status: status || undefined }}
        columns={columns}
        searchPlaceholder={t('tenants.searchPlaceholder')}
        filters={
          <Select
            aria-label={t('tenants.status')}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: 'active', label: t('tenants.statuses.active') },
              { value: 'suspended', label: t('tenants.statuses.suspended') },
            ]}
            placeholder={t('tenants.allStatuses')}
            className="md:w-48"
          />
        }
        empty={{ icon: Building2, title: t('tenants.emptyTitle'), action: addButton }}
        rowActions={(row) => [
          { label: t('tenants.edit'), icon: Pencil, onClick: () => setEditing(row) },
          row.status === 'active'
            ? {
                label: t('tenants.suspend'),
                icon: Ban,
                destructive: true,
                onClick: () =>
                  void confirm({
                    title: t('tenants.suspendTitle'),
                    description: t('tenants.suspendBody', { name: row.name }),
                    confirmLabel: t('tenants.suspend'),
                    destructive: true,
                  }).then((ok) => ok && setSuspended.mutate({ id: row.id, suspend: true })),
              }
            : { label: t('tenants.reactivate'), icon: CheckCircle2, onClick: () => setSuspended.mutate({ id: row.id, suspend: false }) },
        ]}
      />

      <FormDialog
        open={creating}
        onOpenChange={setCreating}
        title={t('tenants.add')}
        description={t('tenants.addHint')}
        schema={createSchema}
        size="lg"
        defaultValues={{
          tenant: { name: '', legalName: '', tin: '', planId: '' },
          farm: { name: '', region: '', district: '', totalAreaHa: null },
          owner: { phone: '', fullName: '' },
        }}
        onSubmit={(values) => create.mutateAsync(values)}
      >
        {(form) => (
          <>
            <TextField form={form} name="tenant.name" label={t('tenants.name')} required autoFocus />
            <FormGrid>
              <TextField form={form} name="tenant.legalName" label={t('tenants.legalName')} />
              <TextField form={form} name="tenant.tin" label={t('tenants.tin')} inputMode="numeric" />
            </FormGrid>
            <SelectField form={form} name="tenant.planId" label={t('tenants.plan')} hint={t('tenants.planHint')} placeholder={t('tenants.allModules')} options={planOptions} />
            <FormGrid>
              <TextField form={form} name="farm.name" label={t('tenants.farmName')} required />
              <NumberField form={form} name="farm.totalAreaHa" label={t('tenants.area')} suffix={t('tenants.ha')} />
            </FormGrid>
            <FormGrid>
              <TextField form={form} name="farm.region" label={t('tenants.region')} />
              <TextField form={form} name="farm.district" label={t('tenants.district')} />
            </FormGrid>
            <FormGrid>
              <TextField form={form} name="owner.phone" label={t('tenants.ownerPhone')} required inputMode="tel" autoComplete="off" placeholder="+998 90 123 45 67" />
              <TextField form={form} name="owner.fullName" label={t('tenants.ownerName')} required autoComplete="off" />
            </FormGrid>
          </>
        )}
      </FormDialog>

      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={t('tenants.edit')}
        description={editing?.name}
        schema={tenantEditSchema}
        size="lg"
        defaultValues={{ name: editing?.name ?? '', planId: editing?.planId ?? '', modules: editing?.modules ?? [] }}
        successMessage="common:toast.updated"
        onSubmit={(values) => update.mutateAsync(values)}
      >
        {(form) => (
          <>
            <TextField form={form} name="name" label={t('tenants.name')} required />
            <SelectField form={form} name="planId" label={t('tenants.plan')} placeholder={t('tenants.noPlan')} options={planOptions} />
            <FormField form={form} name="modules" label={t('tenants.modules')} hint={t('tenants.modulesHint')}>
              {(field) => <ModulePicker value={(field.value as string[]) ?? []} onChange={field.onChange} />}
            </FormField>
          </>
        )}
      </FormDialog>

      <ShowOnceDialog
        secret={created?.password ?? null}
        title={t('tenants.createdTitle')}
        description={t('tenants.createdBody', { name: created?.name })}
        label={t('tenants.ownerPassword')}
        onClose={() => setCreated(null)}
      />
    </>
  );
}

const planSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9_-]+$/).max(40),
  name: zText(120),
  priceMonthly: zOptionalNumber(),
  modules: z.array(z.string()),
});

function PlansTab() {
  const { t } = useTranslation('platform');
  const confirm = useConfirm();
  const query = useDetail<Plan[]>(PLANS);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);

  const save = useApiMutation<z.output<typeof planSchema>>({
    mutationFn: (values) => (editing ? api.patch(`${PLANS}/${editing.id}`, values) : api.post(PLANS, values)),
    invalidate: [PLANS],
    silentError: true,
  });
  const retire = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PLANS}/${id}`),
    invalidate: [PLANS],
    successMessage: 'common:toast.updated',
  });
  const restore = useApiMutation<string>({
    mutationFn: (id) => api.patch(`${PLANS}/${id}`, { active: true }),
    invalidate: [PLANS],
    successMessage: 'common:toast.updated',
  });

  const columns: Column<Plan>[] = [
    { key: 'name', header: t('plans.name'), cell: (row) => row.name, mobile: 'title' },
    { key: 'key', header: t('plans.key'), cell: (row) => <code className="font-mono text-sm">{row.key}</code>, mobile: 'hidden' },
    { key: 'priceMonthly', header: t('plans.price'), cell: (row) => formatMoney(row.priceMonthly), align: 'right', mobile: 'subtitle' },
    { key: 'modules', header: t('plans.modules'), cell: (row) => t('tenants.modulesCount', { count: row.modules.length, total: MODULES.length }) },
    { key: 'active', header: t('plans.state'), cell: (row) => (row.active ? <Badge variant="success">{t('plans.active')}</Badge> : <Badge>{t('plans.retired')}</Badge>) },
  ];

  const addButton = (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('plans.add')}
    </Button>
  );

  return (
    <>
      <div className="mb-3 flex justify-end">{addButton}</div>
      <DataTableView<Plan>
        rows={query.data ?? []}
        columns={columns}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={{ icon: WalletCards, title: t('plans.emptyTitle'), description: t('plans.emptyBody'), action: addButton }}
        rowActions={(row) => [
          { label: t('common:actions.edit'), icon: Pencil, onClick: () => setEditing(row) },
          row.active
            ? {
                label: t('plans.retire'),
                icon: Ban,
                destructive: true,
                onClick: () =>
                  void confirm({ title: t('plans.retireTitle'), description: t('plans.retireBody', { name: row.name }), confirmLabel: t('plans.retire'), destructive: true }).then((ok) => ok && retire.mutate(row.id)),
              }
            : { label: t('plans.restore'), icon: CheckCircle2, onClick: () => restore.mutate(row.id) },
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
        title={editing ? t('plans.edit') : t('plans.add')}
        schema={planSchema}
        size="lg"
        defaultValues={{ key: editing?.key ?? '', name: editing?.name ?? '', priceMonthly: editing?.priceMonthly ?? null, modules: editing?.modules ?? [] }}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
        onSubmit={(values) => save.mutateAsync(values)}
      >
        {(form) => (
          <>
            <FormGrid>
              <TextField form={form} name="name" label={t('plans.name')} required autoFocus />
              <TextField form={form} name="key" label={t('plans.key')} hint={t('plans.keyHint')} required />
            </FormGrid>
            <NumberField form={form} name="priceMonthly" label={t('plans.price')} />
            <FormField form={form} name="modules" label={t('plans.modules')}>
              {(field) => <ModulePicker value={(field.value as string[]) ?? []} onChange={field.onChange} />}
            </FormField>
          </>
        )}
      </FormDialog>
    </>
  );
}

export default function PlatformPage() {
  const { t } = useTranslation('platform');
  const stats = useDetail<Stats>(STATS);
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('stats.tenants')} value={formatNumber(stats.data?.tenants)} loading={stats.isLoading} icon={Building2} />
        <StatCard label={t('stats.active')} value={formatNumber(stats.data?.activeTenants)} loading={stats.isLoading} icon={LayoutGrid} tone="success" />
        <StatCard label={t('stats.farms')} value={formatNumber(stats.data?.farms)} loading={stats.isLoading} icon={Tractor} />
        <StatCard label={t('stats.members')} value={formatNumber(stats.data?.members)} loading={stats.isLoading} icon={Users} />
      </div>
      <UrlTabs
        tabs={[
          { value: 'tenants', label: t('tenants.tab'), content: <TenantsTab /> },
          { value: 'plans', label: t('plans.tab'), content: <PlansTab /> },
        ]}
      />
    </>
  );
}
