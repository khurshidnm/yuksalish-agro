/**
 * Zones (docs/tracking.md): where a herd may graze and where it must not go. A zone follows a
 * field's boundary or is drawn on the map; a sheep over the line raises one alert for her herd.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { GEOFENCE_KINDS } from '@yap/shared';
import { NIGHT_RULES, ZONE_RULES } from '@yap/shared/formulas/tracking';
import type { Polygon } from 'geojson';
import { Fence, Pencil, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { EmptyState, ErrorCard, FormDialog, SelectField, TextField, useConfirm } from '@/components';
import { Alert, Badge, Button, Card, CardContent, Skeleton, Switch } from '@/components/ui';
import type { FarmMapData } from '@/features/farm/types';
import { api } from '@/lib/api';
import { useCan, useModuleEnabled } from '@/lib/auth';
import { zEnum, zOptionalRef, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { errorMessage, useApiMutation, useDetail } from '@/lib/query';
import { cn } from '@/lib/utils';
import { ZoneMap } from './ZoneMap';
import { LIVE, NIGHT_WATCH, ZONES, type LiveData, type ZoneKind, type ZoneRow } from './types';

const SOURCES = ['field', 'draw'] as const;

const detailsSchema = z.object({ name: zText(120), kind: zEnum(GEOFENCE_KINDS), herdId: zOptionalRef() });
const createSchema = detailsSchema.extend({ source: zEnum(SOURCES), fieldId: zOptionalRef() });
type CreateInput = z.input<typeof createSchema>;
type CreateValues = z.output<typeof createSchema>;
type Source = (typeof SOURCES)[number];

interface HerdOption {
  id: string;
  name: string;
}
interface FieldOption {
  id: string;
  name: string;
}

const KIND_TONE: Record<ZoneKind, 'success' | 'danger'> = { allowed: 'success', forbidden: 'danger' };

function useHerdOptions() {
  const herds = useDetail<HerdOption[]>('/livestock/herds/lookup');
  return useMemo(() => (herds.data ?? []).map((h) => ({ value: h.id, label: h.name })), [herds.data]);
}

/**
 * The new zone's details, with the map between the fields and the Save button: on a phone the
 * outline is drawn and saved without scrolling back up.
 */
