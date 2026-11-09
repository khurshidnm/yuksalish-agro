import { LAND_USES } from '@yap/shared';
import { Archive, Check, Map as MapIcon, Pencil, Plus, Sprout } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTable, PageHeader, StatCard, useConfirm, useUrlParam } from '@/components';
import { Badge, Button, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatNumber } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { FIELD_PATHS, FieldFormDialog } from './FieldFormDialog';
import { FieldPreview } from './FieldPreview';
import { FieldShape } from './FieldShape';
import { LAND_USE_SLOT } from './map/slots';
import type { FarmMapData, FieldRow, Passport } from './types';
import { CROP_STATUS_VARIANT, fieldTitle, formatHa, useLocalName } from './utils';

const PATH = '/farm/fields';

export default function FieldsPage() {
  const { t } = useTranslation('farm');
  const canCreate = usePermission('farm.create');
  const canUpdate = usePermission('farm.update');
  const canDelete = usePermission('farm.delete');
  const confirm = useConfirm();
  const localName = useLocalName();

  const [landUse, setLandUse] = useUrlParam('landUse');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<FieldRow | null>(null);

  const passport = useDetail<Passport>('/farm/passport');
  const balance = passport.data?.areaBalance;
  const arable = balance?.byLandUse.find((row) => row.landUse === 'arable');

  // Side by side only where both fit. Narrower screens open the field card, as they always did.
  const wide = useMediaQuery('(min-width: 80rem)');
  const [picked, setPicked] = useState<string | null>(null);
  const outlines = useDetail<FarmMapData>('/farm/map');
  const mappedFields = useMemo(() => (outlines.data?.features ?? []).filter((feature) => feature.properties.kind === 'field'), [outlines.data]);
  const geometryOf = useMemo(() => new Map(mappedFields.map((feature) => [feature.id, feature.geometry])), [mappedFields]);
  const largest = useMemo(
    () => mappedFields.reduce<(typeof mappedFields)[number] | null>((best, feature) => ((feature.properties.areaHa ?? 0) > (best?.properties.areaHa ?? 0) ? feature : best), null),
    [mappedFields],
  );
  const previewId = picked ?? largest?.id ?? null;

  const archive = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: FIELD_PATHS,
    successMessage: 'farm:fields.archived',
  });

  const columns: Column<FieldRow>[] = [
    {
      key: 'number',
      header: t('fields.contour'),
      cell: (row) => (
        <span className="inline-flex items-center gap-2.5">
          <FieldShape geometry={geometryOf.get(row.id)} slot={LAND_USE_SLOT[row.landUse]} />
          {fieldTitle(row)}
        </span>
      ),
      mobile: 'title',
    },
    {
      key: 'landUse',
      header: t('fields.landUse'),
      cell: (row) => <Badge>{t(`enums:landUse.${row.landUse}`)}</Badge>,
      sortable: true,
      mobile: 'subtitle',
    },
    { key: 'areaHa', header: t('fields.area'), cell: (row) => formatHa(row.areaHa), sortable: true, align: 'right' },
    {
      key: 'crop',
      header: t('fields.currentCrop'),
      cell: (row) =>
        row.currentCrop ? (
          <span className="flex flex-wrap items-center justify-end gap-1.5 md:justify-start">
            {localName(row.currentCrop.cropName)}
            <Badge variant={CROP_STATUS_VARIANT[row.currentCrop.status]}>{t(`enums:cropPlanStatus.${row.currentCrop.status}`)}</Badge>
          </span>
        ) : (
          '—'
        ),
    },
    // With the side panel open these two live there, and the table keeps its width.
    ...(wide
      ? []
      : ([
          { key: 'soilType', header: t('fields.soilType'), cell: (row) => row.soilType ?? '—', mobile: 'hidden' },
          { key: 'irrigationSource', header: t('fields.irrigationSource'), cell: (row) => row.irrigationSource ?? '—', mobile: 'hidden' },
        ] satisfies Column<FieldRow>[])),
    {
      key: 'hasBoundary',
      header: t('fields.onMap'),
      cell: (row) =>
        row.hasBoundary ? (
          <Check className="size-4 text-success" aria-label={t('fields.drawn')} />
        ) : (
          <Badge variant="warning">{t('fields.notDrawn')}</Badge>
        ),
      mobile: 'hidden',
    },
  ];

  return (
    <>
      <PageHeader
        title={t('fields.title')}
        description={t('fields.description')}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/farm/map">
                <MapIcon aria-hidden />
                {t('fields.openMap')}
              </Link>
            </Button>
            {canCreate && (
              <Button onClick={() => setCreating(true)}>
                <Plus aria-hidden />
                {t('fields.add')}
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatCard label={t('passport.totalArea')} value={formatHa(balance?.totalAreaHa)} loading={passport.isPending} />
        <StatCard
          label={t('fields.arableArea')}
          value={formatHa(arable?.areaHa)}
          hint={arable ? t('fields.contourCount', { value: formatNumber(arable.count) }) : undefined}
          loading={passport.isPending}
          icon={Sprout}
          tone="success"
        />
        <StatCard
          label={balance?.overAssigned ? t('passport.overAssigned') : t('passport.unassigned')}
          value={formatHa(balance?.unassignedHa === null ? null : Math.abs(balance?.unassignedHa ?? 0))}
          tone={balance?.overAssigned ? 'danger' : 'neutral'}
          loading={passport.isPending}
          className="col-span-2 md:col-span-1"
        />
      </div>

      <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start xl:gap-4">
        <DataTable<FieldRow>
          path={PATH}
          params={{ landUse: landUse || undefined }}
          columns={columns}
          rowHref={(row) => `/farm/fields/${row.id}`}
          onRowPreview={wide ? (row) => setPicked(row.id) : undefined}
          isRowSelected={wide ? (row) => row.id === previewId : undefined}
          searchPlaceholder={t('fields.searchPlaceholder')}
          filters={
            <Select
              aria-label={t('fields.landUseFilter')}
              value={landUse}
              onChange={(e) => setLandUse(e.target.value)}
              options={enumOptions('landUse', LAND_USES)}
              placeholder={t('fields.allLandUses')}
              className="md:w-56"
            />
          }
          empty={{
            icon: Sprout,
            title: t('fields.emptyTitle'),
            description: t('fields.emptyBody'),
            action: canCreate && (
              <Button asChild>
                <Link to="/farm/map">
                  <MapIcon aria-hidden />
                  {t('fields.openMap')}
                </Link>
              </Button>
            ),
          }}
          rowActions={(row) => [
            { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(row) },
            {
              label: t('fields.archive'),
              icon: Archive,
              destructive: true,
              hidden: !canDelete,
              onClick: async () => {
                const ok = await confirm({
                  title: t('fields.archiveTitle'),
                  description: t('fields.archiveBody', { name: fieldTitle(row) }),
                  confirmLabel: t('fields.archive'),
                  destructive: true,
                });
                if (ok) archive.mutate(row.id);
              },
            },
          ]}
        />
        {wide && previewId && <FieldPreview id={previewId} />}
      </div>

      <FieldFormDialog
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        field={editing}
      />
    </>
  );
}
