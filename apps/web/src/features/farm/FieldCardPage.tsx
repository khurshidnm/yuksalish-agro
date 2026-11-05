import { FlaskConical, Map as MapIcon, Pencil, Plus, Sprout, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { z } from 'zod';
import { type Column, DataTableView, DateField, EmptyState, ErrorCard, FormDialog, FormGrid, MoneyText, NumberField, PageHeader, StatCard, TextField, TextareaField, UrlTabs, useConfirm } from '@/components';
import { ChartCard } from '@/components/ChartCard';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Select, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber, formatQty } from '@/lib/format';
import { zDate, zOptionalNumber, zOptionalRef, zOptionalText } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';
import { DocumentsPanel } from './DocumentsPanel';
import { FieldFormDialog } from './FieldFormDialog';
import { FieldPhoto } from './FieldPhoto';
import { FileAttachField } from './FileAttachField';
import type { FieldCard, RotationRow, SoilAnalysis } from './types';
import { fieldTitle, formatHa, useLocalName } from './utils';

const SOIL_METRICS = ['ph', 'humus', 'n', 'p', 'k', 'salinity'] as const;
type SoilMetric = (typeof SOIL_METRICS)[number];

const soilSchema = z.object({
  date: zDate(),
  n: zOptionalNumber(),
  p: zOptionalNumber(),
  k: zOptionalNumber(),
  ph: zOptionalNumber(),
  humus: zOptionalNumber(),
  salinity: zOptionalNumber(),
  lab: zOptionalText(160),
  fileId: zOptionalRef(),
  notes: zOptionalText(1000),
});

function soilForm(row: SoilAnalysis | null): z.input<typeof soilSchema> {
  return {
    date: row?.date ?? '',
    n: row?.n ?? null,
    p: row?.p ?? null,
    k: row?.k ?? null,
    ph: row?.ph ?? null,
    humus: row?.humus ?? null,
    salinity: row?.salinity ?? null,
    lab: row?.lab ?? '',
    fileId: row?.fileId ?? null,
    notes: row?.notes ?? '',
  };
}

