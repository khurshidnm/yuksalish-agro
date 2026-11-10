import { addDays, todayIso } from '@yap/shared';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { ComboboxField, DateField, FormDialog, FormGrid, NumberField, TextField, TextareaField } from '@/components';
import { Alert } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { zDate, zOptionalNumber, zOptionalRef, zOptionalText, zRef } from '@/lib/forms';
import i18n from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { animalOptions, counterpartyOptions } from '../shared';
import { type Reservation, REQUESTS, RESERVATIONS, SALE_HOLD_PATHS } from './types';

/** How long a new hold lasts unless the person picks another day. A starting value. */
const DEFAULT_HOLD_DAYS = 7;

const fields = z.object({
  animalId: zRef(),
  counterpartyId: zOptionalRef(),
  customerName: zOptionalText(120),
  customerPhone: zOptionalText(24),
  agreedPrice: zOptionalNumber(),
  reservedUntil: zDate(),
  note: zOptionalText(500),
});

/** A hold needs somebody to hold the animal for: a buyer from the books, or at least a name. */
const withBuyer = fields.superRefine((value, issue) => {
  if (!value.counterpartyId && !value.customerName) {
    issue.addIssue({ code: 'custom', path: ['customerName'], message: i18n.t('sales:reservations.buyerRequired') });
  }
});

type Values = z.output<typeof fields>;

export interface ReserveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The animal to hold. Without one the dialog asks which. */
  animal?: { id: string; tag: string } | null;
  /** A pre-order being answered: the hold then carries the name and phone the visitor gave. */
  request?: { id: string; animals: { animalId: string; tag: string }[] } | null;
  /** Known withdrawal date of `animal`, to say so before the hold is made. */
  withdrawalUntil?: string | null;
}

/** Holds an animal for a buyer. No money moves here: a deposit is recorded in finance like any other. */
export function ReserveDialog({ open, onOpenChange, animal, request, withdrawalUntil }: ReserveDialogProps) {
  const { t } = useTranslation('sales');
  const seesMoney = usePermission('finance.view');
  const suggested = animal ?? (request?.animals[0] ? { id: request.animals[0].animalId, tag: request.animals[0].tag } : null);

  const save = useApiMutation<Values, Reservation>({
    mutationFn: async (values) => {
      const hold = {
        animalId: values.animalId,
        counterpartyId: values.counterpartyId,
        agreedPrice: seesMoney ? values.agreedPrice : null,
        reservedUntil: values.reservedUntil,
        note: values.note,
      };
      if (request) {
        const answer = await api.post<{ reservation: Reservation }>(`${REQUESTS}/${request.id}/reserve`, hold);
        return answer.reservation;
      }
      return api.post<Reservation>(RESERVATIONS, {
        ...hold,
        // A buyer from the books is named by the books.
        customerName: values.counterpartyId ? null : values.customerName,
        customerPhone: values.counterpartyId ? null : values.customerPhone,
      });
    },
    invalidate: SALE_HOLD_PATHS,
    silentError: true,
    onSuccess: (reservation) => {
      if (reservation.withdrawalUntil) toast.warning(t('reservations.reservedWithdrawal', { date: formatDate(reservation.withdrawalUntil) }));
      else toast.success(t('reservations.reserved'));
    },
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={request ? t('requests.reserveTitle') : animal ? t('reservations.reserveTitle', { tag: animal.tag }) : t('reservations.reserveAnyTitle')}
      description={request ? t('requests.reserveHint') : t('reservations.buyerHint')}
      schema={request ? fields : withBuyer}
      defaultValues={{
        animalId: suggested?.id ?? '',
        counterpartyId: null,
        customerName: '',
        customerPhone: '',
        agreedPrice: null,
        reservedUntil: addDays(todayIso(), DEFAULT_HOLD_DAYS),
        note: '',
      }}
      onSubmit={(values) => save.mutateAsync(values)}
      submitLabel={t('livestock:saleReadiness.reserve')}
    >
      {(form) => (
        <>
          {withdrawalUntil && <Alert tone="warning">{t('reservations.withdrawalNote', { date: formatDate(withdrawalUntil) })}</Alert>}
          {!animal && (
            <ComboboxField
              form={form}
              name="animalId"
              label={request ? t('requests.fields.animal') : t('reservations.fields.animal')}
              required
              loadOptions={animalOptions}
              selectedLabel={suggested?.tag}
            />
          )}
          <ComboboxField form={form} name="counterpartyId" label={t('reservations.fields.counterparty')} loadOptions={counterpartyOptions} clearable />
          {!request && !form.watch('counterpartyId') && (
            <FormGrid>
              <TextField form={form} name="customerName" label={t('reservations.fields.customerName')} autoComplete="off" maxLength={120} />
              <TextField form={form} name="customerPhone" label={t('reservations.fields.customerPhone')} type="tel" inputMode="tel" autoComplete="off" maxLength={24} />
            </FormGrid>
          )}
          <FormGrid>
            <DateField form={form} name="reservedUntil" label={t('reservations.fields.reservedUntil')} required min={todayIso()} />
            {seesMoney && <NumberField money form={form} name="agreedPrice" label={t('reservations.fields.agreedPrice')} hint={t('reservations.priceHint')} />}
          </FormGrid>
          <TextareaField form={form} name="note" label={t('reservations.fields.note')} rows={2} />
        </>
      )}
    </FormDialog>
  );
}
