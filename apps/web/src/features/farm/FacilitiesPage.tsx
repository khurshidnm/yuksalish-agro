import { FACILITY_TYPES } from '@yap/shared';
import { Archive, CornerDownRight, Map as MapIcon, Pencil, Plus, Warehouse } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTable, PageHeader, UrlTabs, useConfirm, useUrlParam } from '@/components';
import { Badge, Button, Meter, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatNumber, formatPercent } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { FACILITY_PATHS, FacilityFormDialog } from './FacilityFormDialog';
import { IrrigationPanel } from './IrrigationPanel';
import type { Facility } from './types';
import { formatCapacity, formatHa } from './utils';

const PATH = '/farm/facilities';

function Occupancy({ row }: { row: Facility }) {
  const { t } = useTranslation('farm');
  if (row.type !== 'barn') return <>{formatCapacity(row.capacity, row.capacityUnit)}</>;
  const full = (row.capacityUsePercent ?? 0) > 100;
  return (
    <div className="flex min-w-40 flex-col gap-1">
      <span className="text-sm">
        {t('facilities.occupied', { head: formatNumber(row.occupiedHead, 0), capacity: row.capacity == null ? '—' : formatNumber(row.capacity, 0) })}
        {row.capacityUsePercent != null && <span className={full ? ' font-medium text-danger' : ' text-muted-foreground'}> · {formatPercent(row.capacityUsePercent, 0)}</span>}
      </span>
      {row.capacityUsePercent != null && <Meter value={row.capacityUsePercent} tone={full ? 'danger' : 'primary'} label={t('facilities.capacityUse')} />}
    </div>
  );
}

function FacilitiesTable() {
  const { t } = useTranslation('farm');
  const canCreate = usePermission('farm.create');
  const canUpdate = usePermission('farm.update');
  const canDelete = usePermission('farm.delete');
  const confirm = useConfirm();

  const [type, setType] = useUrlParam('type');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Facility | null>(null);

  const archive = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: FACILITY_PATHS,
    successMessage: 'farm:facilities.archived',
  });

  const columns: Column<Facility>[] = [
    {
      key: 'name',
      header: t('facilities.name'),
      cell: (row) => (
        <span className="inline-flex items-center gap-1.5">
          {row.parentId && <CornerDownRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
          {row.name}
        </span>
      ),
      sortable: true,
      mobile: 'title',
    },
    { key: 'type', header: t('facilities.type'), cell: (row) => <Badge>{t(`enums:facilityType.${row.type}`)}</Badge>, sortable: true, mobile: 'subtitle' },
    { key: 'capacity', header: t('facilities.capacity'), cell: (row) => <Occupancy row={row} /> },
    { key: 'area', header: t('facilities.area'), cell: (row) => formatHa(row.areaHa), align: 'right', mobile: 'hidden' },
    { key: 'notes', header: t('notes'), cell: (row) => row.notes ?? '—', mobile: 'hidden' },
  ];

  const addButton = canCreate && (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('facilities.add')}
    </Button>
  );

  return (
    <>
      <div className="mb-3 flex flex-wrap justify-end gap-2">
        <Button variant="outline" asChild>
          <Link to="/farm/map">
            <MapIcon aria-hidden />
            {t('fields.openMap')}
          </Link>
        </Button>
        {addButton}
      </div>
      <DataTable<Facility>
        path={PATH}
        params={{ type: type || undefined }}
        columns={columns}
        pageSize={50}
        searchPlaceholder={t('facilities.searchPlaceholder')}
        filters={
          <Select
            aria-label={t('facilities.typeFilter')}
            value={type}
            onChange={(e) => setType(e.target.value)}
            options={enumOptions('facilityType', FACILITY_TYPES)}
            placeholder={t('facilities.allTypes')}
            className="md:w-56"
          />
        }
        empty={{ icon: Warehouse, title: t('facilities.emptyTitle'), description: t('facilities.emptyBody') }}
        rowActions={(row) => [
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(row) },
          {
            label: t('fields.archive'),
            icon: Archive,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({
                title: t('facilities.archiveTitle'),
                description: t('facilities.archiveBody', { name: row.name }),
                confirmLabel: t('fields.archive'),
                destructive: true,
              });
              if (ok) archive.mutate(row.id);
            },
          },
        ]}
      />
      <FacilityFormDialog
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        facility={editing}
      />
    </>
  );
}

export default function FacilitiesPage() {
  const { t } = useTranslation('farm');
  return (
    <>
      <PageHeader title={t('facilities.title')} description={t('facilities.description')} />
      <UrlTabs
        tabs={[
          { value: 'objects', label: t('facilities.tabObjects'), content: <FacilitiesTable /> },
          { value: 'irrigation', label: t('facilities.tabIrrigation'), content: <IrrigationPanel /> },
        ]}
      />
    </>
  );
}