function Detail({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

function OverviewTab({ field }: { field: FieldCard }) {
  const { t } = useTranslation('farm');
  const localName = useLocalName();
  const crop = field.currentCrop;
  return (
    <div className="flex flex-col gap-4">
      {field.boundary && (
        <Card className="overflow-hidden">
          <FieldPhoto geometry={field.boundary} width={1400} aspect={2.6} credit />
        </Card>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('fields.area')} value={formatHa(field.areaHa, 4)} hint={field.boundary ? t('fields.measuredOnMap') : t('fields.enteredByHand')} />
        <StatCard label={t('fields.currentCrop')} value={crop ? localName(crop.cropName) : '—'} hint={crop?.seasonName} icon={Sprout} tone="success" />
        <StatCard label={t('fields.soilType')} value={field.soilType ?? '—'} hint={field.salinityLevel ? t(`salinity.${field.salinityLevel}`, { defaultValue: field.salinityLevel }) : undefined} />
        <StatCard label={t('fields.irrigationSource')} value={field.irrigationSource ?? '—'} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('fields.currentCrop')}</CardTitle>
          </CardHeader>
          <CardContent>
            {crop ? (
              <dl>
                <Detail label={t('fields.crop')}>
                  {localName(crop.cropName)}
                  {crop.variety && ` · ${crop.variety}`}
                </Detail>
                <Detail label={t('fields.season')}>{crop.seasonName}</Detail>
                <Detail label={t('fields.status')}>
                  <Badge variant={crop.status === 'planned' ? 'outline' : 'success'}>{t(`enums:cropPlanStatus.${crop.status}`)}</Badge>
                </Detail>
                <Detail label={t('fields.sownArea')}>{formatHa(crop.areaHa)}</Detail>
                <Detail label={t('fields.sowingDate')}>{formatDate(crop.sowingDateFact ?? crop.sowingDatePlan)}</Detail>
                <Detail label={t('fields.expectedYield')}>{crop.expectedYieldTHa == null ? '—' : `${formatNumber(crop.expectedYieldTHa)} ${t('unit.tHa')}`}</Detail>
              </dl>
            ) : (
              <EmptyState icon={Sprout} title={t('fields.noCropTitle')} description={t('fields.noCropBody')} className="py-6" />
            )}
          </CardContent>
        </Card>
        {field.notes && (
          <Card>
            <CardHeader>
              <CardTitle>{t('notes')}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm whitespace-pre-line">{field.notes}</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function RotationTab({ field }: { field: FieldCard }) {
  const { t } = useTranslation('farm');
  const localName = useLocalName();
  const canSeeMoney = usePermission('finance.view');

  const columns: Column<RotationRow>[] = [
    { key: 'season', header: t('fields.season'), cell: (row) => row.seasonName, mobile: 'title' },
    {
      key: 'crop',
      header: t('fields.crop'),
      cell: (row) => (row.variety ? `${localName(row.cropName)} · ${row.variety}` : localName(row.cropName)),
      mobile: 'subtitle',
    },
    { key: 'area', header: t('fields.area'), cell: (row) => formatHa(row.areaHa), align: 'right' },
    { key: 'status', header: t('fields.status'), cell: (row) => <Badge>{t(`enums:cropPlanStatus.${row.status}`)}</Badge>, mobile: 'hidden' },
    { key: 'harvest', header: t('fields.harvest'), cell: (row) => formatQty(row.harvestT, 't'), align: 'right' },
    {
      key: 'yield',
      header: t('fields.yield'),
      align: 'right',
      cell: (row) => {
        const expected = row.expectedYieldTHa == null ? null : t('fields.yieldPlan', { value: formatNumber(row.expectedYieldTHa) });
        return (
          <span className="flex flex-col items-end">
            {row.yieldTHa == null ? '—' : `${formatNumber(row.yieldTHa)} ${t('unit.tHa')}`}
            {expected && <span className="text-xs text-muted-foreground">{expected}</span>}
          </span>
        );
      },
    },
    ...(canSeeMoney
      ? [
          {
            key: 'cost',
            header: t('fields.costPerTon'),
            align: 'right' as const,
            cell: (row: RotationRow) => <MoneyText value={row.costPerTon} />,
          },
        ]
      : []),
  ];

  return (
    <DataTableView<RotationRow>
      rows={field.rotation}
      rowKey={(row) => row.planId}
      columns={columns}
      empty={{ icon: Sprout, title: t('fields.rotationEmptyTitle'), description: t('fields.rotationEmptyBody') }}
    />
  );
}

function SoilTab({ field, path }: { field: FieldCard; path: string }) {
  const { t } = useTranslation('farm');
  const canCreate = usePermission('farm.create');
  const canUpdate = usePermission('farm.update');
  const canDelete = usePermission('farm.delete');
  const confirm = useConfirm();
  const [metric, setMetric] = useState<SoilMetric>('ph');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SoilAnalysis | null>(null);

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`/farm/soil/${id}`),
    invalidate: [path],
    successMessage: 'common:toast.deleted',
  });

  const save = useApiMutation<z.output<typeof soilSchema>>({
    mutationFn: (values) => (editing ? api.patch(`/farm/soil/${editing.id}`, values) : api.post(`/farm/fields/${field.id}/soil`, values)),
    invalidate: [path],
    silentError: true,
  });

  const num = (value: number | null) => formatNumber(value, 3);
  const columns: Column<SoilAnalysis>[] = [
    { key: 'date', header: t('soil.date'), cell: (row) => formatDate(row.date), mobile: 'title' },
    { key: 'ph', header: t('soil.ph'), cell: (row) => num(row.ph), align: 'right' },
    { key: 'humus', header: t('soil.humus'), cell: (row) => num(row.humus), align: 'right' },
    { key: 'n', header: t('soil.n'), cell: (row) => num(row.n), align: 'right' },
    { key: 'p', header: t('soil.p'), cell: (row) => num(row.p), align: 'right' },
    { key: 'k', header: t('soil.k'), cell: (row) => num(row.k), align: 'right' },
    { key: 'salinity', header: t('soil.salinity'), cell: (row) => num(row.salinity), align: 'right' },
    { key: 'lab', header: t('soil.lab'), cell: (row) => row.lab ?? '—', mobile: 'hidden' },
  ];

  const addButton = canCreate && (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('soil.add')}
    </Button>
  );

  const history = [...field.soilAnalyses];

  return (
    <div className="flex flex-col gap-4">
      {history.length > 0 && (
        <ChartCard
          title={t('soil.trend')}
          description={t('soil.trendHint')}
          yDomain={['auto', 'auto']}
          kind="line"
          data={history}
          xKey="date"
          series={[{ key: metric, label: t(`soil.${metric}`) }]}
          formatValue={(value) => formatNumber(value, 3)}
          formatX={(value) => formatDate(value)}
          height={240}
          action={
            <Select
              aria-label={t('soil.metric')}
              value={metric}
              onChange={(e) => setMetric(e.target.value as SoilMetric)}
              options={SOIL_METRICS.map((value) => ({ value, label: t(`soil.${value}`) }))}
              className="w-48"
            />
          }
        />
      )}
      <div className="flex justify-end empty:hidden">{addButton}</div>
      <DataTableView<SoilAnalysis>
        rows={[...history].reverse()}
        columns={columns}
        empty={{ icon: FlaskConical, title: t('soil.emptyTitle'), description: t('soil.emptyBody'), action: addButton }}
        rowActions={(row) => [
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(row) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({ title: t('soil.deleteTitle'), description: t('soil.deleteBody', { date: formatDate(row.date) }), destructive: true });
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
        title={editing ? t('soil.edit') : t('soil.add')}
        schema={soilSchema}
        defaultValues={soilForm(editing)}
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
        size="lg"
      >
        {(form) => (
          <>
            <FormGrid>
              <DateField form={form} name="date" label={t('soil.date')} required />
              <TextField form={form} name="lab" label={t('soil.lab')} />
              <NumberField form={form} name="ph" label={t('soil.ph')} maxDigits={2} />
              <NumberField form={form} name="humus" label={t('soil.humus')} maxDigits={3} />
              <NumberField form={form} name="n" label={t('soil.n')} maxDigits={3} />
              <NumberField form={form} name="p" label={t('soil.p')} maxDigits={3} />
              <NumberField form={form} name="k" label={t('soil.k')} maxDigits={3} />
              <NumberField form={form} name="salinity" label={t('soil.salinity')} maxDigits={3} />
            </FormGrid>
            <FileAttachField form={form} name="fileId" label={t('soil.file')} />
            <TextareaField form={form} name="notes" label={t('notes')} rows={2} />
          </>
        )}
      </FormDialog>
    </div>
  );
}

export default function FieldCardPage() {
  const { t } = useTranslation('farm');
  const { id } = useParams();
  const path = `/farm/fields/${id}`;
  const query = useDetail<FieldCard>(path);
  const canUpdate = usePermission('farm.update');
  const [editing, setEditing] = useState(false);
  const back = { to: '/farm/fields', label: t('fields.title') };

  if (query.error) {
    return (
      <>
        <PageHeader title={t('fields.title')} back={back} />
        <ErrorCard error={query.error} onRetry={() => void query.refetch()} />
      </>
    );
  }

  if (!query.data) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-28" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const field = query.data;

  return (
    <>
      <PageHeader
        title={fieldTitle(field)}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            {t(`enums:landUse.${field.landUse}`)}
            {field.status === 'archived' && <Badge variant="warning">{t('fields.archivedBadge')}</Badge>}
          </span>
        }
        back={back}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to={field.boundary ? `/farm/map?focus=${field.id}` : '/farm/map'}>
                <MapIcon aria-hidden />
                {t('fields.showOnMap')}
              </Link>
            </Button>
            {canUpdate && field.status === 'active' && (
              <Button onClick={() => setEditing(true)}>
                <Pencil aria-hidden />
                {t('common:actions.edit')}
              </Button>
            )}
          </>
        }
      />
      <UrlTabs
        tabs={[
          { value: 'overview', label: t('fields.tabOverview'), content: <OverviewTab field={field} /> },
          { value: 'rotation', label: t('fields.tabRotation'), content: <RotationTab field={field} /> },
          { value: 'soil', label: t('fields.tabSoil'), content: <SoilTab field={field} path={path} /> },
          { value: 'documents', label: t('fields.tabDocuments'), content: <DocumentsPanel entity={{ type: 'field', id: field.id }} urlPrefix="doc" /> },
        ]}
      />
      <FieldFormDialog open={editing} onOpenChange={setEditing} field={{ ...field, hasBoundary: field.boundary !== null }} />
    </>
  );
}
