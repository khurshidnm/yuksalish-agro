import { Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTableView, Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components';
import { usePermission } from '@/lib/auth';
import { formatDate, formatMoney, formatQty } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { ExpiryBadge } from './shared';
import type { BatchRow, StockRow } from './types';

/** Every batch behind one balance: what came in, from whom, at what price, and when it expires. */
export function BatchesDialog({ row, onClose }: { row: StockRow | null; onClose: () => void }) {
  const { t } = useTranslation('inventory');
  const canSeeMoney = usePermission('finance.view');
  const batches = useDetail<BatchRow[]>(
    row ? `/inventory/stock/${row.itemId}/batches` : null,
    row?.warehouseId ? { warehouseId: row.warehouseId } : undefined,
  );

  const columns: Column<BatchRow>[] = [
    { key: 'received', header: t('batches.received'), cell: (b) => formatDate(b.receivedDate), mobile: 'title' },
    { key: 'batchNo', header: t('batches.batchNo'), cell: (b) => b.batchNo ?? '—', mobile: 'subtitle' },
    { key: 'qty', header: t('batches.remaining'), align: 'right', cell: (b) => t('batches.ofReceived', { left: formatQty(b.qtyRemaining, row?.unit), total: formatQty(b.qtyReceived, row?.unit) }) },
    { key: 'source', header: t('batches.source'), cell: (b) => b.counterpartyName ?? t(`reason.${b.source}`) },
    ...(canSeeMoney ? [{ key: 'cost', header: t('batches.unitCost'), align: 'right' as const, cell: (b: BatchRow) => formatMoney(b.unitCost) }] : []),
    { key: 'expiry', header: t('batches.expiry'), cell: (b) => <ExpiryBadge date={b.expiryDate} /> },
  ];

  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{row?.name}</DialogTitle>
          <DialogDescription>
            {t('batches.summary', { warehouse: row?.warehouseName ?? '—', qty: formatQty(row?.qty, row?.unit) })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <DataTableView
            rows={batches.data ?? []}
            columns={columns}
            loading={batches.isLoading}
            error={batches.error}
            onRetry={() => void batches.refetch()}
            empty={{ icon: Layers, title: t('batches.emptyTitle') }}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
