import { LAND_USES } from '@yap/shared';
import type { Geometry, Point } from 'geojson';
import { Check, ExternalLink, LayoutList, MapPin, Pencil, Plus, Shapes, Undo2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { FACILITY_PATHS, FacilityFormDialog } from './FacilityFormDialog';
import { FIELD_PATHS, FieldFormDialog, type SavedField, warnAboutOverlaps } from './FieldFormDialog';
import { type BaseLayer, type ColorBy, CROP_SLOT, type DrawShape, type DrawnShape, FarmMapCanvas, type FarmMapHandle, LAND_USE_SLOT, slotToken } from './map/FarmMapCanvas';
import type { FarmMapData, I18nName, MapProps, UnmappedField } from './types';
import { fieldTitle, formatHa, useLocalName } from './utils';

/** What the map is doing. Each drawing target decides where the finished shape goes. */
type Mode =
  | { kind: 'view' }
  | { kind: 'draw'; target: 'field' | 'facility' | 'point'; existing?: UnmappedField }
  | { kind: 'edit'; feature: MapProps };

function Legend({ data, colorBy }: { data: FarmMapData | undefined; colorBy: ColorBy }) {
  const { t } = useTranslation('farm');
  const localName = useLocalName();

  const entries = useMemo(() => {
    if (colorBy === 'landUse') {
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

function SelectedPanel({ feature, canEdit, onEdit, onClose }: { feature: MapProps; canEdit: boolean; onEdit: () => void; onClose: () => void }) {
  const { t } = useTranslation('farm');
  const localName = useLocalName();
  const isField = feature.kind === 'field';

  return (
    <Card className="pointer-events-auto w-full p-3 shadow-pop md:w-80">
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
          {feature.cropStatus && <Badge variant="success">{t(`enums:cropPlanStatus.${feature.cropStatus}`)}</Badge>}
        </p>
      )}
      {!isField && feature.capacity != null && (
        <p className="mt-1 text-sm">{t('facilities.capacityValue', { value: feature.capacity, unit: feature.capacityUnit ?? '' })}</p>
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
    </Card>
  );
}

export default function FarmMapPage() {
  const { t } = useTranslation('farm');
  const canCreate = usePermission('farm.create');
  const canUpdate = usePermission('farm.update');
  const query = useDetail<FarmMapData>('/farm/map');

  const [baseLayer, setBaseLayer] = useUrlParam('base', 'satellite');
  const [colorBy, setColorBy] = useUrlParam('color', 'landUse');
  const [focus, setFocus] = useUrlParam('focus');

  const canvas = useRef<FarmMapHandle>(null);
  const mapArea = useRef<HTMLDivElement>(null);
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
    canvas.current?.focus(focus);
    setFocus('');
  }, [focus, query.data, canDraw, setFocus]);

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
  const selectedEditable = selected !== null && canDraw && canUpdate && (selected.kind === 'field' || selected.areaHa != null);

  return (
    <>
      <PageHeader
        title={t('map.title')}
        description={t('map.description')}
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

          <Card className="overflow-hidden">
            <div className="grid grid-cols-2 gap-2 border-b border-border p-2 md:flex md:flex-wrap md:items-center">
              <Select
                aria-label={t('map.baseLayer')}
                value={baseLayer}
                onChange={(e) => setBaseLayer(e.target.value)}
                options={[
                  { value: 'satellite', label: t('map.satellite') },
                  { value: 'streets', label: t('map.streets') },
                ]}
                className="md:w-40"
              />
              <Select
                aria-label={t('map.colorBy')}
                value={colorBy}
                onChange={(e) => setColorBy(e.target.value)}
                options={[
                  { value: 'landUse', label: t('map.colorLandUse') },
                  { value: 'crop', label: t('map.colorCrop') },
                ]}
                className="md:w-44"
              />
              <div className="col-span-2 min-w-0 md:ml-1 md:flex-1 md:basis-64">
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
                  selectedId={mode.kind === 'edit' ? mode.feature.id : (selected?.id ?? null)}
                  className="h-[62dvh] min-h-96 w-full lg:h-[calc(100dvh-20rem)]"
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
              <div className="pointer-events-none fixed inset-x-2 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-40 flex flex-col items-start gap-2 lg:absolute lg:bottom-2 lg:z-10 lg:pr-14">
                {selected && !busy && (
                  <SelectedPanel feature={selected} canEdit={selectedEditable} onEdit={() => startEdit(selected)} onClose={() => setSelected(null)} />
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
                        {mode.kind === 'draw' && mode.target === 'point' ? null : liveArea === null ? '—' : formatHa(liveArea)}
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
