import { todayIso } from '@yap/shared';
import { CheckCheck, Plus, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { type Column, DataTable, DateField, FormDialog, FormField, FormGrid, NumberField, TextField, TextareaField, useUrlParam } from '@/components';
import { Badge, Button, Combobox, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { zOptionalDate, zOptionalNumber, zOptionalText } from '@/lib/forms';
import { useApiMutation } from '@/lib/query';
import { ANIMALS_PATH, HEALTH_PATH, animalOptions } from './options';
import type { QuarantineRow } from './types';

const PATH = `${HEALTH_PATH}/quarantine`;

const startSchema = z.object({
  animalIds: z.array(z.string()).min(1),
  startDate: zOptionalDate(),
  days: zOptionalNumber(),
  reason: zOptionalText(300),
  notes: zOptionalText(1000),
});

const endSchema = z.object({ date: zOptionalDate(), result: zOptionalText(300) });

interface StartResult {
  started: string[];
  until: string;
  skipped: { tag: string; reason: string }[];
}

function daysBadge(row: QuarantineRow, t: (key: string, options?: Record<string, unknown>) => string) {
  if (row.endedOn) return <Badge variant="success">{formatDate(row.endedOn)}</Badge>;
  if (row.daysLeft === null) return null;
  if (row.daysLeft < 0) return <Badge variant="danger">{t('quarantine.expired')}</Badge>;
  return <Badge variant={row.daysLeft <= 3 ? 'warning' : 'info'}>{t('quarantine.daysLeft', { count: row.daysLeft })}</Badge>;
}

export function QuarantineTab() {
  const { t } = useTranslation('vet');
  const canWrite = usePermission('health.update');

  const [state, setState] = useUrlParam('qState', 'active');
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState<QuarantineRow | null>(null);
  const [picked, setPicked] = useState<{ id: string; tag: string }[]>([]);

  const invalidate = [HEALTH_PATH, ANIMALS_PATH];
  const start = useApiMutation<z.output<typeof startSchema>, StartResult>({
    mutationFn: (values) => api.post(PATH, values),
    invalidate,
    silentError: true,
    onSuccess: (result) => {
      toast.success(t('quarantine.started', { count: result.started.length, date: formatDate(result.until) }));
      if (result.skipped.length) toast.warning(t('quarantine.skipped', { tags: result.skipped.map((s) => s.tag).join(', ') }));
      setPicked([]);
    },
  });
  const end = useApiMutation<z.output<typeof endSchema>>({
    mutationFn: (values) => api.post(`${PATH}/${ending!.id}/end`, values),
    invalidate,
    silentError: true,
  });

  const columns: Column<QuarantineRow>[] = [
    {
      key: 'tag',
      header: t('common.animal'),
      mobile: 'title',
      cell: (row) => (
        <Link className="font-medium text-primary hover:underline" to={`/livestock/animals/${row.animalId}`}>
          {row.tag}
        </Link>
      ),
    },
    { key: 'status', header: t('quarantine.remaining'), mobile: 'subtitle', cell: (row) => daysBadge(row, t) },
    { key: 'start', header: t('quarantine.start'), cell: (row) => formatDate(row.startDate) },
    { key: 'until', header: t('quarantine.until'), cell: (row) => formatDate(row.until) },
    { key: 'reason', header: t('quarantine.reason'), cell: (row) => row.reason ?? '—' },
    { key: 'herd', header: t('common.herd'), mobile: 'hidden', cell: (row) => row.herdName ?? '—' },
    { key: 'result', header: t('journal.result'), mobile: 'hidden', cell: (row) => row.result ?? '—' },
  ];

  return (
    <>
      <DataTable<QuarantineRow>
        path={PATH}
        urlPrefix="q"
        params={{ state }}
        columns={columns}
        searchable={false}
        filters={
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <Select
              aria-label={t('quarantine.stateFilter')}
              value={state}
              onChange={(e) => setState(e.target.value)}
              options={[
                { value: 'active', label: t('quarantine.active') },
                { value: 'ended', label: t('quarantine.ended') },
              ]}
              className="md:w-44"
            />
            {canWrite && (
              <Button onClick={() => setStarting(true)}>
                <Plus aria-hidden />
                {t('quarantine.add')}
              </Button>
            )}
          </div>
        }
        empty={{ icon: ShieldCheck, title: t('quarantine.emptyTitle'), description: t('quarantine.emptyBody') }}
        rowActions={(row) => [{ label: t('quarantine.end'), icon: CheckCheck, hidden: !canWrite || !!row.endedOn, onClick: () => setEnding(row) }]}
      />

      <FormDialog
        open={starting}
        onOpenChange={(open) => {
          setStarting(open);
          if (!open) setPicked([]);
        }}
        title={t('quarantine.add')}
        description={t('quarantine.addHint')}
        schema={startSchema}
        defaultValues={{ animalIds: [], startDate: todayIso(), days: null, reason: '', notes: '' }}
        onSubmit={(values) => start.mutateAsync(values)}
      >
        {(form) => (
          <>
            <FormField form={form} name="animalIds" label={t('quarantine.animals')} required>
              {(field) => (
                <div className="space-y-2">
                  <Combobox
                    id={field.id}
                    value={null}
                    placeholder={t('quarantine.addAnimal')}
                    loadOptions={animalOptions()}
                    onChange={(value, option) => {
                      if (!value || !option || picked.some((a) => a.id === value)) return;
                      const next = [...picked, { id: value, tag: option.label }];
                      setPicked(next);
                      field.onChange(next.map((a) => a.id));
                    }}
                  />
                  {picked.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5">
                      {picked.map((animal) => (
                        <li key={animal.id}>
                          <Badge variant="outline" className="gap-1 py-1 text-sm">
                            {animal.tag}
                            <button
                              type="button"
                              aria-label={t('common.removeTag', { tag: animal.tag })}
                              onClick={() => {
                                const next = picked.filter((a) => a.id !== animal.id);
                                setPicked(next);
                                field.onChange(next.map((a) => a.id));
                              }}
                            >
                              <X aria-hidden />
                            </button>
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </FormField>
            <FormGrid>
              <DateField form={form} name="startDate" label={t('quarantine.start')} max={todayIso()} />
              <NumberField form={form} name="days" label={t('quarantine.days')} hint={t('quarantine.daysHint')} suffix={t('common.days')} maxDigits={0} />
            </FormGrid>
            <TextField form={form} name="reason" label={t('quarantine.reason')} />
            <TextareaField form={form} name="notes" label={t('common.notes')} />
          </>
        )}
      </FormDialog>

      <FormDialog
        open={ending !== null}
        onOpenChange={(open) => !open && setEnding(null)}
        title={t('quarantine.endTitle', { tag: ending?.tag })}
        schema={endSchema}
        defaultValues={{ date: todayIso(), result: '' }}
        onSubmit={(values) => end.mutateAsync(values)}
        successMessage="common:toast.updated"
      >
        {(form) => (
          <>
            <DateField form={form} name="date" label={t('common.date')} max={todayIso()} />
            <TextField form={form} name="result" label={t('journal.result')} />
          </>
        )}
      </FormDialog>
    </>
  );
}
