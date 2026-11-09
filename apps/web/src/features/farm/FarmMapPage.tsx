import { LAND_USES } from '@yap/shared';
import type { Geometry, Point } from 'geojson';
import { Check, ExternalLink, LayoutList, MapPin, Pencil, Plus, Shapes, Undo2, X } from 'lucide-react';
import { type Ref, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ErrorCard, PageHeader, useUrlParam } from '@/components';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Select,
  Skeleton,
} from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { useApiMutation, useDetail } from '@/lib/query';
import { cn } from '@/lib/utils';
import { AssistantBar } from '@/features/ai/AssistantBar';
import { FACILITY_PATHS, FacilityFormDialog } from './FacilityFormDialog';
import { FIELD_PATHS, FieldFormDialog, type SavedField, warnAboutOverlaps } from './FieldFormDialog';
import { FieldPhoto } from './FieldPhoto';
import { outerRings } from './geometry';
import { HealthLegend } from './satellite/HealthLegend';
import type { LatestReading, VegetationGrid } from './satellite/types';
import { type BaseLayer, type ColorBy, CROP_SLOT, type DrawShape, type DrawnShape, FarmMapCanvas, type FarmMapHandle, LAND_USE_SLOT, slotToken } from './map/FarmMapCanvas';
import type { FarmMapData, FieldProps, I18nName, MapFeature, MapProps, UnmappedField } from './types';
import { CROP_STATUS_VARIANT, fieldTitle, formatCapacity, formatHa, useLocalName } from './utils';

/** What the map is doing. Each drawing target decides where the finished shape goes. */
type Mode =
  | { kind: 'view' }
  | { kind: 'draw'; target: 'field' | 'facility' | 'point'; existing?: UnmappedField }
  | { kind: 'edit'; feature: MapProps };

