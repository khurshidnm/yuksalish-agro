import { todayIso } from '@yap/shared';
import { CircleMinus, Link2, Radio, Upload } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, DataTable, DateField, FormDialog, TextField, useConfirm, useUrlParam } from '@/components';
import { Badge, Button, Meter } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatAgo, formatNumber } from '@/lib/format';
import { zDate, zText } from '@/lib/forms';
import { useApiMutation } from '@/lib/query';
import { ImportTrackersDialog } from './ImportTrackersDialog';
import { LIVE, TRACKERS, TRACKING, isStale, type TrackerRow } from './types';

const SILENT_MINUTES = 120;
/** A bolus is heard only near a gateway, so it is quiet whenever the flock grazes (docs/tracking.md). */
const BOLUS_SILENT_MINUTES = 14 * 60;
const LOW_BATTERY = 20;

const fitSchema = z.object({ animal: zText(64), fittedOn: zDate() });

export function BatteryCell({ value }: { value: number | null }) {
  const { t } = useTranslation('tracking');
  if (value === null) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex min-w-24 items-center gap-2">
      <Meter value={value} tone={value < LOW_BATTERY ? 'danger' : value < 40 ? 'warning' : 'success'} label={t('fields.battery')} className="w-14" />
      <span className="tabular-nums">{formatNumber(value, 0)}%</span>
    </div>
  );
}

export function TrackersTab() {
  const { t } = useTranslation('tracking');
  const canUpdate = usePermission('livestock.update');
  const confirm = useConfirm();
  const [fitted, setFitted] = useUrlParam('fitted');
  const [importing, setImporting] = useState(false);
  const [fitting, setFitting] = useState<TrackerRow | null>(null);
  const now = Date.now();

  const remove = useApiMutation<string>({
    mutationFn: (assignmentId) => api.post(`${TRACKING}/assignments/${assignmentId}/remove`, {}),
    invalidate: [TRACKERS, LIVE],
    successMessage: 'tracking:toast.removed',
  });
  const fit = useApiMutation<{ deviceId: string; animal: string; fittedOn: string }>({
    mutationFn: async ({ deviceId, animal, fittedOn }) => {
      const found = await api.get<{ id: string }>('/livestock/animals/scan', { code: animal });
      return api.post(`${TRACKING}/assignments`, { deviceId, animalId: found.id, fittedOn });
    },
    invalidate: [TRACKERS, LIVE],
    silentError: true,
  });

  const columns: Column<TrackerRow>[] = [
    {
      key: 'externalId',
      header: t('fields.externalId'),
      cell: (row) => <span className="font-mono text-sm break-all">{row.externalId ?? row.name}</span>,
      sortable: true,
      mobile: 'title',
    },
    {
      key: 'animalTag',
      header: t('fields.animal'),
      // The whole row opens the animal's passport (rowHref), a target a gloved finger can hit.
      cell: (row) => (row.animalId ? <span className="font-medium">{row.animalTag}</span> : <Badge>{t('trackers.free')}</Badge>),
      sortable: true,
      mobile: 'subtitle',
    },
    { key: 'kind', header: t('fields.kind'), cell: (row) => <Badge variant="outline">{t(`kind.${row.kind}`)}</Badge> },
    { key: 'herd', header: t('fields.herd'), cell: (row) => row.herdName ?? '—', mobile: 'hidden' },
    { key: 'batteryPct', header: t('fields.battery'), cell: (row) => <BatteryCell value={row.batteryPct} />, sortable: true },
    {
      key: 'lastReadingAt',
      header: t('fields.lastReading'),
      cell: (row) =>
        row.lastReadingAt ? (
          <span className={isStale(row.lastReadingAt, now, row.kind === 'bolus' ? BOLUS_SILENT_MINUTES : SILENT_MINUTES) ? 'text-warning' : undefined}>{formatAgo(row.lastReadingAt, now)}</span>
        ) : (
          <span className="text-muted-foreground">{t('trackers.never')}</span>
        ),
      sortable: true,
    },
  ];

  const filters = (
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('trackers.filter')}>
      {(['', 'yes', 'no'] as const).map((value) => (
        <Button key={value} variant={fitted === value ? 'primary' : 'outline'} aria-pressed={fitted === value} onClick={() => setFitted(value)}>
          {t(`trackers.fitted.${value || 'all'}`)}
        </Button>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      {canUpdate && (
        <div className="flex justify-end">
          <Button onClick={() => setImporting(true)}>
            <Upload aria-hidden />
            {t('import.open')}
          </Button>
        </div>
      )}
      <DataTable<TrackerRow>
        path={TRACKERS}
        params={{ fitted: fitted || undefined }}
        columns={columns}
        searchable
        searchPlaceholder={t('trackers.search')}
        filters={filters}
        defaultSort="externalId"
        rowHref={(row) => (row.animalId ? `/livestock/animals/${row.animalId}?tab=location` : null)}
        rowActions={(row) => [
          {
            label: t('trackers.fit'),
            icon: Link2,
            hidden: !canUpdate,
            onClick: () => setFitting(row),
          },
          {
            label: t('trackers.remove'),
            icon: CircleMinus,
            hidden: !canUpdate || !row.assignmentId,
            destructive: true,
            onClick: async () => {
              const ok = await confirm({
                title: t('trackers.removeTitle', { tag: row.animalTag }),
                description: t('trackers.removeDescription'),
                confirmLabel: t('trackers.remove'),
                destructive: true,
              });
              if (ok) remove.mutate(row.assignmentId!);
            },
          },
        ]}
        empty={{
          icon: Radio,
          title: t('trackers.emptyTitle'),
          description: t('trackers.emptyDescription'),
          action: canUpdate ? <Button onClick={() => setImporting(true)}>{t('import.open')}</Button> : undefined,
        }}
      />

      <ImportTrackersDialog open={importing} onOpenChange={setImporting} />
      <FormDialog
        open={fitting !== null}
        onOpenChange={(open) => !open && setFitting(null)}
        title={t('trackers.fitTitle', { id: fitting?.externalId ?? '' })}
        description={fitting?.animalTag ? t('trackers.fitMoves', { tag: fitting.animalTag }) : undefined}
        schema={fitSchema}
        defaultValues={{ animal: '', fittedOn: todayIso() }}
        submitLabel={t('trackers.fit')}
        successMessage="tracking:toast.fitted"
        onSubmit={(values) => fit.mutateAsync({ deviceId: fitting!.id, ...values })}
      >
        {(form) => (
          <>
            <TextField form={form} name="animal" label={t('fields.animalCode')} hint={t('trackers.animalHint')} required autoComplete="off" />
            <DateField form={form} name="fittedOn" label={t('fields.fittedOn')} />
          </>
        )}
      </FormDialog>
    </div>
  );
}