function CreateForm({
  onChoice,
  drawn,
  onDone,
  onCancel,
  children,
}: {
  /** The map draws in the colour of the kind, and shows its drawing tools only when asked to. */
  onChoice: (choice: { kind: ZoneKind; source: Source }) => void;
  drawn: Polygon | null;
  onDone: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation('tracking');
  const herdOptions = useHerdOptions();
  const fields = useDetail<FieldOption[]>('/farm/fields/lookup');
  const fieldOptions = useMemo(() => (fields.data ?? []).map((f) => ({ value: f.id, label: f.name })), [fields.data]);
  const [problem, setProblem] = useState<string | null>(null);
  const form = useForm<CreateInput, unknown, CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: '', kind: 'allowed', herdId: null, source: 'field', fieldId: null },
  });
  const [kind, source] = useWatch({ control: form.control, name: ['kind', 'source'] });
  useEffect(() => {
    onChoice({ kind: kind === 'forbidden' ? 'forbidden' : 'allowed', source: source === 'draw' ? 'draw' : 'field' });
  }, [kind, source, onChoice]);
  const create = useApiMutation<Record<string, unknown>>({
    mutationFn: (body) => api.post(ZONES, body),
    invalidate: [ZONES, LIVE],
    successMessage: 'tracking:zones.toast.created',
    silentError: true,
  });

  const submit = form.handleSubmit(async ({ source: from, fieldId, ...details }) => {
    setProblem(null);
    if (from === 'field' && !fieldId) return form.setError('fieldId', { type: 'required', message: t('common:validation.required') });
    if (from === 'draw' && !drawn) return setProblem(t('zones.draw.needed'));
    try {
      await create.mutateAsync({ ...details, ...(from === 'field' ? { fieldId } : { geometry: drawn }) });
      onDone();
    } catch (error) {
      setProblem(errorMessage(error));
    }
  });

  return (
    <Card>
      <CardContent className="p-4">
        <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
          <h2 className="text-base font-semibold">{t('zones.addTitle')}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField form={form} name="name" label={t('zones.fields.name')} required autoComplete="off" maxLength={120} />
            <SelectField form={form} name="kind" label={t('zones.fields.kind')} required options={enumOptions('geofenceKind', GEOFENCE_KINDS)} />
            <SelectField form={form} name="herdId" label={t('zones.fields.herd')} placeholder={t('zones.everyHerd')} options={herdOptions} />
            <SelectField
              form={form}
              name="source"
              label={t('zones.fields.source')}
              required
              options={SOURCES.map((value) => ({ value, label: t(`zones.source.${value}`) }))}
            />
            {source === 'field' && <SelectField form={form} name="fieldId" label={t('zones.fields.field')} required options={fieldOptions} />}
          </div>
          {children}
          {problem && <Alert tone="danger">{problem}</Alert>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              {t('common:actions.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              {t('common:actions.save')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ZoneCard({ zone, canChange, canDelete, onEdit }: { zone: ZoneRow; canChange: boolean; canDelete: boolean; onEdit: () => void }) {
  const { t } = useTranslation('tracking');
  const confirm = useConfirm();
  const toggle = useApiMutation<boolean>({
    mutationFn: (active) => api.patch(`${ZONES}/${zone.id}`, { active }),
    invalidate: [ZONES, LIVE],
    onSuccess: (_result, active) => toast.success(t(active ? 'zones.toast.on' : 'zones.toast.off')),
  });
  const remove = useApiMutation({
    mutationFn: () => api.delete(`${ZONES}/${zone.id}`),
    invalidate: [ZONES, LIVE],
    successMessage: 'tracking:zones.toast.removed',
  });
  const field = [zone.fieldNumber, zone.fieldName].filter(Boolean).join(' · ');

  return (
    <Card className={cn(!zone.active && 'border-dashed')}>
      <CardContent className="space-y-3 p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-semibold break-words">{zone.name}</p>
            <p className="text-sm text-muted-foreground">{zone.herdName ?? t('zones.everyHerd')}</p>
            <p className="text-sm text-muted-foreground">{zone.fieldId ? t('zones.ofField', { field }) : t('zones.drawn')}</p>
          </div>
          <Badge variant={KIND_TONE[zone.kind]} className="shrink-0">
            {t(`enums:geofenceKind.${zone.kind}`)}
          </Badge>
        </div>
        {zone.geometry === null && <Alert tone="warning">{t('zones.noOutline')}</Alert>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {canChange ? (
            <div className="flex min-h-11 items-center gap-3 text-sm">
              <Switch checked={zone.active} disabled={toggle.isPending} onCheckedChange={(active) => toggle.mutate(active)} aria-label={t('zones.switch', { name: zone.name })} />
              <span aria-hidden>{t(zone.active ? 'zones.on' : 'zones.off')}</span>
            </div>
          ) : (
            <Badge variant={zone.active ? 'success' : 'neutral'}>{t(zone.active ? 'zones.on' : 'zones.off')}</Badge>
          )}
          <div className="flex gap-2">
            {canChange && (
              <Button variant="outline" size="sm" onClick={onEdit}>
                <Pencil aria-hidden />
                {t('zones.edit')}
              </Button>
            )}
            {canDelete && (
              <Button
                variant="outline"
                size="icon"
                aria-label={t('zones.deleteTitle', { name: zone.name })}
                loading={remove.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: t('zones.deleteTitle', { name: zone.name }),
                    description: t('zones.deleteBody'),
                    confirmLabel: t('common:actions.delete'),
                    destructive: true,
                  });
                  if (ok) remove.mutate();
                }}
              >
                <Trash2 aria-hidden />
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ZoneLegend() {
  const { t } = useTranslation('tracking');
  const item = (swatch: string, label: string) => (
    <li className="flex items-center gap-1.5">
      <span className={cn('inline-block h-3 w-5 rounded-sm border-2', swatch)} aria-hidden />
      {label}
    </li>
  );
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label={t('zones.legend.title')}>
      {item('border-accent bg-accent/10', t('zones.legend.allowed'))}
      {item('border-destructive bg-destructive/25', t('zones.legend.forbidden'))}
      {item('border-dashed border-muted-foreground', t('zones.legend.off'))}
    </ul>
  );
}

/**
 * The night rule and its switch. Everyone who sees the flock map reads whether it is on; only those
 * who change the workspace policy may switch it, because it silences an urgent alert.
 */
function NightWatchCard() {
  const { t } = useTranslation('tracking');
  const canSwitch = useCan()('settings.update');
  const watch = useDetail<{ enabled: boolean }>(NIGHT_WATCH);
  const save = useApiMutation<boolean>({
    mutationFn: (nightWatch) => api.patch('/settings/policy', { tracking: { nightWatch } }),
    invalidate: [NIGHT_WATCH],
    onSuccess: (_result, on) => toast.success(t(on ? 'zones.night.toast.on' : 'zones.night.toast.off')),
  });
  if (watch.isError) return <ErrorCard error={watch.error} onRetry={() => void watch.refetch()} />;
  if (!watch.data) return <Skeleton className="h-28 w-full" />;
  const on = watch.data.enabled;

  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{t('zones.night.title')}</h2>
          {canSwitch ? (
            <div className="flex min-h-11 items-center gap-3 text-sm">
              <Switch checked={on} disabled={save.isPending} onCheckedChange={(next) => save.mutate(next)} aria-label={t('zones.night.switch')} />
              <span aria-hidden>{t(on ? 'zones.on' : 'zones.off')}</span>
            </div>
          ) : (
            <Badge variant={on ? 'success' : 'neutral'}>{t(on ? 'zones.on' : 'zones.off')}</Badge>
          )}
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t('zones.night.rule', {
            from: NIGHT_RULES.fromHour,
            to: NIGHT_RULES.toHour,
            move: NIGHT_RULES.maxMoveM,
            hours: NIGHT_RULES.windowMs / 3_600_000,
            speed: NIGHT_RULES.maxSpeedKmh,
          })}
        </p>
        {canSwitch && <p className="max-w-2xl text-sm text-muted-foreground">{t('zones.night.hint')}</p>}
      </CardContent>
    </Card>
  );
}

export function ZonesTab() {
  const { t } = useTranslation('tracking');
  const can = useCan();
  const moduleEnabled = useModuleEnabled();
  const canChange = can('livestock.update');
  const canDelete = can('livestock.delete');
  const zones = useDetail<ZoneRow[]>(ZONES);
  // Shepherds and vets have no farm.view: they get the imagery without field outlines.
  const farm = useDetail<FarmMapData>(can('farm.view') && moduleEnabled('farm') ? '/farm/map' : null);
  const live = useDetail<LiveData>(LIVE);
  const herdOptions = useHerdOptions();
  const [adding, setAdding] = useState(false);
  const [choice, setChoice] = useState<{ kind: ZoneKind; source: Source }>({ kind: 'allowed', source: 'field' });
  const [drawn, setDrawn] = useState<Polygon | null>(null);
  const [editing, setEditing] = useState<ZoneRow | null>(null);

  const outlines = useMemo(() => farm.data?.features.map((f) => f.geometry), [farm.data]);
  const herds = useMemo(() => (live.data?.herds ?? []).flatMap((h) => (h.centre ? [{ id: h.id, name: h.name, ...h.centre }] : [])), [live.data]);
  const rows = zones.data;
  const mapZones = useMemo(() => rows ?? [], [rows]);
  const draft = useMemo(
    () => (adding && choice.source === 'draw' ? { kind: choice.kind, value: drawn, onChange: setDrawn } : null),
    [adding, choice, drawn],
  );

  const update = useApiMutation<{ id: string; body: z.output<typeof detailsSchema> }>({
    mutationFn: ({ id, body }) => api.patch(`${ZONES}/${id}`, body),
    invalidate: [ZONES, LIVE],
    silentError: true,
  });

  if (!rows) {
    return zones.isError ? (
      <ErrorCard error={zones.error} onRetry={() => void zones.refetch()} />
    ) : (
      <div className="space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-[50dvh] min-h-72 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  const open = () => {
    setChoice({ kind: 'allowed', source: 'field' });
    setDrawn(null);
    setAdding(true);
  };
  const close = () => {
    setAdding(false);
    setDrawn(null);
  };
  const addButton = canChange && !adding && (
    <Button onClick={open}>
      <Plus aria-hidden />
      {t('zones.add')}
    </Button>
  );

  const zoneMap = (
    <div className="space-y-2">
      <ZoneMap zones={mapZones} outlines={outlines} herds={herds} draft={draft} className="h-[50dvh] min-h-72 w-full overflow-hidden rounded-lg border border-border" />
      <ZoneLegend />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl space-y-1 text-sm text-muted-foreground">
          <p>{t('zones.intro')}</p>
          <p>{t('zones.rule', { fixes: ZONE_RULES.exitFixes, buffer: ZONE_RULES.bufferM, twice: 2 * ZONE_RULES.bufferM })}</p>
        </div>
        {rows.length > 0 && addButton}
      </div>

      {adding ? (
        <CreateForm onChoice={setChoice} drawn={drawn} onDone={close} onCancel={close}>
          {zoneMap}
        </CreateForm>
      ) : (
        rows.length > 0 && zoneMap
      )}

      {rows.length === 0 ? (
        !adding && <EmptyState icon={Fence} title={t('zones.emptyTitle')} description={t('zones.emptyDescription')} action={addButton || undefined} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((zone) => (
              <ZoneCard key={zone.id} zone={zone} canChange={canChange} canDelete={canDelete} onEdit={() => setEditing(zone)} />
            ))}
          </div>
        </>
      )}

      <NightWatchCard />

      <FormDialog
        open={editing !== null}
        onOpenChange={(next) => !next && setEditing(null)}
        title={t('zones.editTitle')}
        schema={detailsSchema}
        defaultValues={{ name: editing?.name ?? '', kind: editing?.kind ?? 'allowed', herdId: editing?.herdId ?? null }}
        successMessage="tracking:zones.toast.updated"
        onSubmit={(body) => update.mutateAsync({ id: editing!.id, body })}
      >
        {(form) => (
          <>
            <TextField form={form} name="name" label={t('zones.fields.name')} required autoComplete="off" maxLength={120} />
            <SelectField form={form} name="kind" label={t('zones.fields.kind')} required options={enumOptions('geofenceKind', GEOFENCE_KINDS)} />
            <SelectField form={form} name="herdId" label={t('zones.fields.herd')} placeholder={t('zones.everyHerd')} options={herdOptions} />
          </>
        )}
      </FormDialog>
    </div>
  );
}
