import { ASSET_STATUSES, ASSET_TYPES } from '@yap/shared';
import { Fuel, Pencil, Plus, Tractor, Trash2, Wrench } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { type Column, DataTable, MoneyText, PageHeader, StatCard, useConfirm, useUrlParam } from '@/components';
import { Alert, Badge, Button, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail, useList } from '@/lib/query';
import { AssetFormDialog } from './AssetFormDialog';
import { DepreciationResultAlert, DepreciationRunButton } from './DepreciationRun';
import type { Asset, DepreciationRun, MaintenanceDue } from './types';

const PATH = '/assets';

export const STATUS_VARIANT: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  working: 'success',
  idle: 'neutral',
  repair: 'warning',
  written_off: 'danger',
};

export default function AssetsPage() {
  const { t } = useTranslation('assets');
  const navigate = useNavigate();
  const canCreate = usePermission('assets.create');
  const canUpdate = usePermission('assets.update');
  const canDelete = usePermission('assets.delete');
  const canPostDepreciation = usePermission('finance.approve');
  const seesMoney = usePermission('finance.view');
  const confirm = useConfirm();

  const [type, setType] = useUrlParam('type');
  const [status, setStatus] = useUrlParam('status');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [depreciationRun, setDepreciationRun] = useState<DepreciationRun | null>(null);

  const { data: fleet, isLoading } = useList<Asset>(PATH, { pageSize: 200 });
  const { data: due } = useDetail<MaintenanceDue[]>(`${PATH}/maintenance/due`);

  const active = fleet?.data.filter((a) => a.status !== 'written_off') ?? [];
  const inRepair = active.filter((a) => a.status === 'repair').length;
  const overdue = due?.filter((d) => d.overdue) ?? [];

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: [PATH],
    successMessage: 'common:toast.deleted',
  });

  const addButton = canCreate && (
    <Button size="lg" onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('add')}
    </Button>
  );

  const columns: Column<Asset>[] = [
    {
      key: 'name',
      header: t('fields.name'),
      sortable: true,
      mobile: 'title',
      cell: (row) => (
        <>
          {row.name}
          {row.rented && (
            <Badge variant="outline" className="ml-2">
              {t('rentedBadge')}
            </Badge>
          )}
        </>
      ),
    },
    { key: 'type', header: t('fields.type'), sortable: true, mobile: 'subtitle', cell: (row) => t(`enums:assetType.${row.type}`) },
    { key: 'inventoryNo', header: t('fields.inventoryNo'), cell: (row) => row.inventoryNo ?? '—' },
    {
      key: 'status',
      header: t('fields.status'),
      sortable: true,
      cell: (row) => <Badge variant={STATUS_VARIANT[row.status] ?? 'neutral'}>{t(`enums:assetStatus.${row.status}`)}</Badge>,
    },
    { key: 'motoHours', header: t('fields.motoHours'), sortable: true, align: 'right', cell: (row) => formatNumber(row.motoHours) },
    { key: 'purchaseDate', header: t('fields.purchaseDate'), sortable: true, mobile: 'hidden', cell: (row) => formatDate(row.purchaseDate) },
    ...(seesMoney
      ? [{ key: 'purchasePrice', header: t('fields.purchasePrice'), align: 'right' as const, mobile: 'hidden' as const, cell: (row: Asset) => <MoneyText value={row.purchasePrice} compact /> }]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          (canPostDepreciation || canCreate) && (
            <div className="flex flex-col gap-2 sm:flex-row">
              {canPostDepreciation && <DepreciationRunButton onResult={setDepreciationRun} />}
              {addButton}
            </div>
          )
        }
      />

      {depreciationRun && <DepreciationResultAlert run={depreciationRun} />}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Tractor} label={t('stats.total')} value={active.length} loading={isLoading} />
        <StatCard label={t('stats.working')} value={active.filter((a) => a.status === 'working').length} tone="success" loading={isLoading} />
        <StatCard icon={Wrench} label={t('stats.repair')} value={inRepair} tone={inRepair ? 'warning' : 'neutral'} loading={isLoading} />
        <StatCard icon={Fuel} label={t('stats.serviceDue')} value={overdue.length} tone={overdue.length ? 'danger' : 'neutral'} loading={isLoading} />
      </div>

      {overdue.length > 0 && (
        <Alert tone="warning" className="mb-4" title={t('serviceOverdue', { count: overdue.length })}>
          {overdue.map((d) => d.name).join(', ')}
        </Alert>
      )}

      <DataTable<Asset>
        path={PATH}
        params={{ type: type || undefined, status: status || undefined }}
        columns={columns}
        defaultSort="name"
        searchPlaceholder={t('searchPlaceholder')}
        onRowClick={(row) => navigate(`/assets/${row.id}`)}
        filters={
          <>
            <Select
              aria-label={t('typeFilter')}
              value={type}
              onChange={(e) => setType(e.target.value)}
              options={enumOptions('assetType', ASSET_TYPES)}
              placeholder={t('allTypes')}
              className="md:w-48"
            />
            <Select
              aria-label={t('statusFilter')}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              options={enumOptions('assetStatus', ASSET_STATUSES)}
              placeholder={t('allStatuses')}
              className="md:w-48"
            />
          </>
        }
        empty={{ icon: Tractor, title: t('emptyTitle'), description: t('emptyBody'), action: addButton }}
        rowActions={(row) => [
          { label: t('common:actions.edit'), icon: Pencil, hidden: !canUpdate, onClick: () => setEditing(row) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({
                title: t('deleteTitle'),
                description: t('deleteBody', { name: row.name }),
                destructive: true,
              });
              if (ok) remove.mutate(row.id);
            },
          },
        ]}
      />

      <AssetFormDialog
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        asset={editing}
      />
    </>
  );
}
