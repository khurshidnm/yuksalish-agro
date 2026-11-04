import { OPERATION_TYPES } from '@yap/shared';
import {
  CheckCircle2,
  ClipboardList,
  CloudSun,
  Droplets,
  Eye,
  ExternalLink,
  FlaskConical,
  type LucideIcon,
  Pencil,
  Plus,
  Shield,
  Sprout,
  Tractor,
  Trash2,
  Wheat,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTable, MoneyText, PageHeader, useConfirm, useUrlParam } from '@/components';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Select,
  Sheet,
  SheetContent,
  SheetTitle,
  Skeleton,
} from '@/components/ui';
import { useLocalName } from '@/features/farm/utils';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber, formatQty } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail, useList } from '@/lib/query';
import { HarvestFormDialog } from './HarvestFormDialog';
import { OperationFormDialog, type OperationMode } from './OperationFormDialog';
import { AFFECTED_BY_WORK, OPERATIONS } from './options';
import type { Operation } from './types';

const TYPE_ICON: Record<string, LucideIcon> = {
  tillage: Tractor,
  sowing: Sprout,
  irrigation: Droplets,
  fertilizing: FlaskConical,
  protection: Shield,
  observation: Eye,
  harvest: Wheat,
};

const VIEWS = ['planned', 'overdue', 'done'] as const;

