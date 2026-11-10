import { RESERVATION_STATUSES, todayIso } from '@yap/shared';
import { BookmarkCheck, Receipt, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { type Column, ComboboxField, DataTable, DateField, FormDialog, MoneyText, NumberField, useConfirm, useUrlParam } from '@/components';
import { Alert, Badge, type BadgeVariant, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { zDate, zOptionalNumber, zOptionalRef } from '@/lib/forms';
import i18n, { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { counterpartyOptions } from '../shared';
import { type Reservation, type ReservationStatus, RESERVATIONS, SALE_HOLD_PATHS } from './types';

const STATUS_VARIANT: Record<ReservationStatus, BadgeVariant> = {
  open: 'info',
  converted: 'success',
  cancelled: 'outline',
  expired: 'neutral',
};

export function ReservationStatusBadge({ status }: { status: ReservationStatus }) {
  const { t } = useTranslation();
  return <Badge variant={STATUS_VARIANT[status]}>{t(`enums:reservationStatus.${status}`)}</Badge>;
}

const convertFields = z.object({
  counterpartyId: zOptionalRef(),
  price: zOptionalNumber(),
  date: zDate(),
});

/** A sale is made out to a counterparty: a buyer known only by name has to be put in the books first. */
const convertNeedsBuyer = convertFields.superRefine((value, issue) => {
  if (!value.counterpartyId) issue.addIssue({ code: 'custom', path: ['counterpartyId'], message: i18n.t('sales:reservations.buyerRequired') });
});

type ConvertValues = z.output<typeof convertFields>;

export function ReservationsTab() {
  const { t } = useTranslation('sales');
  const canConvert = usePermission('sales.create');
  const canCancel = usePermission('sales.update');
  const seesMoney = usePermission('finance.view');
  const confirm = useConfirm();

  const [status, setStatus] = useUrlParam('status');
  const [converting, setConverting] = useState<Reservation | null>(null);

  const cancel = useApiMutation<string>({
    mutationFn: (id) => api.post(`${RESERVATIONS}/${id}/cancel`, {}),
    invalidate: SALE_HOLD_PATHS,
    successMessage: 'sales:reservations.cancelled',
  });

  const convert = useApiMutation<ConvertValues, Reservation>({
    mutationFn: (values) =>
      api.post<Reservation>(`${RESERVATIONS}/${converting?.id}/convert`, {
        counterpartyId: values.counterpartyId,
        price: seesMoney ? values.price : null,
        date: values.date,
      }),
    invalidate: [...SALE_HOLD_PATHS, '/sales/orders'],
    silentError: true,
    onSuccess: (reservation) => toast.success(t('reservations.converted', { number: reservation.saleNumber ?? '' })),
  });

  const buyer = (row: Reservation) => row.counterpartyName ?? row.customerName ?? t('reservations.hiddenBuyer');

  const columns: Column<Reservation>[] = [
    { key: 'animal', header: t('reservations.fields.animal'), cell: (row) => row.animalTag, mobile: 'title' },
    {
      key: 'status',
      header: t('reservations.fields.status'),
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <ReservationStatusBadge status={row.status} />
          {row.withdrawalUntil && <Badge variant="warning">{t('reservations.withdrawal', { date: formatDate(row.withdrawalUntil) })}</Badge>}
        </div>
      ),
      mobile: 'subtitle',
    },
    {
      key: 'buyer',
      header: t('reservations.fields.buyer'),
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="break-words">{buyer(row)}</span>
          {row.customerPhone && <span className="text-xs text-muted-foreground">{row.customerPhone}</span>}
        </div>
      ),
    },
    { key: 'reservedUntil', header: t('reservations.fields.reservedUntil'), cell: (row) => formatDate(row.reservedUntil) },
    ...(seesMoney
      ? [{ key: 'agreedPrice', header: t('reservations.fields.agreedPrice'), cell: (row: Reservation) => <MoneyText value={row.agreedPrice} />, align: 'right' as const }]
      : []),
    { key: 'sale', header: t('reservations.fields.sale'), cell: (row) => row.saleNumber ?? '—', mobile: 'hidden' },
  ];

  return (
    <>
      <DataTable<Reservation>
        path={RESERVATIONS}
        params={{ status: status || undefined }}
        columns={columns}
        searchPlaceholder={t('reservations.searchPlaceholder')}
        rowHref={(row) => `/livestock/animals/${row.animalId}`}
        filters={
          <Select
            aria-label={t('reservations.statusFilter')}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={enumOptions('reservationStatus', RESERVATION_STATUSES)}
            placeholder={t('reservations.allStatuses')}
            className="md:w-56"
          />
        }
        empty={{ icon: BookmarkCheck, title: t('reservations.emptyTitle'), description: t('reservations.emptyBody') }}
        rowActions={(row) => [
          { label: t('reservations.convert'), icon: Receipt, hidden: !canConvert || row.status !== 'open' || row.saleId !== null, onClick: () => setConverting(row) },
          {
            label: t('reservations.cancel'),
            icon: X,
            destructive: true,
            hidden: !canCancel || row.status !== 'open',
            onClick: async () => {
              const ok = await confirm({
                title: t('reservations.cancelTitle', { tag: row.animalTag }),
                description: t('reservations.cancelBody'),
                destructive: true,
              });
              if (ok) cancel.mutate(row.id);
            },
          },
        ]}
      />

      <FormDialog
        open={converting !== null}
        onOpenChange={(open) => !open && setConverting(null)}
        title={t('reservations.convertTitle', { tag: converting?.animalTag ?? '' })}
        description={t('reservations.convertBody')}
        schema={converting?.counterpartyId ? convertFields : convertNeedsBuyer}
        defaultValues={{ counterpartyId: converting?.counterpartyId ?? null, price: converting?.agreedPrice ?? null, date: todayIso() }}
        onSubmit={(values) => convert.mutateAsync(values)}
        submitLabel={t('reservations.convert')}
      >
        {(form) => (
          <>
            {converting && !converting.counterpartyId && (
              <>
                <Alert tone="info">{t('reservations.counterpartyNeeded')}</Alert>
                <ComboboxField form={form} name="counterpartyId" label={t('reservations.fields.counterparty')} required loadOptions={counterpartyOptions} />
              </>
            )}
            {converting?.withdrawalUntil && <Alert tone="warning">{t('reservations.withdrawalNote', { date: formatDate(converting.withdrawalUntil) })}</Alert>}
            {seesMoney && <NumberField money form={form} name="price" label={t('reservations.fields.price')} hint={t('reservations.priceHint')} />}
            <DateField form={form} name="date" label={t('reservations.fields.date')} required />
          </>
        )}
      </FormDialog>
    </>
  );
}
