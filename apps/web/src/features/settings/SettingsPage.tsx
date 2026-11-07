import { COSTING_METHODS, CURRENCIES, MAX_UPLOAD_BYTES, OVERHEAD_BASES } from '@yap/shared';
import { Download, FileDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { DataTableView, ErrorCard, FormGrid, NumberField, PageHeader, SelectField, SwitchField, TextField, UrlTabs, type Column } from '@/components';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth, useCan } from '@/lib/auth';
import { formatNumber } from '@/lib/format';
import { zEnum, zNonNegative, zOptionalNumber, zOptionalText, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { errorMessage, useApiMutation, useDetail } from '@/lib/query';
import { FilesTab } from './FilesTab';
import { InlineForm } from './shared';
import { toast } from 'sonner';

const PROFILE = '/settings/profile';
const POLICY = '/settings/policy';

interface Profile {
  tenant: { name: string; legalName: string | null; tin: string | null; legalForm: string | null; taxRegime: string | null };
  farm: { name: string; region: string | null; district: string | null; address: string | null; lat: number | null; lng: number | null };
}

const profileSchema = z.object({
  tenant: z.object({
    name: zText(200),
    legalName: zOptionalText(300),
    tin: zOptionalText(20),
    legalForm: zOptionalText(50),
    taxRegime: zOptionalText(100),
  }),
  farm: z.object({
    name: zText(200),
    region: zOptionalText(120),
    district: zOptionalText(120),
    address: zOptionalText(300),
    lat: zOptionalNumber(),
    lng: zOptionalNumber(),
  }),
});

function FormSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-64 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}

function ProfileTab() {
  const { t } = useTranslation('settings');
  const canUpdate = useCan()('settings.update');
  const { reloadSession } = useAuth();
  const query = useDetail<Profile>(PROFILE);
  const save = useApiMutation<z.output<typeof profileSchema>>({
    mutationFn: (values) => api.patch(PROFILE, values),
    invalidate: [PROFILE],
    silentError: true,
  });

  const values = useMemo(() => {
    if (!query.data) return null;
    const { tenant, farm } = query.data;
    return {
      tenant: {
        name: tenant.name,
        legalName: tenant.legalName ?? '',
        tin: tenant.tin ?? '',
        legalForm: tenant.legalForm ?? '',
        taxRegime: tenant.taxRegime ?? '',
      },
      farm: {
        name: farm.name,
        region: farm.region ?? '',
        district: farm.district ?? '',
        address: farm.address ?? '',
        lat: farm.lat,
        lng: farm.lng,
      },
    };
  }, [query.data]);

  if (query.error) return <ErrorCard error={query.error} onRetry={() => void query.refetch()} />;
  if (!values) return <FormSkeleton />;

  return (
    <InlineForm
      schema={profileSchema}
      values={values}
      readOnly={!canUpdate}
      onSubmit={async (next) => {
        await save.mutateAsync(next);
        // The farm switcher shows these names.
        await reloadSession();
      }}
    >
      {(form) => (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('profile.tenantTitle')}</CardTitle>
              <CardDescription>{t('profile.tenantHint')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <TextField form={form} name="tenant.name" label={t('profile.name')} required />
              <TextField form={form} name="tenant.legalName" label={t('profile.legalName')} />
              <FormGrid>
                <TextField form={form} name="tenant.tin" label={t('profile.tin')} inputMode="numeric" />
                <TextField form={form} name="tenant.legalForm" label={t('profile.legalForm')} placeholder={t('profile.legalFormExample')} />
              </FormGrid>
              <TextField form={form} name="tenant.taxRegime" label={t('profile.taxRegime')} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('profile.farmTitle')}</CardTitle>
              <CardDescription>{t('profile.farmHint')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <TextField form={form} name="farm.name" label={t('profile.farmName')} required />
              <FormGrid>
                <TextField form={form} name="farm.region" label={t('profile.region')} />
                <TextField form={form} name="farm.district" label={t('profile.district')} />
              </FormGrid>
              <TextField form={form} name="farm.address" label={t('profile.address')} />
              <FormGrid>
                <NumberField form={form} name="farm.lat" label={t('profile.lat')} allowNegative maxDigits={6} hint={t('profile.coordinatesHint')} />
                <NumberField form={form} name="farm.lng" label={t('profile.lng')} allowNegative maxDigits={6} />
              </FormGrid>
            </CardContent>
          </Card>
        </>
      )}
    </InlineForm>
  );
}

