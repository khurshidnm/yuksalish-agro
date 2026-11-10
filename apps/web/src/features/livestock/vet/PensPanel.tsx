import { todayIso } from '@yap/shared';
import { DoorOpen, LogIn, LogOut, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { z } from 'zod';
import { ComboboxField, DateField, EmptyState, ErrorCard, FormDialog, FormGrid, NumberField, SelectField, TextareaField, useConfirm } from '@/components';
import { Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Skeleton, Switch } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { zDate, zOptionalText, zRef } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';
import { cn } from '@/lib/utils';
import { DESK_STALE, PENS_PATH, animalOptions } from './options';
import type { Pen, PenSection } from './types';

const LINK = 'font-medium text-primary underline-offset-2 hover:underline';

const staySchema = z.object({
  facilityId: zRef(),
  eweId: zRef(),
  sinceDate: zDate(),
  days: z.number().int().min(1).max(60),
  notes: zOptionalText(500),
});

const penLabel = (pen: { name: string; parentName: string | null }) => (pen.parentName ? `${pen.parentName} · ${pen.name}` : pen.name);

export interface PenStayTarget {
  /** Chosen already when the dialog opens from a pen. */
  pen?: Pen | null;
  /** Chosen already when it opens after a lambing. */
  ewe?: { id: string; tag: string } | null;
  lambingId?: string | null;
}

/** Put a ewe and her newborn lambs in a free pen, with the day she is due out. */
export function PenStayDialog({ target, penDays, onOpenChange }: { target: PenStayTarget | null; penDays: number; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('vet');
  const pens = useDetail<Pen[]>(target ? PENS_PATH : null);
  const free = (pens.data ?? []).filter((pen) => pen.free);
  const save = useApiMutation<z.output<typeof staySchema>>({
    mutationFn: (values) => api.post(`${PENS_PATH}/stays`, { ...values, lambingId: target?.lambingId ?? undefined }),
    invalidate: DESK_STALE,
    silentError: true,
  });

  return (
    <FormDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={t('pens.putIn')}
      description={t('pens.putInHint')}
      schema={staySchema}
      defaultValues={{ facilityId: target?.pen?.id ?? '', eweId: target?.ewe?.id ?? '', sinceDate: todayIso(), days: penDays, notes: '' }}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage="common:toast.saved"
    >
      {(form) => (
        <>
          <SelectField
            form={form}
            name="facilityId"
            label={t('pens.pen')}
            required
            hint={!pens.isLoading && free.length === 0 ? t('pens.noneFree') : undefined}
            options={free.map((pen) => ({ value: pen.id, label: penLabel(pen) }))}
          />
          <ComboboxField form={form} name="eweId" label={t('common.ewe')} required loadOptions={animalOptions({ sex: 'female', forBreeding: 'true' })} selectedLabel={target?.ewe?.tag} />
          <FormGrid>
            <DateField form={form} name="sinceDate" label={t('pens.since')} required max={todayIso()} />
            <NumberField form={form} name="days" label={t('pens.days')} required hint={t('pens.daysHint', { n: penDays })} />
          </FormGrid>
          <TextareaField form={form} name="notes" label={t('common.notes')} />
        </>
      )}
    </FormDialog>
  );
}

/** Which barn sections are lambing pens. Each switch saves on its own. */
function ChoosePensDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('vet');
  const canSeeFarm = usePermission('farm.view');
  const sections = useDetail<PenSection[]>(open ? `${PENS_PATH}/sections` : null);
  const mark = useApiMutation<{ id: string; lambingPen: boolean }>({
    mutationFn: ({ id, lambingPen }) => api.post(`${PENS_PATH}/sections/${id}`, { lambingPen }),
    invalidate: DESK_STALE,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('pens.choose')}</DialogTitle>
          <DialogDescription>{t('pens.chooseHint')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-1">
          {sections.error ? (
            <ErrorCard error={sections.error} onRetry={() => void sections.refetch()} />
          ) : !sections.data ? (
            <Skeleton className="h-32 w-full" />
          ) : sections.data.length === 0 ? (
            <EmptyState
              icon={DoorOpen}
              title={t('pens.noSectionsTitle')}
              description={t('pens.noSectionsBody')}
              action={
                canSeeFarm ? (
                  <Button asChild variant="outline">
                    <Link to="/farm/facilities">{t('pens.openFacilities')}</Link>
                  </Button>
                ) : undefined
              }
            />
          ) : (
            sections.data.map((section) => (
              <label key={section.id} htmlFor={`pen-${section.id}`} className="flex min-h-12 items-center justify-between gap-3 border-b border-border py-1 last:border-b-0">
                <span className="min-w-0">
                  <span className="block font-medium break-words">{section.name}</span>
                  <span className="block text-sm text-muted-foreground">{section.parentName ?? '—'}</span>
                </span>
                <Switch
                  id={`pen-${section.id}`}
                  checked={section.lambingPen}
                  disabled={mark.isPending}
                  onCheckedChange={(lambingPen) => mark.mutate({ id: section.id, lambingPen })}
                />
              </label>
            ))
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface Props {
  pens: Pen[] | undefined;
  penDays: number;
}

/** Every lambing pen: who is in it, since when, when she is due out, and which stand free. */
export function PensPanel({ pens, penDays }: Props) {
  const { t } = useTranslation('vet');
  const confirm = useConfirm();
  const canRecord = usePermission('livestock.create');
  const canRecordVet = usePermission('health.update');
  const canChange = usePermission('livestock.update') || canRecordVet;
  const canEnter = canRecord || canRecordVet;
  const [choosing, setChoosing] = useState(false);
  const [target, setTarget] = useState<PenStayTarget | null>(null);

  const release = useApiMutation<string>({
    mutationFn: (stayId) => api.post(`${PENS_PATH}/stays/${stayId}/release`, {}),
    invalidate: DESK_STALE,
    successMessage: 'vet:pens.released',
  });

  const letOut = async (pen: Pen) => {
    if (!pen.stay) return;
    const ok = await confirm({
      title: t('pens.releaseTitle', { tag: pen.stay.eweTag }),
      description: t('pens.releaseBody', { pen: pen.name }),
      confirmLabel: t('pens.release'),
    });
    if (ok) release.mutate(pen.stay.id);
  };

  return (
    <section className="space-y-3" aria-label={t('pens.title')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('pens.title')}</h2>
        {canChange && (
          <Button variant="outline" size="sm" onClick={() => setChoosing(true)}>
            <Settings2 aria-hidden />
            {t('pens.choose')}
          </Button>
        )}
      </div>

      {!pens ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((n) => (
            <Skeleton key={n} className="h-32 w-full rounded-xl" />
          ))}
        </div>
      ) : pens.length === 0 ? (
        <div className="rounded-xl border border-border bg-card">
          <EmptyState icon={DoorOpen} title={t('pens.emptyTitle')} description={t(canChange ? 'pens.emptyBody' : 'pens.emptyBodyReader')} />
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {pens.map((pen) => (
            <li key={pen.id} className={cn('flex flex-col gap-2 rounded-xl border bg-card p-4', pen.stay?.releaseDue ? 'border-warning' : 'border-border')}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold break-words">{pen.name}</p>
                  {pen.parentName && <p className="text-sm text-muted-foreground">{pen.parentName}</p>}
                </div>
                <Badge variant={pen.free ? 'success' : pen.stay?.releaseDue ? 'warning' : 'neutral'}>
                  {t(pen.free ? 'pens.free' : pen.stay?.releaseDue ? 'pens.releaseDue' : 'pens.occupied')}
                </Badge>
              </div>
              {pen.stay ? (
                <>
                  <p>
                    <Link className={LINK} to={`/livestock/animals/${pen.stay.eweId}`}>
                      {pen.stay.eweTag}
                    </Link>
                    {pen.stay.lambs.length > 0 && (
                      <span className="text-muted-foreground">
                        {' + '}
                        {pen.stay.lambs.map((lamb, index) => (
                          <span key={lamb.id}>
                            {index > 0 && ', '}
                            <Link className={LINK} to={`/livestock/animals/${lamb.id}`}>
                              {lamb.tag}
                            </Link>
                          </span>
                        ))}
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t('pens.sinceUntil', { since: formatDate(pen.stay.sinceDate), until: pen.stay.plannedReleaseDate ? formatDate(pen.stay.plannedReleaseDate) : '—' })}
                  </p>
                  {canEnter && (
                    <Button variant="outline" className="mt-auto" loading={release.isPending && release.variables === pen.stay.id} onClick={() => void letOut(pen)}>
                      <LogOut aria-hidden />
                      {t('pens.release')}
                    </Button>
                  )}
                </>
              ) : (
                canEnter && (
                  <Button variant="outline" className="mt-auto" onClick={() => setTarget({ pen })}>
                    <LogIn aria-hidden />
                    {t('pens.putIn')}
                  </Button>
                )
              )}
            </li>
          ))}
        </ul>
      )}

      <ChoosePensDialog open={choosing} onOpenChange={setChoosing} />
      <PenStayDialog target={target} penDays={penDays} onOpenChange={(open) => !open && setTarget(null)} />
    </section>
  );
}
