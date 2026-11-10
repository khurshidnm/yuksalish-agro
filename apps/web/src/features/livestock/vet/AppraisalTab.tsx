import { todayIso } from '@yap/shared';
import { Flag, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { DateField, ErrorCard, FormDialog, FormField, FormGrid, NumberField, SelectField, StatCard, TextField, TextareaField, useConfirm } from '@/components';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Skeleton, TBody, THead, Table, Td, Th, Tr } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber } from '@/lib/format';
import { zDate, zOptionalNumber, zOptionalText, zRef } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';
import { ConditionBadge, ScoreButtons, classLabel } from './appraisal-parts';
import { CullMarkDialog, useClearCullMark } from './CullingTab';
import { ANIMALS_PATH, APPRAISAL_STALE, CONDITION_PATH, EWES_PATH, FAT_TAIL_PATH, GRADINGS_PATH } from './options';
import { ScoreBreakdownDialog } from './ScoreBreakdown';
import type { Appraisal, EweScore } from './types';

const conditionSchema = z.object({ score: z.number(), date: zDate(), notes: zOptionalText(500) });
const fatTailSchema = z
  .object({
    date: zDate(),
    widthCm: zOptionalNumber().refine((v) => v === null || (v > 0 && v <= 100)),
    lengthCm: zOptionalNumber().refine((v) => v === null || (v > 0 && v <= 100)),
    circumferenceCm: zOptionalNumber().refine((v) => v === null || (v > 0 && v <= 200)),
    notes: zOptionalText(500),
  })
  .refine((v) => v.widthCm !== null || v.lengthCm !== null || v.circumferenceCm !== null, { path: ['widthCm'] });
const gradingSchema = z.object({ classKey: zRef(), date: zDate(), gradedBy: zOptionalText(120), notes: zOptionalText(500) });

type Kind = 'condition' | 'fatTail' | 'grading';
const PATHS: Record<Kind, string> = { condition: CONDITION_PATH, fatTail: FAT_TAIL_PATH, grading: GRADINGS_PATH };

/** The open cull mark of one animal, for the badge in the card's header. Shares the tab's query. */
export function useCullMark(animalId: string | undefined) {
  return useDetail<Appraisal>(animalId ? `${ANIMALS_PATH}/${animalId}/appraisal` : null).data?.cullMark ?? null;
}

interface SectionProps {
  title: string;
  action?: ReactNode;
  empty: string;
  isEmpty: boolean;
  children: ReactNode;
}

function Section({ title, action, empty, isEmpty, children }: SectionProps) {
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent>{isEmpty ? <p className="text-muted-foreground">{empty}</p> : <div className="overflow-x-auto">{children}</div>}</CardContent>
    </Card>
  );
}

interface Props {
  animalId: string;
  tag: string;
  /** Only a female that has lambed has a ewe score. */
  female: boolean;
  onFarm: boolean;
}