/** Big tiles rather than a dropdown: this is the first thing a brigadier taps, with gloves on. */
function WorkTypePicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (type: string) => void;
}) {
  const { t } = useTranslation('crops');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('operations.pickType')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="grid grid-cols-2 gap-3">
            {OPERATION_TYPES.map((type) => {
              const Icon = TYPE_ICON[type];
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => onPick(type)}
                  className="focus-ring flex min-h-24 flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card p-3 text-center text-sm font-medium hover:bg-muted"
                >
                  <Icon className="size-7 text-primary" aria-hidden />
                  {t(`enums:operationType.${type}`)}
                </button>
              );
            })}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function workTitle(op: Pick<Operation, 'type' | 'details'>, t: (key: string) => string): string {
  const name = op.details.name;
  return typeof name === 'string' && name ? name : t(`enums:operationType.${op.type}`);
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

function detailLines(op: Operation, t: (key: string, o?: Record<string, unknown>) => string) {
  const d = op.details as Record<string, string | number | undefined>;
  const lines: [string, string][] = [];
  if (d.method) lines.push([t('operations.fields.method'), t(`operations.method.${d.method}`)]);
  if (d.variety) lines.push([t('operations.fields.variety'), String(d.variety)]);
  if (d.seedRateKgHa) lines.push([t('operations.fields.seedRate'), `${formatNumber(Number(d.seedRateKgHa))} ${t('unit.kgPerHa')}`]);
  if (d.waterSource) lines.push([t('operations.fields.waterSource'), String(d.waterSource)]);
  if (d.target) lines.push([t('operations.fields.target'), String(d.target)]);
  if (d.dose) lines.push([t('operations.fields.dose'), `${d.dose} ${d.doseUnit ?? ''}`]);
  if (d.safeFrom) lines.push([t('operations.fields.safeFrom'), formatDate(String(d.safeFrom))]);
  if (d.condition) lines.push([t('operations.fields.condition'), t(`operations.condition.${d.condition}`)]);
  if (d.pests) lines.push([t('operations.fields.pests'), String(d.pests)]);
  if (d.diseases) lines.push([t('operations.fields.diseases'), String(d.diseases)]);
  if (d.grossT) lines.push([t('harvests.fields.grossT'), formatQty(Number(d.grossT), 't')]);
  return lines;
}

function OperationSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation('crops');
  const localName = useLocalName();
  const { data: op, isLoading } = useDetail<Operation>(id ? `${OPERATIONS}/${id}` : null);

  return (
    <Sheet open={id !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="overflow-y-auto">
        <SheetTitle className="p-4 pr-14 text-lg font-semibold">{op ? workTitle(op, t) : t('operations.detail')}</SheetTitle>
        <div className="space-y-4 px-4 pb-6">
          {isLoading || !op ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <>
              <div>
                <Fact label={t('operations.fields.field')}>
                  №{op.fieldNumber}
                  {op.fieldName ? ` ${op.fieldName}` : ''}
                </Fact>
                {op.cropName && <Fact label={t('plans.fields.crop')}>{localName(op.cropName)}</Fact>}
                <Fact label={t('operations.fields.date')}>{formatDate(op.date)}</Fact>
                {op.plannedDate && op.plannedDate !== op.date && (
                  <Fact label={t('operations.fields.plannedDate')}>{formatDate(op.plannedDate)}</Fact>
                )}
                {op.assetName && <Fact label={t('operations.fields.machine')}>{op.assetName}</Fact>}
                {op.employeeName && <Fact label={t('operations.fields.operator')}>{op.employeeName}</Fact>}
                {op.areaDoneHa !== null && <Fact label={t('operations.fields.area')}>{formatNumber(op.areaDoneHa)} {t('unit.ha')}</Fact>}
                {op.waterM3 !== null && <Fact label={t('operations.fields.water')}>{formatNumber(op.waterM3)} {t('unit.m3')}</Fact>}
                {op.durationH !== null && <Fact label={t('operations.fields.duration')}>{formatNumber(op.durationH)} {t('unit.hours')}</Fact>}
                {op.fuelL !== null && <Fact label={t('operations.fields.fuel')}>{formatNumber(op.fuelL)} {t('unit.liters')}</Fact>}
                {detailLines(op, t).map(([label, value]) => (
                  <Fact key={label} label={label}>
                    {value}
                  </Fact>
                ))}
              </div>

              {op.weather && (
                <p className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
                  <CloudSun className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  {t('operations.weather', {
                    min: formatNumber(op.weather.tempMin ?? null),
                    max: formatNumber(op.weather.tempMax ?? null),
                    rain: formatNumber(op.weather.precipitationMm ?? 0),
                  })}
                </p>
              )}

              {op.materials.length > 0 && (
                <div>
                  <h3 className="mb-1 text-sm font-medium">{t('operations.materials.used')}</h3>
                  {op.materials.map((m) => (
                    <Fact key={m.id} label={m.itemName}>
                      {formatQty(m.qty, m.unit)}
                      {m.totalCost !== null && op.status === 'done' && (
                        <span className="block text-xs font-normal text-muted-foreground">
                          <MoneyText value={m.totalCost} />
                        </span>
                      )}
                    </Fact>
                  ))}
                </div>
              )}

              {op.notes && <p className="text-sm whitespace-pre-wrap">{op.notes}</p>}

              {op.photos && op.photos.length > 0 && (
                <ul className="grid grid-cols-2 gap-2">
                  {op.photos.map((photo) => (
                    <li key={photo.id}>
                      <a href={photo.url} target="_blank" rel="noreferrer" aria-label={t('operations.openPhoto')}>
                        <img src={photo.url} alt="" className="aspect-square w-full rounded-md border border-border object-cover" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}

              {op.lat !== null && op.lng !== null && (
                <a
                  className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary underline-offset-4 hover:underline"
                  href={`https://www.openstreetmap.org/?mlat=${op.lat}&mlon=${op.lng}#map=16/${op.lat}/${op.lng}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="size-4" aria-hidden />
                  {t('operations.openMap')}
                </a>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function OperationsPage() {
  const { t } = useTranslation('crops');
  const localName = useLocalName();
  const canCreate = usePermission('crops.create');
  const canUpdate = usePermission('crops.update');
  const canDelete = usePermission('crops.delete');
  const confirm = useConfirm();

  const [view, setView] = useUrlParam('view');
  const [type, setType] = useUrlParam('type');
  const [picking, setPicking] = useState(false);
  const [form, setForm] = useState<{ type: string; mode: OperationMode; operation?: Operation } | null>(null);
  const [harvestFor, setHarvestFor] = useState<Operation | null | undefined>(undefined);
  const [viewing, setViewing] = useState<string | null>(null);

  const { data: overdue } = useList<Operation>(OPERATIONS, { overdue: 'true', pageSize: 1 });
  const overdueCount = overdue?.meta.total ?? 0;

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${OPERATIONS}/${id}`),
    invalidate: AFFECTED_BY_WORK,
    successMessage: 'common:toast.deleted',
  });

  const startWork = (picked: string) => {
    setPicking(false);
    if (picked === 'harvest') setHarvestFor(null);
    else setForm({ type: picked, mode: 'create' });
  };

  const complete = (row: Operation) => {
    if (row.type === 'harvest') setHarvestFor(row);
    else setForm({ type: row.type, mode: 'complete', operation: row });
  };

  const addButton = canCreate && (
    <Button size="lg" onClick={() => setPicking(true)}>
      <Plus aria-hidden />
      {t('operations.add')}
    </Button>
  );

  const columns: Column<Operation>[] = [
    {
      key: 'type',
      header: t('operations.fields.work'),
      sortable: true,
      mobile: 'title',
      cell: (row) => {
        const Icon = TYPE_ICON[row.type] ?? ClipboardList;
        return (
          <span className="flex items-center gap-2">
            <Icon className="size-4 shrink-0 text-primary" aria-hidden />
            {workTitle(row, t)}
          </span>
        );
      },
    },
    {
      key: 'field',
      header: t('operations.fields.field'),
      mobile: 'subtitle',
      cell: (row) => (
        <>
          №{row.fieldNumber}
          {row.cropName ? ` · ${localName(row.cropName)}` : ''}
        </>
      ),
    },
    { key: 'date', header: t('operations.fields.date'), sortable: true, cell: (row) => formatDate(row.date) },
    {
      key: 'status',
      header: t('operations.fields.status'),
      cell: (row) =>
        row.overdue ? (
          <Badge variant="danger">{t('operations.status.overdue')}</Badge>
        ) : row.status === 'planned' ? (
          <Badge variant="info">{t('operations.status.planned')}</Badge>
        ) : (
          <Badge variant="success">{t('operations.status.done')}</Badge>
        ),
    },
    {
      key: 'volume',
      header: t('operations.fields.volume'),
      align: 'right',
      cell: (row) =>
        row.waterM3 !== null
          ? `${formatNumber(row.waterM3)} ${t('unit.m3')}`
          : row.areaDoneHa !== null
            ? `${formatNumber(row.areaDoneHa)} ${t('unit.ha')}`
            : '—',
    },
    { key: 'machine', header: t('operations.fields.machine'), mobile: 'hidden', cell: (row) => row.assetName ?? '—' },
    { key: 'operator', header: t('operations.fields.operator'), mobile: 'hidden', cell: (row) => row.employeeName ?? '—' },
  ];

  const isLocked = (row: Operation) => row.type === 'harvest' && row.status === 'done';

  return (
    <>
      <PageHeader title={t('operations.title')} description={t('operations.description')} actions={addButton} />

      {overdueCount > 0 && view !== 'overdue' && (
        <Alert tone="warning" className="mb-4" title={t('operations.overdueTitle', { count: overdueCount })}>
          <Button variant="link" className="h-auto p-0" onClick={() => setView('overdue')}>
            {t('operations.showOverdue')}
          </Button>
        </Alert>
      )}

      <DataTable<Operation>
        path={OPERATIONS}
        params={{
          status: view === 'done' || view === 'planned' ? view : undefined,
          overdue: view === 'overdue' ? 'true' : undefined,
          type: type || undefined,
        }}
        columns={columns}
        defaultSort="-date"
        searchPlaceholder={t('operations.searchPlaceholder')}
        onRowClick={(row) => setViewing(row.id)}
        filters={
          <>
            <Select
              aria-label={t('operations.viewFilter')}
              value={view}
              onChange={(e) => setView(e.target.value)}
              options={VIEWS.map((value) => ({ value, label: t(`operations.status.${value}`) }))}
              placeholder={t('operations.allStatuses')}
              className="md:w-48"
            />
            <Select
              aria-label={t('operations.typeFilter')}
              value={type}
              onChange={(e) => setType(e.target.value)}
              options={enumOptions('operationType', OPERATION_TYPES)}
              placeholder={t('operations.allTypes')}
              className="md:w-52"
            />
          </>
        }
        empty={{ icon: ClipboardList, title: t('operations.emptyTitle'), description: t('operations.emptyBody'), action: addButton }}
        rowActions={(row) => [
          {
            label: t('operations.markDone'),
            icon: CheckCircle2,
            hidden: row.status !== 'planned' || !(canCreate || canUpdate),
            onClick: () => complete(row),
          },
          {
            label: t('common:actions.edit'),
            icon: Pencil,
            hidden: !canUpdate || isLocked(row),
            onClick: async () => {
              // The list has no photo links; fetch them so the form can show what is attached.
              const full = await api.get<Operation>(`${OPERATIONS}/${row.id}`);
              setForm({ type: row.type, mode: 'edit', operation: full });
            },
          },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete || isLocked(row),
            onClick: async () => {
              const ok = await confirm({
                title: t('operations.deleteTitle'),
                description: t('operations.deleteBody'),
                destructive: true,
              });
              if (ok) remove.mutate(row.id);
            },
          },
        ]}
      />

      <WorkTypePicker open={picking} onOpenChange={setPicking} onPick={startWork} />

      {form && (
        <OperationFormDialog
          open
          onOpenChange={(open) => !open && setForm(null)}
          type={form.type}
          mode={form.mode}
          operation={form.operation}
        />
      )}

      <HarvestFormDialog open={harvestFor !== undefined} onOpenChange={(open) => !open && setHarvestFor(undefined)} planned={harvestFor} />

      <OperationSheet id={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
