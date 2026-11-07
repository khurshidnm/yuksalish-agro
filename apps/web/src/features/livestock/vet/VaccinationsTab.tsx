import { ANIMAL_CATEGORIES, todayIso } from '@yap/shared';
import { CalendarCheck, ListChecks, Pencil, Plus, Syringe, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ComboboxField, type Column, DataTableView, DateField, ErrorCard, FormDialog, FormGrid, NumberField, SelectField, SwitchField, TextField, TextareaField, useConfirm } from '@/components';
import { Badge, type BadgeVariant, Button, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber } from '@/lib/format';
import { zDate, zOptionalEnum, zOptionalNumber, zOptionalRef, zOptionalText, zRef, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { ANIMALS_PATH, HEALTH_PATH, drugOptions, employeeOptions, herdOptions, warehouseOptions } from './options';
import type { DueRow, DueState, VaccinationDue, VaccinationPlan } from './types';

const PLANS = `${HEALTH_PATH}/vaccination-plans`;
const DUE = `${HEALTH_PATH}/vaccinations/due`;

const STATE_TONE: Record<DueState, BadgeVariant> = { overdue: 'danger', today: 'warning', upcoming: 'info' };

const planSchema = z.object({
  name: zText(120),
  itemId: zOptionalRef(),
  category: zOptionalEnum(ANIMAL_CATEGORIES),
  ageDays: zOptionalNumber(),
  intervalDays: zOptionalNumber(),
  mandatory: z.boolean(),
  notes: zOptionalText(1000),
});

const herdSchema = z.object({
  herdId: zRef(),
  planId: zOptionalRef(),
  date: zDate(),
  itemId: zOptionalRef(),
  warehouseId: zOptionalRef(),
  dosePerHead: zOptionalNumber(),
  headCount: zOptionalNumber(),
  qtyUsed: zOptionalNumber(),
  vetEmployeeId: zOptionalRef(),
  notes: zOptionalText(1000),
});

interface HerdPreset {
  planId: string | null;
  planName?: string;
  itemId: string | null;
  herdId: string | null;
  herdName?: string | null;
}

function HerdVaccinationDialog({ preset, onClose }: { preset: HerdPreset | null; onClose: () => void }) {
  const { t } = useTranslation('vet');
  const vaccinate = useApiMutation<z.output<typeof herdSchema>>({
    mutationFn: (values) => api.postOnce(`${HEALTH_PATH}/vaccinations/herd`, values),
    invalidate: [HEALTH_PATH, ANIMALS_PATH, '/inventory'],
    silentError: true,
  });
  return (
    <FormDialog
      open={preset !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t('vaccinations.herdTitle')}
      description={preset?.planName}
      schema={herdSchema}
      defaultValues={{
        herdId: preset?.herdId ?? '',
        planId: preset?.planId ?? null,
        date: todayIso(),
        itemId: preset?.itemId ?? null,
        warehouseId: null,
        dosePerHead: 1,
        headCount: null,
        qtyUsed: null,
        vetEmployeeId: null,
        notes: '',
      }}
      onSubmit={(values) => vaccinate.mutateAsync(values)}
      successMessage="common:toast.created"
      size="lg"
    >
      {(form) => (
        <>
          <ComboboxField form={form} name="herdId" label={t('common.herd')} required loadOptions={herdOptions()} selectedLabel={preset?.herdName} />
          <FormGrid>
            <DateField form={form} name="date" label={t('common.date')} required max={todayIso()} />
            <ComboboxField form={form} name="vetEmployeeId" label={t('journal.vet')} loadOptions={employeeOptions()} />
          </FormGrid>
          <FormGrid>
            <ComboboxField form={form} name="itemId" label={t('vaccinations.vaccine')} loadOptions={drugOptions} hint={t('vaccinations.vaccineHint')} selectedLabel={preset?.planName} />
            <ComboboxField form={form} name="warehouseId" label={t('journal.warehouse')} loadOptions={warehouseOptions()} hint={t('journal.warehouseHint')} />
            <NumberField form={form} name="dosePerHead" label={t('vaccinations.dosePerHead')} />
            <NumberField form={form} name="headCount" label={t('journal.headCount')} hint={t('journal.headCountHint')} maxDigits={0} />
          </FormGrid>
          <NumberField form={form} name="qtyUsed" label={t('journal.qtyUsed')} hint={t('vaccinations.qtyHint')} />
          <TextareaField form={form} name="notes" label={t('common.notes')} />
        </>
      )}
    </FormDialog>
  );
}

function PlanDialog({ open, plan, onClose }: { open: boolean; plan: VaccinationPlan | null; onClose: () => void }) {
  const { t } = useTranslation('vet');
  const save = useApiMutation<z.output<typeof planSchema>>({
    mutationFn: (values) => (plan ? api.patch(`${PLANS}/${plan.id}`, values) : api.post(PLANS, values)),
    invalidate: [HEALTH_PATH],
    silentError: true,
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={plan ? t('plans.edit') : t('plans.add')}
      description={t('plans.hint')}
      schema={planSchema}
      defaultValues={{
        name: plan?.name ?? '',
        itemId: plan?.itemId ?? null,
        category: (plan?.category ?? '') as z.input<typeof planSchema>['category'],
        ageDays: plan?.ageDays ?? null,
        intervalDays: plan?.intervalDays ?? null,
        mandatory: plan?.mandatory ?? true,
        notes: plan?.notes ?? '',
      }}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage={plan ? 'common:toast.updated' : 'common:toast.created'}
    >
      {(form) => (
        <>
          <TextField form={form} name="name" label={t('plans.name')} required autoFocus />
          <ComboboxField form={form} name="itemId" label={t('vaccinations.vaccine')} loadOptions={drugOptions} selectedLabel={plan?.itemName} hint={t('plans.itemHint')} />
          <SelectField form={form} name="category" label={t('plans.category')} options={enumOptions('animalCategory', ANIMAL_CATEGORIES)} placeholder={t('plans.anyCategory')} />
          <FormGrid>
            <NumberField form={form} name="ageDays" label={t('plans.ageDays')} hint={t('plans.ageHint')} suffix={t('common.days')} maxDigits={0} />
            <NumberField form={form} name="intervalDays" label={t('plans.intervalDays')} hint={t('plans.intervalHint')} suffix={t('common.days')} maxDigits={0} />
          </FormGrid>
          <SwitchField form={form} name="mandatory" label={t('plans.mandatory')} />
          <TextareaField form={form} name="notes" label={t('common.notes')} />
        </>
      )}
    </FormDialog>
  );
}

export function VaccinationsTab() {
  const { t } = useTranslation('vet');
  const confirm = useConfirm();
  const canWrite = usePermission('health.update');
  const canDelete = usePermission('health.delete');

  const [horizon, setHorizon] = useState('30');
  const [herdPreset, setHerdPreset] = useState<HerdPreset | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [planEditing, setPlanEditing] = useState<VaccinationPlan | null>(null);

  const due = useDetail<VaccinationDue>(DUE, { horizonDays: horizon });
  const plans = useDetail<VaccinationPlan[]>(PLANS);

  const removePlan = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PLANS}/${id}`),
    invalidate: [HEALTH_PATH],
    successMessage: 'common:toast.deleted',
  });

  if (due.error) return <ErrorCard error={due.error} onRetry={() => void due.refetch()} />;

  const stateLabel = (row: DueRow) =>
    row.state === 'overdue' ? t('vaccinations.daysOverdue', { count: row.daysOverdue }) : row.state === 'today' ? t('vaccinations.dueToday') : formatDate(row.dueDate);

  const dueColumns: Column<DueRow>[] = [
    {
      key: 'plan',
      header: t('plans.name'),
      mobile: 'title',
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1 font-medium">
          {row.planName}
          {!row.mandatory && <Badge variant="outline">{t('plans.optional')}</Badge>}
        </span>
      ),
    },
    { key: 'state', header: t('vaccinations.when'), mobile: 'subtitle', cell: (row) => <Badge variant={STATE_TONE[row.state]}>{stateLabel(row)}</Badge> },
    { key: 'herd', header: t('common.herd'), cell: (row) => row.herdName ?? t('vaccinations.noHerd') },
    { key: 'head', header: t('vaccinations.head'), align: 'right', cell: (row) => formatNumber(row.head) },
  ];

  const planColumns: Column<VaccinationPlan>[] = [
    {
      key: 'name',
      header: t('plans.name'),
      mobile: 'title',
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1 font-medium">
          {row.name}
          {!row.mandatory && <Badge variant="outline">{t('plans.optional')}</Badge>}
        </span>
      ),
    },
    { key: 'item', header: t('vaccinations.vaccine'), mobile: 'subtitle', cell: (row) => row.itemName ?? '—' },
    { key: 'age', header: t('plans.ageDays'), align: 'right', cell: (row) => (row.ageDays === null ? t('plans.anyAge') : t('common.dayCount', { count: row.ageDays })) },
    { key: 'interval', header: t('plans.intervalDays'), align: 'right', cell: (row) => (row.intervalDays === null ? t('plans.once') : t('common.dayCount', { count: row.intervalDays })) },
  ];

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <h2 className="text-lg font-semibold">{t('vaccinations.dueTitle')}</h2>
          <div className="flex flex-col gap-2 md:flex-row">
            <Select
              aria-label={t('vaccinations.horizon')}
              value={horizon}
              onChange={(e) => setHorizon(e.target.value)}
              options={['7', '30', '90', '180'].map((value) => ({ value, label: t('vaccinations.nextDays', { count: Number(value) }) }))}
              className="md:w-44"
            />
            {canWrite && (
              <Button onClick={() => setHerdPreset({ planId: null, itemId: null, herdId: null })}>
                <Syringe aria-hidden />
                {t('vaccinations.vaccinateHerd')}
              </Button>
            )}
          </div>
        </div>
        <DataTableView
          rows={due.data?.rows ?? []}
          rowKey={(row) => `${row.planId}-${row.herdId}-${row.dueDate}`}
          columns={dueColumns}
          loading={due.isLoading}
          empty={{ icon: CalendarCheck, title: t('vaccinations.emptyTitle'), description: t('vaccinations.emptyBody') }}
          rowActions={(row) => [
            {
              label: t('vaccinations.vaccinate'),
              icon: Syringe,
              hidden: !canWrite || !row.herdId,
              onClick: () => setHerdPreset({ planId: row.planId, planName: row.planName, itemId: row.itemId, herdId: row.herdId, herdName: row.herdName }),
            },
          ]}
        />
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{t('plans.title')}</h2>
          {canWrite && (
            <Button
              variant="outline"
              onClick={() => {
                setPlanEditing(null);
                setPlanOpen(true);
              }}
            >
              <Plus aria-hidden />
              {t('plans.add')}
            </Button>
          )}
        </div>
        <DataTableView
          rows={plans.data ?? []}
          rowKey={(row) => row.id}
          columns={planColumns}
          loading={plans.isLoading}
          error={plans.error}
          onRetry={() => void plans.refetch()}
          empty={{ icon: ListChecks, title: t('plans.emptyTitle'), description: t('plans.emptyBody') }}
          rowActions={(row) => [
            {
              label: t('common:actions.edit'),
              icon: Pencil,
              hidden: !canWrite,
              onClick: () => {
                setPlanEditing(row);
                setPlanOpen(true);
              },
            },
            {
              label: t('common:actions.delete'),
              icon: Trash2,
              destructive: true,
              hidden: !canDelete,
              onClick: async () => {
                const ok = await confirm({ title: t('plans.deleteTitle'), description: t('plans.deleteBody', { name: row.name }), destructive: true });
                if (ok) removePlan.mutate(row.id);
              },
            },
          ]}
        />
      </section>

      <HerdVaccinationDialog preset={herdPreset} onClose={() => setHerdPreset(null)} />
      <PlanDialog
        open={planOpen}
        plan={planEditing}
        onClose={() => {
          setPlanOpen(false);
          setPlanEditing(null);
        }}
      />
    </div>
  );
}