/** What a hand and an eye find on the animal: body condition, fat tail, class, and for a ewe her score. */
export function AppraisalTab({ animalId, tag, female, onFarm }: Props) {
  const { t } = useTranslation('vet');
  const confirm = useConfirm();
  const create = usePermission('livestock.create');
  const change = usePermission('livestock.update');
  const remove = usePermission('livestock.delete');
  const vet = usePermission('health.update');
  const vetRemove = usePermission('health.delete');
  const seesNames = usePermission('pii.view');
  const canRecord = (create || vet) && onFarm;
  const canDecide = (change || vet) && onFarm;
  const canRemove = remove || vetRemove;

  const [adding, setAdding] = useState<Kind | null>(null);
  const [marking, setMarking] = useState(false);
  const [breakdown, setBreakdown] = useState(false);
  const clearMark = useClearCullMark();
  const today = todayIso();

  const appraisal = useDetail<Appraisal>(`${ANIMALS_PATH}/${animalId}/appraisal`);
  const score = useDetail<EweScore | null>(female ? `${EWES_PATH}/${animalId}/score` : null);

  const post = (kind: Kind) => (values: object) => api.post(PATHS[kind], { ...values, animalId });
  const addCondition = useApiMutation<z.output<typeof conditionSchema>>({ mutationFn: post('condition'), invalidate: APPRAISAL_STALE, silentError: true });
  const addFatTail = useApiMutation<z.output<typeof fatTailSchema>>({ mutationFn: post('fatTail'), invalidate: APPRAISAL_STALE, silentError: true });
  const addGrading = useApiMutation<z.output<typeof gradingSchema>>({ mutationFn: post('grading'), invalidate: APPRAISAL_STALE, silentError: true });
  const removeRow = useApiMutation<{ kind: Kind; id: string }>({
    mutationFn: ({ kind, id }) => api.delete(`${PATHS[kind]}/${id}`),
    invalidate: APPRAISAL_STALE,
    successMessage: 'common:toast.deleted',
  });

  if (appraisal.error) return <ErrorCard error={appraisal.error} onRetry={() => void appraisal.refetch()} />;
  const data = appraisal.data;
  if (!data) return <Skeleton className="h-72 w-full" />;

  const addButton = (kind: Kind, label: string) =>
    (kind === 'grading' ? canDecide : canRecord) ? (
      <Button variant="outline" onClick={() => setAdding(kind)}>
        <Plus aria-hidden />
        {label}
      </Button>
    ) : undefined;
  const deleteCell = (kind: Kind, id: string) =>
    canRemove && (
      <Td className="text-right">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('common:actions.delete')}
          onClick={async () => {
            const ok = await confirm({ title: t('appraisal.deleteTitle'), destructive: true });
            if (ok) removeRow.mutate({ kind, id });
          }}
        >
          <Trash2 aria-hidden />
        </Button>
      </Td>
    );
  const deleteHead = canRemove && <Th aria-label={t('common:actions.delete')} />;
  const cm = (value: number | null) => formatNumber(value, 1);
  const ewe = score.data ?? null;

  return (
    <div className="space-y-4">
      {data.cullMark ? (
        <Alert tone="warning" title={t('culling.markedAlert', { reason: t(`enums:cullReason.${data.cullMark.reason}`), date: formatDate(data.cullMark.markedOn) })}>
          {data.cullMark.note && <p className="break-words">{data.cullMark.note}</p>}
          {canDecide && (
            <Button variant="outline" className="mt-2" onClick={() => void clearMark({ id: data.cullMark!.id, tag })}>
              {t('culling.clear')}
            </Button>
          )}
        </Alert>
      ) : (
        canDecide && (
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setMarking(true)}>
              <Flag aria-hidden />
              {t('culling.mark')}
            </Button>
          </div>
        )
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard
          label={t('condition.score')}
          value={formatNumber(data.bodyCondition?.score ?? null, 1)}
          hint={data.bodyCondition ? formatDate(data.bodyCondition.date) : t('condition.never')}
        />
        <StatCard label={t('grading.class')} value={data.gradingClass ? classLabel(data.gradingClass) : '—'} hint={data.gradedOn ? formatDate(data.gradedOn) : t('grading.never')} />
        {female && (
          <StatCard
            label={t('score.title')}
            loading={score.isLoading}
            value={formatNumber(ewe?.score ?? null, 1)}
            hint={
              ewe && ewe.score !== null ? (
                <button type="button" onClick={() => setBreakdown(true)} className="focus-ring -mx-1 min-h-11 rounded px-1 text-left text-primary underline decoration-dotted underline-offset-4">
                  {t('score.how')}
                </button>
              ) : (
                t('score.none')
              )
            }
          />
        )}
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <Section title={t('condition.history')} action={addButton('condition', t('condition.record'))} empty={t('condition.never')} isEmpty={data.conditionScores.length === 0}>
          <Table>
            <THead>
              <Tr>
                <Th>{t('common.date')}</Th>
                <Th className="text-right">{t('condition.score')}</Th>
                <Th>{t('common.notes')}</Th>
                {deleteHead}
              </Tr>
            </THead>
            <TBody>
              {data.conditionScores.map((row) => (
                <Tr key={row.id}>
                  <Td className="whitespace-nowrap tabular-nums">{formatDate(row.date)}</Td>
                  <Td className="text-right">
                    <ConditionBadge score={row.score} />
                  </Td>
                  <Td className="break-words">{row.notes ?? '—'}</Td>
                  {deleteCell('condition', row.id)}
                </Tr>
              ))}
            </TBody>
          </Table>
        </Section>

        <Section title={t('fatTail.title')} action={addButton('fatTail', t('fatTail.add'))} empty={t('fatTail.empty')} isEmpty={data.fatTail.length === 0}>
          <Table>
            <THead>
              <Tr>
                <Th>{t('common.date')}</Th>
                <Th className="text-right">{t('fatTail.width')}</Th>
                <Th className="text-right">{t('fatTail.length')}</Th>
                <Th className="text-right">{t('fatTail.circumference')}</Th>
                <Th>{t('common.notes')}</Th>
                {deleteHead}
              </Tr>
            </THead>
            <TBody>
              {data.fatTail.map((row) => (
                <Tr key={row.id}>
                  <Td className="whitespace-nowrap tabular-nums">{formatDate(row.date)}</Td>
                  <Td className="text-right whitespace-nowrap tabular-nums">{cm(row.widthCm)}</Td>
                  <Td className="text-right whitespace-nowrap tabular-nums">{cm(row.lengthCm)}</Td>
                  <Td className="text-right whitespace-nowrap tabular-nums">{cm(row.circumferenceCm)}</Td>
                  <Td className="break-words">{row.notes ?? '—'}</Td>
                  {deleteCell('fatTail', row.id)}
                </Tr>
              ))}
            </TBody>
          </Table>
        </Section>

        <Section title={t('grading.title')} action={addButton('grading', t('grading.add'))} empty={t('grading.never')} isEmpty={data.gradings.length === 0}>
          <Table>
            <THead>
              <Tr>
                <Th>{t('common.date')}</Th>
                <Th>{t('grading.class')}</Th>
                {seesNames && <Th>{t('grading.gradedBy')}</Th>}
                <Th>{t('common.notes')}</Th>
                {deleteHead}
              </Tr>
            </THead>
            <TBody>
              {data.gradings.map((row) => (
                <Tr key={row.id}>
                  <Td className="whitespace-nowrap tabular-nums">{formatDate(row.date)}</Td>
                  <Td>{classLabel(row.classKey)}</Td>
                  {seesNames && <Td className="break-words">{row.gradedBy ?? '—'}</Td>}
                  <Td className="break-words">{row.notes ?? '—'}</Td>
                  {deleteCell('grading', row.id)}
                </Tr>
              ))}
            </TBody>
          </Table>
        </Section>
      </div>

      <FormDialog
        open={adding === 'condition'}
        onOpenChange={(open) => !open && setAdding(null)}
        title={t('condition.recordFor', { tag })}
        description={t('condition.scaleHint')}
        schema={conditionSchema}
        defaultValues={{ date: today, notes: '' }}
        onSubmit={(values) => addCondition.mutateAsync(values)}
        successMessage="common:toast.saved"
      >
        {(form) => (
          <>
            <FormField form={form} name="score" label={t('condition.score')} required>
              {(field) => <ScoreButtons value={field.value ?? null} onPick={field.onChange} label={t('condition.scoreFor', { tag })} />}
            </FormField>
            <DateField form={form} name="date" label={t('common.date')} required max={today} hint={t('condition.sameDayHint')} />
            <TextareaField form={form} name="notes" label={t('common.notes')} rows={2} />
          </>
        )}
      </FormDialog>

      <FormDialog
        open={adding === 'fatTail'}
        onOpenChange={(open) => !open && setAdding(null)}
        title={t('fatTail.addFor', { tag })}
        description={t('fatTail.hint')}
        schema={fatTailSchema}
        defaultValues={{ date: today, widthCm: null, lengthCm: null, circumferenceCm: null, notes: '' }}
        onSubmit={(values) => addFatTail.mutateAsync(values)}
        successMessage="common:toast.saved"
      >
        {(form) => (
          <>
            <FormGrid>
              <NumberField form={form} name="widthCm" label={t('fatTail.width')} maxDigits={1} />
              <NumberField form={form} name="lengthCm" label={t('fatTail.length')} maxDigits={1} />
              <NumberField form={form} name="circumferenceCm" label={t('fatTail.circumference')} maxDigits={1} />
              <DateField form={form} name="date" label={t('common.date')} required max={today} />
            </FormGrid>
            <TextareaField form={form} name="notes" label={t('common.notes')} rows={2} />
          </>
        )}
      </FormDialog>

      <FormDialog
        open={adding === 'grading'}
        onOpenChange={(open) => !open && setAdding(null)}
        title={t('grading.addFor', { tag })}
        description={t('grading.hint')}
        schema={gradingSchema}
        defaultValues={{ classKey: '', date: today, gradedBy: '', notes: '' }}
        onSubmit={(values) => addGrading.mutateAsync(values)}
        successMessage="common:toast.saved"
      >
        {(form) => (
          <>
            <SelectField form={form} name="classKey" label={t('grading.class')} required options={data.gradingClasses.map((key) => ({ value: key, label: classLabel(key) }))} />
            <FormGrid>
              <DateField form={form} name="date" label={t('common.date')} required max={today} />
              <TextField form={form} name="gradedBy" label={t('grading.gradedBy')} maxLength={120} autoComplete="off" />
            </FormGrid>
            <TextareaField form={form} name="notes" label={t('common.notes')} rows={2} />
          </>
        )}
      </FormDialog>

      <CullMarkDialog animal={marking ? { animalId, tag, reasons: [] } : null} onClose={() => setMarking(false)} />
      <ScoreBreakdownDialog ewe={breakdown && ewe ? { ...ewe, tag } : null} onClose={() => setBreakdown(false)} />
    </div>
  );
}
