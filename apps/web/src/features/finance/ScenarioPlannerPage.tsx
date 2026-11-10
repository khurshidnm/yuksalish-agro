/**
 * Three years ahead under stated assumptions: the flock, the profit, the cash and the price per
 * kilogram at which the farm breaks even.
 *
 * The page starts from the farm's own figures (`/finance/scenarios/baseline`) and leaves empty what
 * the farm has no record of. The app's starting values are offered apart and are never shown as the
 * farm's. The plan is worked out here in the browser by the shared formula, the same one the API
 * runs, so a slider answers at once.
 */
import { type ScenarioAssumptions, type ScenarioNumberKey, runScenario } from '@yap/shared/formulas/scenario';
import { RotateCcw, Save, SavePlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { ForbiddenPage, ModuleOffPage } from '@/app/pages';
import { ErrorCard, FormDialog, PageHeader, TextField, TextareaField, useConfirm } from '@/components';
import { Alert, Badge, Button, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan, useModuleEnabled } from '@/lib/auth';
import { zOptionalText, zText } from '@/lib/forms';
import { useApiMutation, useDetail, useList } from '@/lib/query';
import { CURRENT_PLAN, type ComparedPlan, CompareTable, SavedPlans } from './ScenarioCompare';
import { ScenarioInputs } from './ScenarioInputs';
import { ScenarioResults } from './ScenarioResults';
import {
  BASELINE_PATH,
  type Baseline,
  SCENARIOS_PATH,
  type SavedScenario,
  invalidFields,
  openSuggestions,
  readAssumptions,
  sameAssumptions,
  sliderAnchors,
  withSuggestions,
} from './scenarioPlan';

const nameSchema = z.object({ name: zText(120), notes: zOptionalText(1000) });
type NameValues = z.output<typeof nameSchema>;

type Naming = { mode: 'create' } | { mode: 'rename'; row: SavedScenario };

export default function ScenarioPlannerPage() {
  const can = useCan();
  const moduleEnabled = useModuleEnabled();
  // Totals and averages only, so an investor's summary right opens the page as finance.view does.
  // The route guard takes one permission, so this page asks for itself, as the guard would.
  if (!can('finance.view') && !can('finance.summary')) return <ForbiddenPage />;
  if (!moduleEnabled('finance')) return <ModuleOffPage />;
  return <Planner />;
}

function Planner() {
  const { t } = useTranslation('finance');
  const can = useCan();
  const confirm = useConfirm();
  const canCreate = can('finance.create');
  const canUpdate = can('finance.update');
  const canDelete = can('finance.delete');

  const baseline = useDetail<Baseline>(BASELINE_PATH);
  const saved = useList<SavedScenario>(SCENARIOS_PATH, { pageSize: 200, sort: 'name' });

  /** Null until the person changes something: the page then shows the farm's figures as they are. */
  const [plan, setPlan] = useState<ScenarioAssumptions | null>(null);
  /** The figures the sliders were scaled by: set when a plan is opened, never while a slider moves. */
  const [scaledBy, setScaledBy] = useState<ScenarioAssumptions | null>(null);
  const [typed, setTyped] = useState<Partial<Record<ScenarioNumberKey, number>>>({});
  const [loaded, setLoaded] = useState<SavedScenario | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [naming, setNaming] = useState<Naming | null>(null);

  const farm = baseline.data;
  const assumptions = plan ?? farm?.assumptions ?? null;
  const anchors = useMemo(() => (farm ? { ...sliderAnchors(scaledBy ?? farm.assumptions, farm), ...typed } : {}), [farm, scaledBy, typed]);
  const invalid = useMemo(() => (assumptions ? invalidFields(assumptions) : []), [assumptions]);
  const result = useMemo(() => (assumptions && invalid.length === 0 ? runScenario(assumptions) : null), [assumptions, invalid]);

  const open = (next: ScenarioAssumptions | null, from: SavedScenario | null) => {
    setPlan(next);
    setScaledBy(next);
    setTyped({});
    setLoaded(from);
  };

  const create = useApiMutation<NameValues, SavedScenario>({
    mutationFn: (values) => api.post<SavedScenario>(SCENARIOS_PATH, { ...values, assumptions }),
    invalidate: [SCENARIOS_PATH],
    silentError: true,
    onSuccess: (row) => setLoaded(row),
  });
  const rename = useApiMutation<NameValues & { id: string }, SavedScenario>({
    mutationFn: ({ id, ...values }) => api.patch<SavedScenario>(`${SCENARIOS_PATH}/${id}`, values),
    invalidate: [SCENARIOS_PATH],
    silentError: true,
    onSuccess: (row) => setLoaded((current) => (current?.id === row.id ? { ...current, name: row.name, notes: row.notes } : current)),
  });
  const overwrite = useApiMutation<string, SavedScenario>({
    mutationFn: (id) => api.patch<SavedScenario>(`${SCENARIOS_PATH}/${id}`, { assumptions }),
    invalidate: [SCENARIOS_PATH],
    successMessage: 'common:toast.saved',
    onSuccess: (row) => setLoaded(row),
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${SCENARIOS_PATH}/${id}`),
    invalidate: [SCENARIOS_PATH],
    successMessage: 'common:toast.deleted',
    onSuccess: (_, id) => {
      setLoaded((current) => (current?.id === id ? null : current));
      setCompare((ids) => ids.filter((x) => x !== id));
    },
  });

  const compared = useMemo<ComparedPlan[]>(() => {
    if (!farm || !assumptions) return [];
    return compare.flatMap((id) => {
      if (id === CURRENT_PLAN) return [{ id, name: t('scenarios.compare.current'), assumptions }];
      const row = saved.data?.data.find((s) => s.id === id);
      return row ? [{ id, name: row.name, assumptions: readAssumptions(row.assumptions, farm.startMonth) }] : [];
    });
  }, [compare, saved.data, assumptions, farm, t]);

  if (baseline.isError) {
    return (
      <>
        <PageHeader title={t('scenarios.title')} description={t('scenarios.description')} />
        <ErrorCard error={baseline.error} onRetry={() => void baseline.refetch()} />
      </>
    );
  }
  if (!farm || !assumptions) {
    return (
      <>
        <PageHeader title={t('scenarios.title')} description={t('scenarios.description')} />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      </>
    );
  }

  const changed = loaded !== null && !sameAssumptions(assumptions, readAssumptions(loaded.assumptions, farm.startMonth));
  const atFarmFigures = loaded === null && sameAssumptions(assumptions, farm.assumptions);
  const gaps = openSuggestions(assumptions, farm.suggestions);
  const blocked = invalid.length > 0;

  return (
    <>
      <PageHeader
        title={t('scenarios.title')}
        description={t('scenarios.description')}
        actions={
          <>
            <Button variant="outline" disabled={atFarmFigures} onClick={() => open(null, null)}>
              <RotateCcw aria-hidden />
              {t('scenarios.reset')}
            </Button>
            {loaded && canUpdate && (
              <Button variant="outline" disabled={!changed || blocked} loading={overwrite.isPending} onClick={() => overwrite.mutate(loaded.id)}>
                <Save aria-hidden />
                {t('scenarios.saveChanges')}
              </Button>
            )}
            {canCreate && (
              <Button
                disabled={blocked}
                onClick={() => {
                  // Held as the person saw them: the farm's figures are read again after a save.
                  setPlan(assumptions);
                  setNaming({ mode: 'create' });
                }}
              >
                <SavePlus aria-hidden />
                {t('scenarios.saveAs')}
              </Button>
            )}
          </>
        }
      />

      {loaded && (
        <p className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('scenarios.openPlan')}</span>
          <span className="min-w-0 font-medium break-words">{loaded.name}</span>
          {changed && <Badge variant="warning">{t('scenarios.changed')}</Badge>}
        </p>
      )}

      {gaps.length > 0 && (
        <Alert tone="info" title={t('scenarios.gaps.title', { n: gaps.length })} className="mb-4">
          <p>{t('scenarios.gaps.body')}</p>
          {/* The label is a sentence: on a phone it wraps instead of running off the card. */}
          <Button
            variant="outline"
            size="sm"
            className="mt-2 h-auto max-w-full py-2 text-left whitespace-normal"
            onClick={() => open(withSuggestions(assumptions, farm.suggestions), loaded)}
          >
            {t('scenarios.gaps.fill')}
          </Button>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-start">
        <ScenarioInputs
          value={assumptions}
          baseline={farm}
          anchors={anchors}
          onNumber={(key, value, wasTyped) => {
            setPlan({ ...assumptions, [key]: value });
            if (wasTyped && value) setTyped((current) => ({ ...current, [key]: Math.abs(value) }));
          }}
          onChange={(patch) => setPlan({ ...assumptions, ...patch })}
        />
        {result ? (
          <ScenarioResults result={result} assumptions={assumptions} />
        ) : (
          <Alert tone="warning" title={t('scenarios.invalid.title')}>
            {t('scenarios.invalid.body', { fields: invalid.map((key) => t(`scenarios.fields.${key}`)).join(', ') })}
          </Alert>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-4">
        <SavedPlans
          rows={saved.data?.data}
          loading={saved.isLoading}
          error={saved.isError ? saved.error : null}
          onRetry={() => void saved.refetch()}
          loadedId={loaded?.id ?? null}
          compare={compare}
          onCompare={setCompare}
          onLoad={(row) => {
            open(readAssumptions(row.assumptions, farm.startMonth), row);
            toast.success(t('scenarios.saved.loadedToast', { name: row.name }));
          }}
          onRename={canUpdate ? (row) => setNaming({ mode: 'rename', row }) : undefined}
          onDelete={
            canDelete
              ? async (row) => {
                  const ok = await confirm({
                    title: t('scenarios.saved.deleteTitle'),
                    description: t('scenarios.saved.deleteBody', { name: row.name }),
                    destructive: true,
                  });
                  if (ok) remove.mutate(row.id);
                }
              : undefined
          }
          canSave={canCreate}
        />
        {compared.length > 0 && <CompareTable plans={compared} />}
      </div>

      <FormDialog
        open={naming !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setNaming(null);
        }}
        title={naming?.mode === 'rename' ? t('scenarios.saved.renameTitle') : t('scenarios.saveAs')}
        description={naming?.mode === 'rename' ? undefined : t('scenarios.saveHint')}
        schema={nameSchema}
        defaultValues={naming?.mode === 'rename' ? { name: naming.row.name, notes: naming.row.notes ?? '' } : { name: '', notes: '' }}
        onSubmit={(values) => (naming?.mode === 'rename' ? rename.mutateAsync({ ...values, id: naming.row.id }) : create.mutateAsync(values))}
        successMessage={naming?.mode === 'rename' ? 'common:toast.updated' : 'common:toast.saved'}
      >
        {(form) => (
          <>
            <TextField form={form} name="name" label={t('scenarios.saved.name')} required autoFocus />
            <TextareaField form={form} name="notes" label={t('scenarios.saved.notes')} />
          </>
        )}
      </FormDialog>
    </>
  );
}
