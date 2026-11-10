import { CATALOGUE_REQUEST_STATUSES } from '@yap/shared';
import { BookmarkPlus, CircleCheck, Inbox } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTable, useConfirm, useUrlParam } from '@/components';
import { Badge, type BadgeVariant, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { ReserveDialog } from './ReserveDialog';
import { type CatalogueRequest, type CatalogueRequestStatus, REQUESTS, SALE_HOLD_PATHS } from './types';

const STATUS_VARIANT: Record<CatalogueRequestStatus, BadgeVariant> = {
  new: 'warning',
  reserved: 'success',
  closed: 'outline',
};

/** Pre-orders from the public page. Everything the visitor typed is shown as plain text and nothing more. */
export function RequestsTab() {
  const { t } = useTranslation('sales');
  const canReserve = usePermission('sales.create');
  const canClose = usePermission('sales.update');
  const confirm = useConfirm();

  const [status, setStatus] = useUrlParam('requestStatus');
  const [answering, setAnswering] = useState<CatalogueRequest | null>(null);

  const close = useApiMutation<string>({
    mutationFn: (id) => api.post(`${REQUESTS}/${id}/close`, {}),
    invalidate: SALE_HOLD_PATHS,
    successMessage: 'sales:requests.closed',
  });

  const columns: Column<CatalogueRequest>[] = [
    { key: 'name', header: t('requests.fields.name'), cell: (row) => <span className="break-words">{row.name ?? t('requests.hidden')}</span>, mobile: 'title' },
    {
      key: 'status',
      header: t('requests.fields.status'),
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={STATUS_VARIANT[row.status]}>{t(`enums:catalogueRequestStatus.${row.status}`)}</Badge>
          {row.submissions > 1 && <span className="text-xs text-muted-foreground">{t('requests.times', { count: row.submissions })}</span>}
        </div>
      ),
      mobile: 'subtitle',
    },
    {
      key: 'phone',
      header: t('requests.fields.phone'),
      cell: (row) =>
        row.phone ? (
          <a href={`tel:${row.phone}`} className="focus-ring inline-flex min-h-11 items-center rounded text-primary underline underline-offset-2 md:min-h-0">
            {row.phone}
          </a>
        ) : (
          t('requests.hidden')
        ),
    },
    {
      key: 'animals',
      header: t('requests.fields.animals'),
      cell: (row) =>
        row.animals.length === 0 ? (
          '—'
        ) : (
          <div className="flex flex-wrap gap-x-2 gap-y-1">
            {row.animals.map((animal) => (
              <span key={animal.animalId} className="inline-flex items-center gap-1">
                <Link to={`/livestock/animals/${animal.animalId}`} className="focus-ring rounded text-primary underline underline-offset-2">
                  {animal.tag}
                </Link>
                {animal.reserved && <span className="text-xs text-muted-foreground">{t('requests.animalReserved')}</span>}
              </span>
            ))}
          </div>
        ),
    },
    {
      key: 'wanted',
      header: t('requests.fields.wanted'),
      cell: (row) => <span className="break-words whitespace-pre-wrap">{row.wanted ?? '—'}</span>,
      className: 'max-w-xs',
    },
    {
      key: 'note',
      header: t('requests.fields.note'),
      cell: (row) => <span className="break-words whitespace-pre-wrap">{row.note ?? '—'}</span>,
      className: 'max-w-xs',
    },
    { key: 'createdAt', header: t('requests.fields.received'), cell: (row) => formatDateTime(row.createdAt) },
  ];

  return (
    <>
      <DataTable<CatalogueRequest>
        path={REQUESTS}
        params={{ status: status || undefined }}
        columns={columns}
        searchable={false}
        urlPrefix="rq"
        filters={
          <Select
            aria-label={t('requests.statusFilter')}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={enumOptions('catalogueRequestStatus', CATALOGUE_REQUEST_STATUSES)}
            placeholder={t('requests.allStatuses')}
            className="md:w-56"
          />
        }
        empty={{ icon: Inbox, title: t('requests.emptyTitle'), description: t('requests.emptyBody') }}
        rowActions={(row) => [
          { label: t('requests.reserve'), icon: BookmarkPlus, hidden: !canReserve || row.status === 'closed', onClick: () => setAnswering(row) },
          {
            label: t('requests.close'),
            icon: CircleCheck,
            hidden: !canClose || row.status === 'closed',
            onClick: async () => {
              const ok = await confirm({ title: t('requests.closeTitle'), description: t('requests.closeBody') });
              if (ok) close.mutate(row.id);
            },
          },
        ]}
      />

      <ReserveDialog
        open={answering !== null}
        onOpenChange={(open) => !open && setAnswering(null)}
        // The animals still free come first: the first one is offered as the default.
        request={answering ? { id: answering.id, animals: [...answering.animals].sort((a, b) => Number(a.reserved) - Number(b.reserved)) } : null}
      />
    </>
  );
}
