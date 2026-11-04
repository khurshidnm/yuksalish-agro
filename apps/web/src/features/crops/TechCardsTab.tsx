import { OPERATION_TYPES } from '@yap/shared';
import { ClipboardList, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { type UseFormReturn, useFieldArray } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { EmptyState, ErrorCard, FormDialog, FormGrid, MoneyText, NumberField, SelectField, TextField, useConfirm } from '@/components';
import { Badge, Button, Card, CardContent, Skeleton } from '@/components/ui';
import { useLocalName } from '@/features/farm/utils';
import { api } from '@/lib/api';
import { usePermission, useSeesCost } from '@/lib/auth';
import { formatNumber } from '@/lib/format';
import { zEnum, zNumber, zOptionalNumber, zRef, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail, useList } from '@/lib/query';
import { PLANS, TECH_CARDS } from './options';
import type { CropRef, TechCard } from './types';

const lineSchema = z.object({
  type: zEnum(OPERATION_TYPES),
  name: zText(160),
  offsetDays: zNumber(),
  seedKgHa: zOptionalNumber(),
  fertilizerKgHa: zOptionalNumber(),
  waterM3Ha: zOptionalNumber(),
  laborDaysHa: zOptionalNumber(),
  costPerHa: zOptionalNumber(),
});

const schema = z.object({
  cropId: zRef(),
  name: zText(160),
  expectedYieldTHa: zOptionalNumber(),
  lines: z.array(lineSchema).min(1),
});

type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;

function LinesEditor({ form, seesMoney }: { form: UseFormReturn<Values, unknown, Output>; seesMoney: boolean }) {
  const { t } = useTranslation('crops');
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lines' });
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">{t('techCards.lines')}</legend>
      {fields.map((row, index) => (
        <div key={row.id} className="space-y-3 rounded-lg border border-border p-3">
          <FormGrid>
            <SelectField form={form} name={`lines.${index}.type`} label={t('techCards.fields.type')} required options={enumOptions('operationType', OPERATION_TYPES)} />
            <TextField form={form} name={`lines.${index}.name`} label={t('techCards.fields.name')} required />
            <NumberField
              form={form}
              name={`lines.${index}.offsetDays`}
              label={t('techCards.fields.offset')}
              hint={t('techCards.fields.offsetHint')}
              suffix={t('unit.days')}
              maxDigits={0}
              allowNegative
              required
            />
            <NumberField form={form} name={`lines.${index}.seedKgHa`} label={t('techCards.fields.seed')} suffix={t('unit.kgPerHa')} />
            <NumberField form={form} name={`lines.${index}.fertilizerKgHa`} label={t('techCards.fields.fertilizer')} suffix={t('unit.kgPerHa')} />
            <NumberField form={form} name={`lines.${index}.waterM3Ha`} label={t('techCards.fields.water')} suffix={t('unit.m3PerHa')} />
            <NumberField form={form} name={`lines.${index}.laborDaysHa`} label={t('techCards.fields.labor')} />
            {seesMoney && <NumberField form={form} name={`lines.${index}.costPerHa`} label={t('techCards.fields.cost')} />}
          </FormGrid>
          <Button type="button" variant="ghost" className="text-destructive" onClick={() => remove(index)}>
            <Trash2 aria-hidden />
            {t('techCards.removeLine')}
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="w-full"
        onClick={() => append({ type: 'tillage', name: '', offsetDays: 0, seedKgHa: null, fertilizerKgHa: null, waterM3Ha: null, laborDaysHa: null, costPerHa: null })}
      >
        <Plus aria-hidden />
        {t('techCards.addLine')}
      </Button>
    </fieldset>
  );
}

const compact = <T extends Record<string, unknown>>(line: T) => Object.fromEntries(Object.entries(line).filter(([, v]) => v !== null));

export function TechCardsTab() {
  const { t } = useTranslation('crops');
  const localName = useLocalName();
  const canCreate = usePermission('crops.create');
  const canUpdate = usePermission('crops.update');
  const canDelete = usePermission('crops.delete');
  const seesMoney = useSeesCost('crops.approve');
  const confirm = useConfirm();
  const [editing, setEditing] = useState<TechCard | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: cards, isLoading, error, refetch } = useDetail<TechCard[]>(TECH_CARDS);
  const { data: crops } = useList<CropRef>('/crops/crops');
  const cropName = (id: string) => localName(crops?.data.find((c) => c.id === id)?.name);

  const save = useApiMutation<Output>({
    mutationFn: (values) => {
      const body = { ...values, lines: values.lines.map(compact) };
      return editing ? api.patch(`${TECH_CARDS}/${editing.id}`, body) : api.post(TECH_CARDS, body);
    },
    invalidate: [TECH_CARDS, PLANS],
    silentError: true,
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${TECH_CARDS}/${id}`),
    invalidate: [TECH_CARDS],
    successMessage: 'common:toast.deleted',
  });

  if (error) return <ErrorCard error={error} onRetry={() => void refetch()} />;

  const addButton = canCreate && (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('techCards.add')}
    </Button>
  );

  return (
    <div className="space-y-3">
      {(cards?.length ?? 0) > 0 && <div className="flex justify-end">{addButton}</div>}
      {isLoading && <Skeleton className="h-40 w-full" />}
      {cards?.length === 0 && <EmptyState icon={ClipboardList} title={t('techCards.emptyTitle')} description={t('techCards.emptyBody')} action={addButton} />}
      {cards?.map((card) => (
        <Card key={card.id}>
          <CardContent className="space-y-3 pt-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="font-semibold">{card.name}</h3>
                <p className="text-sm text-muted-foreground">
                  {cropName(card.cropId)}
                  {card.expectedYieldTHa !== null && ` · ${formatNumber(card.expectedYieldTHa, 2)} ${t('unit.tPerHa')}`}
                </p>
              </div>
              <div className="flex gap-1">
                {canUpdate && (
                  <Button variant="ghost" size="icon" aria-label={t('common:actions.edit')} onClick={() => setEditing(card)}>
                    <Pencil aria-hidden />
                  </Button>
                )}
                {canDelete && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('common:actions.delete')}
                    onClick={async () => {
                      const ok = await confirm({ title: t('techCards.deleteTitle'), description: card.name, destructive: true });
                      if (ok) remove.mutate(card.id);
                    }}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                )}
              </div>
            </div>
            <ol className="space-y-1 text-sm">
              {card.lines.map((line, index) => (
                <li key={index} className="flex items-baseline justify-between gap-3 border-b border-border py-1.5 last:border-0">
                  <span>
                    <Badge variant="outline" className="mr-2 tabular-nums">
                      {line.offsetDays > 0 ? '+' : ''}
                      {line.offsetDays}
                    </Badge>
                    {line.name}
                  </span>
                  {line.costPerHa != null && <MoneyText value={line.costPerHa} compact />}
                </li>
              ))}
            </ol>
            <p className="text-sm text-muted-foreground">
              {t('techCards.norms', {
                seed: formatNumber(card.norms.seedKgHa),
                fertilizer: formatNumber(card.norms.fertilizerKgHa),
                water: formatNumber(card.norms.waterM3Ha),
              })}
              {seesMoney && card.costPerHa !== null && (
                <>
                  {' · '}
                  {t('techCards.costPerHa')}: <MoneyText value={card.costPerHa} />
                </>
              )}
            </p>
          </CardContent>
        </Card>
      ))}

      <FormDialog
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        title={editing ? t('techCards.edit') : t('techCards.add')}
        schema={schema}
        defaultValues={
          editing
            ? {
                cropId: editing.cropId,
                name: editing.name,
                expectedYieldTHa: editing.expectedYieldTHa,
                lines: editing.lines.map((l) => ({ ...l, type: l.type as Values['lines'][number]['type'] })),
              }
            : { cropId: '', name: '', expectedYieldTHa: null, lines: [] }
        }
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
        size="lg"
      >
        {(form) => (
          <>
            <FormGrid>
              <SelectField
                form={form}
                name="cropId"
                label={t('plans.fields.crop')}
                required
                placeholder={t('common:form.selectPlaceholder')}
                options={(crops?.data ?? []).map((c) => ({ value: c.id, label: localName(c.name) }))}
              />
              <TextField form={form} name="name" label={t('techCards.fields.cardName')} required />
              <NumberField form={form} name="expectedYieldTHa" label={t('plans.fields.yield')} suffix={t('unit.tPerHa')} />
            </FormGrid>
            <LinesEditor form={form} seesMoney={seesMoney} />
          </>
        )}
      </FormDialog>
    </div>
  );
}