function Legend({ data, colorBy }: { data: FarmMapData | undefined; colorBy: ColorBy }) {
  const { t } = useTranslation('farm');
  const localName = useLocalName();

  const entries = useMemo(() => {
    if (colorBy === 'landUse' || colorBy === 'health') {
      return LAND_USES.map((use) => ({ key: use, label: t(`enums:landUse.${use}`), slot: LAND_USE_SLOT[use] }));
    }
    const crops = new Map<string, I18nName>();
    for (const feature of data?.features ?? []) {
      const p = feature.properties;
      if (p.kind === 'field' && p.cropKey && p.cropName) crops.set(p.cropKey, p.cropName);
    }
    return [
      ...[...crops].map(([key, name]) => ({ key, label: localName(name), slot: CROP_SLOT[key] })),
      { key: 'none', label: t('map.noCrop'), slot: undefined },
    ];
  }, [colorBy, data, localName, t]);

  if (colorBy === 'health') return <HealthLegend className="max-w-md" />;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label={t('map.legend')}>
      {entries.map((entry) => (
        <li key={entry.key} className="flex items-center gap-1.5">
          <span className="size-3 shrink-0 rounded-sm" style={{ background: `var(${slotToken(entry.slot)})` }} aria-hidden />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

/** Every field as a floating card along the map's bottom edge. Tapping one flies the map to it. */
function FieldStrip({ fields, onPick }: { fields: MapFeature[]; onPick: (feature: MapFeature) => void }) {
  const { t } = useTranslation('farm');
  const localName = useLocalName();
  return (
    <ul aria-label={t('map.fieldCards')} data-testid="field-strip" className="pointer-events-auto flex snap-x gap-2 overflow-x-auto pb-1 [scrollbar-width:none] max-md:mr-16 [&::-webkit-scrollbar]:hidden">
      {fields.map((feature) => {
        const field = feature.properties as FieldProps;
        return (
          <li key={feature.id} className="w-60 shrink-0 snap-start">
            <button
              type="button"
              onClick={() => onPick(feature)}
              className="focus-ring block w-full rounded-xl bg-popover p-2.5 text-left text-popover-foreground shadow-pop transition-colors hover:bg-muted"
            >
              <span className="block truncate px-0.5 text-sm font-semibold text-heading">{fieldTitle(field)}</span>
              <span className="mt-1.5 flex items-center gap-3">
                <FieldPhoto geometry={feature.geometry} width={176} aspect={1.25} className="w-20 shrink-0 rounded-lg" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={cn('size-2 shrink-0 rounded-full', field.cropName ? 'bg-accent' : 'bg-input')} aria-hidden />
                    <span className="truncate">{field.cropName ? localName(field.cropName) : t(`enums:landUse.${field.landUse}`)}</span>
                  </span>
                  <span className="mt-0.5 block text-xl leading-tight font-medium tracking-tight">{formatHa(field.areaHa, 1)}</span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** How far a floating panel hides the map's left or bottom edge: whichever leaves more of the map in view. */
function coveredBy(map: HTMLElement | null, panel: HTMLElement | null): { left: number; bottom: number } {
  if (!map || !panel) return { left: 0, bottom: 0 };
  const m = map.getBoundingClientRect();
  const p = panel.getBoundingClientRect();
  if (p.left >= m.right || p.right <= m.left || p.top >= m.bottom || p.bottom <= m.top) return { left: 0, bottom: 0 };
  const bottom = m.bottom - p.top;
  const left = p.right - m.left;
  return (m.height - bottom) * m.width >= (m.width - left) * m.height ? { left: 0, bottom } : { left, bottom: 0 };
}

function SelectedPanel({
  feature,
  geometry,
  canEdit,
  onEdit,
  onClose,
  ref,
}: {
  feature: MapProps;
  geometry?: Geometry;
  canEdit: boolean;
  onEdit: () => void;
  onClose: () => void;
  ref?: Ref<HTMLDivElement>;
}) {
  const { t } = useTranslation('farm');
  const localName = useLocalName();
  const isField = feature.kind === 'field';

  return (
    <Card ref={ref} className="pointer-events-auto w-full overflow-hidden bg-popover shadow-pop md:w-80">
      {/* Below lg the panel floats over the map, which already shows the field: the photo would only hide it. */}
      {outerRings(geometry).length > 0 && <FieldPhoto geometry={geometry} width={640} aspect={2.4} className="hidden lg:block" />}
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold break-words">{isField ? fieldTitle(feature) : feature.name}</p>
            <p className="text-sm text-muted-foreground">
              {isField ? t(`enums:landUse.${feature.landUse}`) : t(`enums:facilityType.${feature.facilityType}`)}
              {feature.areaHa != null && ` · ${formatHa(feature.areaHa)}`}
            </p>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label={t('common:actions.close')} onClick={onClose}>
            <X aria-hidden />
          </Button>
        </div>
        {isField && feature.cropName && (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            {localName(feature.cropName)}
            {feature.cropStatus && <Badge variant={CROP_STATUS_VARIANT[feature.cropStatus]}>{t(`enums:cropPlanStatus.${feature.cropStatus}`)}</Badge>}
          </p>
        )}
        {!isField && feature.capacity != null && (
          <p className="mt-1 text-sm">{formatCapacity(feature.capacity, feature.capacityUnit)}</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to={isField ? `/farm/fields/${feature.id}` : '/farm/facilities'}>
              <ExternalLink aria-hidden />
              {isField ? t('map.openCard') : t('map.openFacilities')}
            </Link>
          </Button>
          {canEdit && (
            <Button variant="outline" size="sm" onClick={onEdit}>
              <Pencil aria-hidden />
              {t('map.editOutline')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function FarmMapPage() {
  const { t } = useTranslation('farm');
  const canCreate = usePermission('farm.create');
  const canUpdate = usePermission('farm.update');
  const query = useDetail<FarmMapData>('/farm/map');
  const canSetLocation = usePermission('settings.update');

  const [baseLayer, setBaseLayer] = useUrlParam('base', 'satellite');
  const [colorBy, setColorBy] = useUrlParam('color', 'landUse');
  const [focus, setFocus] = useUrlParam('focus');
  const health = useDetail<LatestReading[]>(colorBy === 'health' ? '/farm/satellite/latest' : null);
  const healthGrids = useMemo(
    () => (colorBy === 'health' ? (health.data ?? []).map((r) => r.grid).filter((g): g is VegetationGrid => g !== null) : undefined),
    [colorBy, health.data],
  );

  const canvas = useRef<FarmMapHandle>(null);
  const mapArea = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  /** A feature to fly to once its panel is on screen, so the view leaves out what the panel covers. */
  const [flyTo, setFlyTo] = useState<string | null>(null);
  const [canDraw, setCanDraw] = useState(false);
  const [toolsFailed, setToolsFailed] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const [selected, setSelected] = useState<MapProps | null>(null);
  const [liveArea, setLiveArea] = useState<number | null>(null);
  const [drawnField, setDrawnField] = useState<DrawnShape | null>(null);
  const [drawnFacility, setDrawnFacility] = useState<{ boundary?: Geometry; point?: { lat: number; lng: number } } | null>(null);

  const announceArea = (saved: { areaHa: number | null }) => {
    toast.success(saved.areaHa != null ? t('map.savedArea', { area: formatHa(saved.areaHa, 4) }) : t('common:toast.saved'));
  };

  const saveOutline = useApiMutation<{ path: string; boundary: Geometry }, { areaHa: number | null; overlaps?: SavedField['overlaps'] }>({
    mutationFn: ({ path, boundary }) => api.patch(path, { boundary }),
    invalidate: [...FIELD_PATHS, ...FACILITY_PATHS],
    onSuccess: (saved) => {
      announceArea(saved);
      if (saved.overlaps) warnAboutOverlaps({ overlaps: saved.overlaps });
    },
  });

  // Opened with ?focus=<id>, for example from a field card.
  useEffect(() => {
    if (!focus || !query.data || !canDraw) return;
    const feature = query.data.features.find((f) => f.id === focus);
    if (!feature) return;
    setSelected(feature.properties);
    setFlyTo(focus);
    setFocus('');
  }, [focus, query.data, canDraw, setFocus]);

  useEffect(() => {
    if (!flyTo) return;
    canvas.current?.focus(flyTo, coveredBy(mapArea.current, panel.current));
    setFlyTo(null);
  }, [flyTo]);

  /** On a phone the map can be mostly below the fold when a tool starts. */
  const bringMapIntoView = () => mapArea.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });

  const startDraw = (target: 'field' | 'facility' | 'point', existing?: UnmappedField) => {
    bringMapIntoView();
    setSelected(null);
    setLiveArea(null);
    setMode({ kind: 'draw', target, existing });
    canvas.current?.startDraw((target === 'point' ? 'CircleMarker' : 'Polygon') satisfies DrawShape);
  };

  const onDrawn = (shape: DrawnShape) => {
    const current = mode;
    setLiveArea(null);
    setMode({ kind: 'view' });
    if (current.kind !== 'draw') return;

    if (current.existing) {
      canvas.current?.clearDrawn();
      saveOutline.mutate({ path: `/farm/fields/${current.existing.id}`, boundary: shape.geometry });
    } else if (current.target === 'field') {
      setDrawnField(shape);
    } else if (current.target === 'point') {
      const [lng, lat] = (shape.geometry as Point).coordinates;
      setDrawnFacility({ point: { lat, lng } });
    } else {
      setDrawnFacility({ boundary: shape.geometry });
    }
  };

  const startEdit = (feature: MapProps) => {
    if (canvas.current?.startEdit(feature.id)) {
      bringMapIntoView();
      setSelected(null);
      setMode({ kind: 'edit', feature });
    }
  };

  const stopEdit = () => {
    canvas.current?.stopEdit();
    setMode({ kind: 'view' });
  };

  const commitEdit = () => {
    if (mode.kind !== 'edit') return;
    const boundary = canvas.current?.editedGeometry();
    if (!boundary) return;
    const path = mode.feature.kind === 'field' ? `/farm/fields/${mode.feature.id}` : `/farm/facilities/${mode.feature.id}`;
    saveOutline.mutate({ path, boundary }, { onSettled: stopEdit });
  };

  const unmapped = query.data?.unmappedFields ?? [];
  const busy = mode.kind !== 'view';
  const fields = useMemo(
    () => (query.data?.features ?? []).filter((feature) => feature.properties.kind === 'field').sort((a, b) => (b.properties.areaHa ?? 0) - (a.properties.areaHa ?? 0)),
    [query.data],
  );
  const pickField = (feature: MapFeature) => {
    setSelected(feature.properties);
    setFlyTo(feature.id);
  };
  const selectedEditable = selected !== null && canDraw && canUpdate && (selected.kind === 'field' || selected.areaHa != null);

  const noLocation = query.data && !query.data.center && query.data.features.length === 0;

  return (
    <>
      {noLocation && (
        <Alert tone="info" className="mb-3">
          <p>{t('map.noLocation')}</p>
          {canSetLocation && (
            <Link to="/settings" className="focus-ring inline-flex min-h-11 items-center font-semibold underline">
              {t('map.noLocationLink')}
            </Link>
          )}
        </Alert>
      )}
      <PageHeader
        title={t('map.title')}
        description={<span className="hidden md:inline">{t('map.description')}</span>}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/farm/fields">
                <LayoutList aria-hidden />
                {t('map.fieldList')}
              </Link>
            </Button>
            {canCreate && canDraw && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button disabled={busy}>
                    <Plus aria-hidden />
                    {t('map.add')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => startDraw('field')}>
                    <Shapes aria-hidden />
                    {t('map.drawField')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => startDraw('facility')}>
                    <Shapes aria-hidden />
                    {t('map.drawFacility')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => startDraw('point')}>
                    <MapPin aria-hidden />
                    {t('map.placePoint')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />

      {query.error ? (
        <ErrorCard error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {toolsFailed && <Alert tone="warning">{t('map.toolsFailed')}</Alert>}
          {colorBy === 'health' && health.data?.length === 0 && <Alert tone="info">{t('map.healthEmpty')}</Alert>}

          <Card className="overflow-hidden">
            {/* One select a row on a phone, where two side by side cut their labels short. */}
            <div className="grid grid-cols-1 gap-2 border-b border-border p-2 sm:grid-cols-2 md:flex md:flex-wrap md:items-center">
              <Select
                aria-label={t('map.baseLayer')}
                value={baseLayer}
                onChange={(e) => setBaseLayer(e.target.value)}
                options={[
                  { value: 'satellite', label: t('map.satellite') },
                  { value: 'streets', label: t('map.streets') },
                ]}
                className="md:w-44"
              />
              <Select
                aria-label={t('map.colorBy')}
                value={colorBy}
                onChange={(e) => setColorBy(e.target.value)}
                options={[
                  { value: 'landUse', label: t('map.colorLandUse') },
                  { value: 'crop', label: t('map.colorCrop') },
                  { value: 'health', label: t('map.colorHealth') },
                ]}
                className="md:w-56"
              />
              <div className="hidden min-w-0 md:ml-1 md:block md:flex-1 md:basis-64">
                <Legend data={query.data} colorBy={colorBy as ColorBy} />
              </div>
            </div>

            <div ref={mapArea} className="relative scroll-mt-16">
              {/* `isolate` keeps Leaflet's z-indexes below dialogs and the app bar. */}
              <div className="relative isolate">
                {query.isPending && <Skeleton className="absolute inset-0 z-10 rounded-none" />}
                <FarmMapCanvas
                  ref={canvas}
                  data={query.data}
                  baseLayer={baseLayer as BaseLayer}
                  colorBy={colorBy as ColorBy}
                  overlays={healthGrids}
                  selectedId={mode.kind === 'edit' ? mode.feature.id : (selected?.id ?? null)}
                  className="h-[calc(100dvh-20rem)] min-h-96 w-full"
                  fitBottom={window.innerWidth >= 768 ? 220 : 110}
                  onSelect={setSelected}
                  onDrawn={onDrawn}
                  onLiveArea={setLiveArea}
                  onReady={(ok) => {
                    setCanDraw(ok);
                    setToolsFailed(!ok);
                  }}
                />
              </div>

              {/* On phones this floats above the bottom nav, so Finish is reachable however far the page has scrolled. */}
              {!selected && !busy && (
                <div className="pointer-events-none absolute inset-x-2 bottom-6 z-10 flex flex-col gap-2">
                  {fields.length > 0 && <FieldStrip fields={fields} onPick={pickField} />}
                  <div className="pointer-events-auto hidden md:block md:max-w-xl">
                    <AssistantBar compact className="shadow-pop" />
                  </div>
                </div>
              )}

              <div className="pointer-events-none fixed inset-x-2 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-40 flex flex-col items-start gap-2 lg:absolute lg:bottom-6 lg:z-10">
                {selected && !busy && (
                  <SelectedPanel
                    ref={panel}
                    feature={selected}
                    geometry={query.data?.features.find((feature) => feature.id === selected.id)?.geometry}
                    canEdit={selectedEditable}
                    onEdit={() => startEdit(selected)}
                    onClose={() => setSelected(null)}
                  />
                )}

                {busy && (
                  <Card className="pointer-events-auto w-full p-3 shadow-pop md:w-[26rem]">
                    <p className="text-sm font-medium">
                      {mode.kind === 'edit'
                        ? t('map.editHint')
                        : mode.target === 'point'
                          ? t('map.pointHint')
                          : t('map.drawHint', { name: mode.existing ? fieldTitle(mode.existing) : t('map.newContour') })}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <p className="min-w-0 flex-1 text-lg font-semibold whitespace-nowrap tabular-nums md:text-xl" aria-live="polite">
                        {/* A live figure is an estimate on a sphere; until a point moves, an outline keeps its saved area. */}
                        {mode.kind === 'draw' && mode.target === 'point'
                          ? null
                          : liveArea !== null
                            ? t('map.approxArea', { area: formatHa(liveArea) })
                            : mode.kind === 'edit'
                              ? formatHa(mode.feature.areaHa)
                              : '—'}
                      </p>
                      {mode.kind === 'draw' && mode.target !== 'point' && (
                        <Button variant="outline" size="icon" aria-label={t('map.undoPoint')} title={t('map.undoPoint')} onClick={() => canvas.current?.undoPoint()}>
                          <Undo2 aria-hidden />
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={t('common:actions.cancel')}
                        title={t('common:actions.cancel')}
                        onClick={() => {
                          if (mode.kind === 'edit') stopEdit();
                          else {
                            canvas.current?.cancelDraw();
                            setMode({ kind: 'view' });
                          }
                        }}
                      >
                        <X aria-hidden />
                      </Button>
                      {mode.kind === 'edit' && (
                        <Button onClick={commitEdit} loading={saveOutline.isPending}>
                          <Check aria-hidden />
                          {t('common:actions.save')}
                        </Button>
                      )}
                      {mode.kind === 'draw' && mode.target !== 'point' && (
                        <Button onClick={() => canvas.current?.finishDraw()}>
                          <Check aria-hidden />
                          {t('map.finish')}
                        </Button>
                      )}
                    </div>
                  </Card>
                )}
              </div>
            </div>

            <div className="border-t border-border p-2 md:hidden">
              <Legend data={query.data} colorBy={colorBy as ColorBy} />
            </div>
          </Card>

          {unmapped.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>{t('map.unmappedTitle')}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col divide-y divide-border">
                  {unmapped.map((field) => (
                    <li key={field.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="min-w-0">
                        <span className="font-medium">{fieldTitle(field)}</span>
                        <span className="ml-2 text-sm text-muted-foreground">
                          {t(`enums:landUse.${field.landUse}`)} · {formatHa(field.areaHa)}
                        </span>
                      </span>
                      {canUpdate && canDraw && (
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => startDraw('field', field)}>
                          <Pencil aria-hidden />
                          {t('map.draw')}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <FieldFormDialog
        open={drawnField !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDrawnField(null);
            canvas.current?.clearDrawn();
          }
        }}
        boundary={drawnField?.geometry}
        previewAreaHa={drawnField?.areaHa}
        onSaved={(saved: SavedField) => announceArea(saved)}
      />

      <FacilityFormDialog
        open={drawnFacility !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDrawnFacility(null);
            canvas.current?.clearDrawn();
          }
        }}
        boundary={drawnFacility?.boundary}
        point={drawnFacility?.point}
      />
    </>
  );
}
