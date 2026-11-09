import { MOVEMENT_TYPES } from '@yap/shared';
import { FileDown, History, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type Column, Badge, type BadgeVariant, DataTable, DateInput, PageHeader, Select, useConfirm, useUrlParam } from '@/components';
import { useCenterName } from '@/features/finance/lib';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatMoney, formatQty } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { STOCK_PATHS, downloadDocument, useWarehouseOptions } from './shared';
import type { MovementRow } from './types';

const INCOMING = new Set(['receipt', 'transfer_in', 'adjustment_in']);

const VARIANT: Record<string, BadgeVariant> = {
  receipt: 'success',
  issue: 'neutral',
  transfer_in: 'info',
  transfer_out: 'info',
  adjustment_in: 'warning',
  adjustment_out: 'warning',
};

export default function MovementsPage() {
  const { t } = useTranslation('inventory');
  const canSeeMoney = usePermission('finance.view');
  const canReverse = usePermission('inventory.delete');
  const confirm = useConfirm();
  const centerName = useCenterName();
  const warehouses = useWarehouseOptions();
  const [type, setType] = useUrlParam('type');
  const [warehouseId, setWarehouseId] = useUrlParam('warehouse');
  const [from, setFrom] = useUrlParam('from');
  const [to, setTo] = useUrlParam('to');

  const reverse = useApiMutation<string>({
    mutationFn: (docNo) => api.post(`/inventory/documents/${encodeURIComponent(docNo)}/reverse`),
    invalidate: STOCK_PATHS,
    successMessage: 'inventory:movements.reversed',
  });

  const columns: Column<MovementRow>[] = [
    { key: 'itemName', header: t('movements.item'), cell: (row) => row.itemName, sortable: true, mobile: 'title' },
    { key: 'date', header: t('movements.date'), cell: (row) => formatDate(row.date), sortable: true, mobile: 'subtitle' },
    {
      key: 'type',
      header: t('movements.type'),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge variant={VARIANT[row.type] ?? 'neutral'}>{t(`enums:movementType.${row.type}`)}</Badge>
          {/* Purchase, opening balance and own harvest are all receipts: the purpose tells them apart. */}
          {row.reason && <span className="text-sm text-muted-foreground">{t(`reason.${row.reason}`, { defaultValue: row.reason })}</span>}
        </span>
      ),
    },
    {
      key: 'qty',
      header: t('movements.qty'),
      align: 'right',
      sortable: true,
      cell: (row) => (
        <span className="font-medium whitespace-nowrap">
          {INCOMING.has(row.type) ? '+' : '−'}
          {formatQty(row.qty, row.unit)}
        </span>
      ),
    },
    { key: 'warehouse', header: t('movements.warehouse'), cell: (row) => row.warehouseName, mobile: 'hidden' },
    { key: 'costCenter', header: t('movements.costCenter'), cell: (row) => centerName(row.costCenterName, row.costCenterType), mobile: 'hidden' },
    ...(canSeeMoney ? [{ key: 'cost', header: t('movements.cost'), align: 'right' as const, cell: (row: MovementRow) => formatMoney(row.totalCost) }] : []),
    { key: 'doc', header: t('movements.document'), cell: (row) => row.docNo ?? '—', mobile: 'hidden' },
    { key: 'author', header: t('movements.author'), cell: (row) => row.createdByName ?? '—', mobile: 'hidden' },
  ];

  return (
    <>
      <PageHeader title={t('movements.title')} description={t('movements.description')} />
      <DataTable<MovementRow>
        path="/inventory/movements"
        params={{ type: type || undefined, warehouseId: warehouseId || undefined, from: from || undefined, to: to || undefined }}
        columns={columns}
        searchPlaceholder={t('movements.searchPlaceholder')}
        filters={
          <>
            <Select
              aria-label={t('movements.typeFilter')}
              value={type}
              onChange={(e) => setType(e.target.value)}
              options={enumOptions('movementType', MOVEMENT_TYPES)}
              placeholder={t('movements.allTypes')}
              className="md:w-48"
            />
            <Select
              aria-label={t('stock.warehouseFilter')}
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              options={warehouses}
              placeholder={t('stock.allWarehouses')}
              className="md:w-52"
            />
            {/* Label-less, as on the other journals, so the dates line up with the search box and selects. */}
            <div className="grid grid-cols-2 gap-2">
              <DateInput aria-label={t('movements.from')} title={t('movements.from')} value={from} onChange={(e) => setFrom(e.target.value)} />
              <DateInput aria-label={t('movements.to')} title={t('movements.to')} value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </>
        }
        empty={{ icon: History, title: t('movements.emptyTitle'), description: t('movements.emptyBody') }}
        rowActions={(row) => [
          {
            label: t('document.pdf'),
            icon: FileDown,
            hidden: !row.docNo,
            onClick: () => void downloadDocument(row.docNo!),
          },
          {
            label: t('movements.reverse'),
            icon: Undo2,
            destructive: true,
            hidden: !canReverse || row.refType !== 'stock_doc' || !row.docNo,
            onClick: async () => {
              const ok = await confirm({
                title: t('movements.reverseTitle', { docNo: row.docNo }),
                description: t('movements.reverseBody'),
                confirmLabel: t('movements.reverse'),
                destructive: true,
              });
              if (ok) reverse.mutate(row.docNo!);
            },
          },
        ]}
      />
    </>
  );
}