const policySchema = z.object({
  finance: z.object({ approvalThreshold: zNonNegative(), makerChecker: z.boolean(), overheadBase: zEnum(OVERHEAD_BASES) }),
  inventory: z.object({ costingMethod: zEnum(COSTING_METHODS) }),
  feed: z.object({
    winterDays: z.number().int().min(1).max(366),
    minStockDays: z.number().min(0).max(365),
    deviationPercent: z.number().min(0).max(100),
  }),
  livestock: z.object({ quarantineDays: z.number().int().min(0).max(365), defaultGestationDays: z.number().int().min(1).max(400) }),
  security: z.object({ enforce2fa: z.boolean() }),
  storage: z.object({
    quotaMb: z.number().int().min(100).max(10_000_000),
    dailyUploadMb: z.number().int().min(15).max(1_000_000),
  }),
  retention: z.object({
    notificationDays: z.number().int().min(30).max(3650),
    webhookDeliveryDays: z.number().int().min(7).max(3650),
    aiToolDataDays: z.number().int().min(7).max(3650),
    importDays: z.number().int().min(7).max(3650),
    trackerReadingsDays: z.number().int().min(7).max(365),
    idempotencyDays: z.number().int().min(30).max(365),
  }),
  currency: zEnum(CURRENCIES),
  timezone: zText(60),
});

type Policy = z.input<typeof policySchema>;

const TIME_ZONES = ['Asia/Tashkent', 'Asia/Samarkand', 'Asia/Almaty', 'Asia/Bishkek', 'Asia/Dushanbe', 'Asia/Ashgabat', 'Europe/Moscow', 'UTC'];

