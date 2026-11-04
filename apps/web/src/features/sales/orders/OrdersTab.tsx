import { SALE_STATUSES } from '@yap/shared';
import { Plus, Receipt } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTable, MoneyText, useUrlParam } from '@/components';
import { Button, Select } from '@/components/ui';
import { usePermission } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { SaleStatusBadge } from '../shared';
import type { SaleDetail, SaleRow } from '../types';
import { SaleFormDialog } from './SaleForm';
import { SaleSheet } from './SaleSheet';

export function OrdersTab() {
  const { t } = useTranslation('sales');
  const canCreate = usePermission('sales.create');
  const [status, setStatus] = useUrlParam('status');
  const [openId, setOpenId] = useUrlParam('sale');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SaleDetail | null>(null);

  const add = (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('orders.add')}
    </Button>
  );

  const columns: Column<SaleRow>[] = [
    { key: 'number', header: t('orders.fields.number'), cell: (row) => row.number, sortable: true, mobile: 'title' },
    { key: 'buyer', header: t('orders.fields.buyer'), cell: (row) => row.counterpartyName, mobile: 'subtitle' },
    { key: 'date', header: t('orders.fields.date'), cell: (row) => formatDate(row.date), sortable: true },
    { key: 'status', header: t('orders.fields.status'), cell: (row) => <SaleStatusBadge status={row.status} />, sortable: true },
    { key: 'lines', header: t('orders.fields.lineCount'), cell: (row) => row.lineCount, align: 'right', mobile: 'hidden' },
    {
      key: 'totalAmount',
      header: t('orders.fields.total'),
      cell: (row) => <MoneyText value={row.totalAmount} currency={row.currency} />,
      sortable: true,
      align: 'right',
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {canCreate && <div className="flex justify-end">{add}</div>}

      <DataTable<SaleRow>
        path="/sales/orders"
        urlPrefix="orders"
        params={{ status: status || undefined }}
        columns={columns}
        defaultSort="-date"
        searchPlaceholder={t('orders.searchPlaceholder')}
        onRowClick={(row) => setOpenId(row.id)}
        filters={
          <Select
            aria-label={t('orders.fields.status')}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={enumOptions('saleStatus', SALE_STATUSES)}
            placeholder={t('orders.allStatuses')}
            className="md:w-56"
          />
        }
        empty={{ icon: Receipt, title: t('orders.emptyTitle'), description: t('orders.emptyBody'), action: canCreate && add }}
      />

      <SaleFormDialog
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        sale={editing}
        onSaved={setOpenId}
      />

      {openId && <SaleSheet id={openId} onClose={() => setOpenId('')} onEdit={setEditing} />}
    </div>
  );
}
