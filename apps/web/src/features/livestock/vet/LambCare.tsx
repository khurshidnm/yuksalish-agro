import { LAMB_MOTHERING } from '@yap/shared';
import { Milk, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { z } from 'zod';
import { ComboboxField, ErrorCard, FormDialog, SelectField, SwitchField, TextField, TextareaField } from '@/components';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { zEnum, zOptionalRef, zOptionalText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { DESK_STALE, LAMBS_PATH, animalOptions } from './options';
import type { LambCare } from './types';

const schema = z.object({
  colostrumGiven: z.boolean(),
  /** The browser's own date-and-time text: "2027-03-02T21:40". */
  colostrumAt: z.string(),
  navelTreated: z.boolean(),
  mothering: zEnum(LAMB_MOTHERING),
  fosterEweId: zOptionalRef(),
  notes: zOptionalText(500),
});

/** An instant as the date-and-time field wants it, in the clock of this device. */
function toLocalInput(value: string | Date): string {
  const at = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function useCanRecordCare(): boolean {
  const create = usePermission('livestock.create');
  const vet = usePermission('health.update');
  return create || vet;
}

interface DialogProps {
  lamb: { id: string; tag: string } | null;
  onOpenChange: (open: boolean) => void;
}

/** Colostrum, navel and who raises the lamb. Opens with what is already recorded. */
export function LambCareDialog({ lamb, onOpenChange }: DialogProps) {
  const { t } = useTranslation('vet');
  const care = useDetail<LambCare>(lamb ? `${LAMBS_PATH}/${lamb.id}/care` : null);
  const current = care.data && care.data.lambId === lamb?.id ? care.data : null;
  const save = useApiMutation<z.output<typeof schema>>({
    mutationFn: (values) =>
      api.post(`${LAMBS_PATH}/${lamb!.id}/care`, {
        colostrumAt: values.colostrumGiven ? new Date(values.colostrumAt || Date.now()).toISOString() : null,
        navelTreated: values.navelTreated,
        mothering: values.mothering,
        fosterEweId: values.mothering === 'fostered' ? values.fosterEweId : null,
        notes: values.notes,
      }),
    invalidate: DESK_STALE,
    silentError: true,
  });

  return (
    <FormDialog
      // Not shown before the saved record has arrived: the form would open empty and overwrite it.
      open={lamb !== null && !care.isLoading}
      onOpenChange={onOpenChange}
      title={t('care.title', { tag: lamb?.tag })}
      description={current?.damTag ? t('care.dam', { tag: current.damTag }) : undefined}
      schema={schema}
      defaultValues={{
        colostrumGiven: Boolean(current?.colostrumAt),
        colostrumAt: toLocalInput(current?.colostrumAt ?? new Date()),
        navelTreated: current?.navelTreated ?? false,
        mothering: current?.mothering ?? 'with_dam',
        fosterEweId: current?.fosterEweId ?? null,
        notes: current?.notes ?? '',
      }}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage="common:toast.saved"
    >
      {(form) => (
        <>
          <SwitchField form={form} name="colostrumGiven" label={t('care.colostrumGiven')} />
          {form.watch('colostrumGiven') && <TextField form={form} name="colostrumAt" type="datetime-local" label={t('care.colostrumAt')} />}
          <SwitchField form={form} name="navelTreated" label={t('care.navelTreated')} />
          <SelectField form={form} name="mothering" label={t('care.mothering')} required options={enumOptions('lambMothering', LAMB_MOTHERING)} />
          {form.watch('mothering') === 'fostered' && (
            <ComboboxField
              form={form}
              name="fosterEweId"
              label={t('care.fosterEwe')}
              hint={t('care.fosterHint')}
              required
              loadOptions={animalOptions({ sex: 'female', forBreeding: 'true' })}
              selectedLabel={current?.fosterEweTag ?? undefined}
            />
          )}
          <TextareaField form={form} name="notes" label={t('common.notes')} />
        </>
      )}
    </FormDialog>
  );
}

/** On the lamb's own card: what was done in its first hours, and who raises it. */
export function LambCareCard({ animalId, tag, young }: { animalId: string; tag: string; young: boolean }) {
  const { t } = useTranslation('vet');
  const canRecord = useCanRecordCare();
  const care = useDetail<LambCare>(`${LAMBS_PATH}/${animalId}/care`);
  const [editing, setEditing] = useState(false);

  if (care.error) return <ErrorCard error={care.error} onRetry={() => void care.refetch()} />;
  const data = care.data;
  // A grown animal with nothing on record: the card would only say "not recorded" for ever.
  if (data && !data.recorded && !young) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Milk className="size-5 text-muted-foreground" aria-hidden />
          {t('care.cardTitle')}
        </CardTitle>
        {canRecord && data && (
          <Button variant="outline" size="sm" className="min-h-11" onClick={() => setEditing(true)}>
            <Pencil aria-hidden />
            {t(data.recorded ? 'common:actions.edit' : 'care.record')}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {!data ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <dl className="grid grid-cols-2 gap-4">
            <div>
              <dt className="text-sm text-muted-foreground">{t('care.colostrum')}</dt>
              <dd className="font-medium break-words">{data.colostrumAt ? formatDateTime(data.colostrumAt) : <Badge variant="warning">{t('care.notRecorded')}</Badge>}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t('care.navel')}</dt>
              <dd className="font-medium">{data.navelTreated ? t('care.treated') : t('care.notRecorded')}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t('care.mothering')}</dt>
              <dd className="font-medium">{data.mothering ? t(`enums:lambMothering.${data.mothering}`) : '—'}</dd>
            </div>
            {data.mothering === 'fostered' && data.fosterEweId && (
              <div>
                <dt className="text-sm text-muted-foreground">{t('care.fosterEwe')}</dt>
                <dd className="font-medium">
                  <Link className="underline underline-offset-2" to={`/livestock/animals/${data.fosterEweId}`}>
                    {data.fosterEweTag}
                  </Link>
                </dd>
              </div>
            )}
            {data.notes && <p className="col-span-2 rounded-lg bg-muted p-3 text-sm">{data.notes}</p>}
          </dl>
        )}
      </CardContent>
      <LambCareDialog lamb={editing ? { id: animalId, tag } : null} onOpenChange={(open) => !open && setEditing(false)} />
    </Card>
  );
}