function PolicyTab() {
  const { t } = useTranslation('settings');
  const canUpdate = useCan()('settings.update');
  const { reloadSession } = useAuth();
  const query = useDetail<Policy>(POLICY);
  const save = useApiMutation<z.output<typeof policySchema>>({
    mutationFn: (values) => api.patch(POLICY, values),
    invalidate: [POLICY],
    silentError: true,
  });

  if (query.error) return <ErrorCard error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <FormSkeleton />;

  const zones = TIME_ZONES.includes(query.data.timezone) ? TIME_ZONES : [query.data.timezone, ...TIME_ZONES];

  return (
    <InlineForm
      schema={policySchema}
      values={query.data}
      readOnly={!canUpdate}
      onSubmit={async (next) => {
        await save.mutateAsync(next);
        await reloadSession();
      }}
    >
      {(form) => (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('policy.financeTitle')}</CardTitle>
              <CardDescription>{t('policy.financeHint')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <FormGrid>
                <NumberField money form={form} name="finance.approvalThreshold" label={t('policy.approvalThreshold')} hint={t('policy.approvalThresholdHint')} suffix={query.data?.currency} />
                <SelectField form={form} name="finance.overheadBase" label={t('policy.overheadBase')} hint={t('policy.overheadBaseHint')} options={enumOptions('overheadBase', OVERHEAD_BASES)} />
              </FormGrid>
              <SwitchField form={form} name="finance.makerChecker" label={t('policy.makerChecker')} hint={t('policy.makerCheckerHint')} />
              <FormGrid>
                <SelectField form={form} name="currency" label={t('policy.currency')} hint={t('policy.currencyHint')} options={enumOptions('currency', CURRENCIES)} />
                <SelectField form={form} name="timezone" label={t('policy.timezone')} options={zones.map((zone) => ({ value: zone, label: zone }))} />
              </FormGrid>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('policy.stockTitle')}</CardTitle>
              <CardDescription>{t('policy.stockHint')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <SelectField form={form} name="inventory.costingMethod" label={t('policy.costingMethod')} hint={t('policy.costingMethodHint')} options={enumOptions('costingMethod', COSTING_METHODS)} />
              <FormGrid>
                <NumberField form={form} name="feed.winterDays" label={t('policy.winterDays')} hint={t('policy.winterDaysHint')} suffix={t('policy.days')} maxDigits={0} />
                <NumberField form={form} name="feed.minStockDays" label={t('policy.minStockDays')} hint={t('policy.minStockDaysHint')} suffix={t('policy.days')} maxDigits={0} />
              </FormGrid>
              <NumberField form={form} name="feed.deviationPercent" label={t('policy.deviationPercent')} hint={t('policy.deviationPercentHint')} suffix="%" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('policy.livestockTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <FormGrid>
                <NumberField form={form} name="livestock.quarantineDays" label={t('policy.quarantineDays')} suffix={t('policy.days')} maxDigits={0} />
                <NumberField form={form} name="livestock.defaultGestationDays" label={t('policy.gestationDays')} hint={t('policy.gestationDaysHint')} suffix={t('policy.days')} maxDigits={0} />
              </FormGrid>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('policy.securityTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <SwitchField form={form} name="security.enforce2fa" label={t('policy.enforce2fa')} hint={t('policy.enforce2faHint')} />
              {!form.watch('security.enforce2fa') && <Alert tone="warning">{t('policy.enforce2faOff')}</Alert>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('policy.storageTitle')}</CardTitle>
              <CardDescription>{t('policy.storageHint')}</CardDescription>
            </CardHeader>
            <CardContent>
              <FormGrid>
                <NumberField form={form} name="storage.quotaMb" label={t('policy.quotaMb')} suffix={t('policy.mb')} maxDigits={0} />
                <NumberField
                  form={form}
                  name="storage.dailyUploadMb"
                  label={t('policy.dailyUploadMb')}
                  hint={t('policy.dailyUploadMbHint', { maxMb: MAX_UPLOAD_BYTES / 1024 / 1024 })}
                  suffix={t('policy.mb')}
                  maxDigits={0}
                />
              </FormGrid>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('policy.retentionTitle')}</CardTitle>
              <CardDescription>{t('policy.retentionHint')}</CardDescription>
            </CardHeader>
            <CardContent>
              <FormGrid>
                <NumberField form={form} name="retention.notificationDays" label={t('policy.notificationDays')} suffix={t('policy.days')} maxDigits={0} />
                <NumberField form={form} name="retention.webhookDeliveryDays" label={t('policy.webhookDeliveryDays')} suffix={t('policy.days')} maxDigits={0} />
                <NumberField form={form} name="retention.aiToolDataDays" label={t('policy.aiToolDataDays')} hint={t('policy.aiToolDataDaysHint')} suffix={t('policy.days')} maxDigits={0} />
                <NumberField form={form} name="retention.importDays" label={t('policy.importDays')} hint={t('policy.importDaysHint')} suffix={t('policy.days')} maxDigits={0} />
                <NumberField form={form} name="retention.trackerReadingsDays" label={t('policy.trackerReadingsDays')} hint={t('policy.trackerReadingsDaysHint')} suffix={t('policy.days')} maxDigits={0} />
                <NumberField form={form} name="retention.idempotencyDays" label={t('policy.idempotencyDays')} hint={t('policy.idempotencyDaysHint')} suffix={t('policy.days')} maxDigits={0} />
              </FormGrid>
            </CardContent>
          </Card>
        </>
      )}
    </InlineForm>
  );
}

interface ExportTable {
  name: string;
  rows: number;
  /** There are more rows than `rows`. */
  capped?: boolean;
}

function DataTab() {
  const { t } = useTranslation('settings');
  const query = useDetail<ExportTable[]>('/settings/export/overview');
  const [downloading, setDownloading] = useState<string | null>(null);

  const download = async (path: string, filename: string) => {
    setDownloading(filename);
    try {
      await api.download(path, filename);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setDownloading(null);
    }
  };

  const tables = (query.data ?? []).filter((table) => table.rows > 0);
  const columns: Column<ExportTable>[] = [
    { key: 'name', header: t('data.table'), cell: (row) => t(`entities.${row.name}`, { defaultValue: row.name }), mobile: 'title' },
    { key: 'rows', header: t('data.rows'), cell: (row) => `${formatNumber(row.rows)}${row.capped ? '+' : ''}`, align: 'right', mobile: 'subtitle' },
    {
      key: 'csv',
      header: 'CSV',
      align: 'right',
      cell: (row) => (
        <Button
          variant="ghost"
          size="sm"
          loading={downloading === `${row.name}.csv`}
          onClick={() => void download(`/settings/export/${row.name}`, `${row.name}.csv`)}
        >
          <FileDown aria-hidden />
          CSV
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('data.title')}</CardTitle>
          <CardDescription>{t('data.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          <Alert tone="info">{t('data.scopeNote')}</Alert>
          <Button loading={downloading === 'yap-export.json'} onClick={() => void download('/settings/export', 'yap-export.json')}>
            <Download aria-hidden />
            {t('data.downloadAll')}
          </Button>
        </CardContent>
      </Card>
      <DataTableView<ExportTable>
        rows={tables}
        rowKey={(row) => row.name}
        columns={columns}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={{ title: t('data.emptyTitle') }}
      />
    </div>
  );
}

export default function SettingsPage() {
  const { t } = useTranslation('settings');
  const can = useCan();
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <UrlTabs
        tabs={[
          { value: 'profile', label: t('tabs.profile'), content: <ProfileTab /> },
          { value: 'policy', label: t('tabs.policy'), content: <PolicyTab /> },
          { value: 'files', label: t('tabs.files'), content: <FilesTab /> },
          { value: 'data', label: t('tabs.data'), content: <DataTab />, hidden: !can('pii.view') },
        ]}
      />
    </>
  );
}
