import { Plus, Scale, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, DataTableView, DateField, FormDialog, FormGrid, NumberField, StatCard, TextField, useConfirm } from '@/components';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber, formatPercent } from '@/lib/format';
import { zDate, zOptionalText, zPositive } from '@/lib/forms';
import { useApiMutation } from '@/lib/query';
import { formatHa } from '../utils';
import type { PastureEstimate } from './types';

const sampleSchema = z.object({
  date: zDate(),
  biomassKgHa: zPositive(),
  notes: zOptionalText(500),
});

type Sample = PastureEstimate['samples'][number];

/** How long the pasture can feed the flock, from its green biomass, and the samples that calibrate it. */
export function PastureCard({ fieldId, areaHa, pasture }: { fieldId: string; areaHa: number; pasture: PastureEstimate }) {
  const { t } = useTranslation('farm');
  const canUpdate = usePermission('farm.update');
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const base = `/farm/satellite/fields/${fieldId}`;

  const save = useApiMutation<z.output<typeof sampleSchema>>({
    mutationFn: (values) => api.post(`${base}/pasture-samples`, values),
    invalidate: [base],
    silentError: true,
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${base}/pasture-samples/${id}`),
    invalidate: [base],
    successMessage: 'common:toast.deleted',
  });

  const columns: Column<Sample>[] = [
    { key: 'date', header: t('pasture.sampleDate'), cell: (row) => formatDate(row.date), mobile: 'title' },
    { key: 'biomass', header: t('pasture.biomass'), cell: (row) => t('pasture.kgHa', { value: formatNumber(row.biomassKgHa, 0) }), align: 'right' },
    { key: 'ndvi', header: t('satellite.ndvi'), cell: (row) => formatNumber(row.ndvi, 2), align: 'right' },
    { key: 'notes', header: t('notes'), cell: (row) => row.notes ?? '—', mobile: 'hidden' },
  ];

  const addButton = canUpdate && (
    <Button variant="outline" onClick={() => setAdding(true)}>
      <Plus aria-hidden />
      {t('pasture.addSample')}
    </Button>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('pasture.title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('pasture.hint', { area: formatHa(areaHa) })}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <StatCard
            label={t('pasture.grazingDays')}
            value={pasture.grazingDays === null ? '—' : t('pasture.days', { value: formatNumber(pasture.grazingDays, 0) })}
            hint={t('pasture.forHead', { count: pasture.head })}
          />
          <StatCard label={t('pasture.biomass')} value={pasture.biomassKgHa === null ? '—' : t('pasture.kgHa', { value: formatNumber(pasture.biomassKgHa, 0) })} hint={pasture.date ? formatDate(pasture.date) : undefined} />
          <StatCard
            label={t('pasture.model')}
            value={pasture.model.calibrated ? t('pasture.calibrated') : t('pasture.estimate')}
            tone={pasture.model.calibrated ? 'success' : 'warning'}
            hint={pasture.model.calibrated ? t('pasture.fit', { n: pasture.model.samples, r2: formatNumber(pasture.model.r2, 2) }) : t('pasture.needSamples')}
          />
        </div>
        <Alert tone="info">
          {t('pasture.assumptions', {
            intake: formatNumber(pasture.intakeKgDmPerHeadDay, 1),
            share: formatPercent(pasture.utilisation * 100, 0),
          })}
        </Alert>
        {pasture.samples.length > 0 && <div className="flex justify-end empty:hidden">{addButton}</div>}
        <DataTableView<Sample>
          rows={pasture.samples}
          columns={columns}
          empty={{ icon: Scale, title: t('pasture.emptyTitle'), description: t('pasture.emptyBody'), action: addButton }}
          rowActions={(row) => [
            {
              label: t('common:actions.delete'),
              icon: Trash2,
              destructive: true,
              hidden: !canUpdate,
              onClick: async () => {
                const ok = await confirm({ title: t('pasture.deleteTitle'), description: t('pasture.deleteBody', { date: formatDate(row.date) }), destructive: true });
                if (ok) remove.mutate(row.id);
              },
            },
          ]}
        />
      </CardContent>
      <FormDialog
        open={adding}
        onOpenChange={setAdding}
        title={t('pasture.addSample')}
        description={t('pasture.howTo')}
        schema={sampleSchema}
        defaultValues={{ date: '', biomassKgHa: null, notes: '' } as never}
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage="common:toast.created"
      >
        {(form) => (
          <>
            <FormGrid>
              <DateField form={form} name="date" label={t('pasture.sampleDate')} required />
              <NumberField form={form} name="biomassKgHa" label={t('pasture.biomass')} suffix={t('pasture.kgHaShort')} maxDigits={0} required />
            </FormGrid>
            <TextField form={form} name="notes" label={t('notes')} />
          </>
        )}
      </FormDialog>
    </Card>
  );
}
