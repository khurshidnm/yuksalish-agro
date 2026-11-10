import type { Geometry, Polygon } from 'geojson';
import L from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button } from '@/components/ui';
import { BASE_LAYERS } from '@/features/farm/map/FarmMapCanvas';
import { loadGeoman } from '@/features/farm/map/geoman';
import '@/features/farm/map/farm-map.css';
import { type MapZone, token, useThemeTick, zoneLayer, zoneStyle } from './TrackingMap';
import type { ZoneKind } from './types';

export interface ZoneDraft {
  /** Decides the colour of the outline being drawn. */
  kind: ZoneKind;
  value: Polygon | null;
  onChange: (value: Polygon | null) => void;
}

export interface ZoneMapProps {
  zones: MapZone[];
  /** Field and yard outlines, for orientation. */
  outlines?: Geometry[];
  /** Where each herd is now, so a zone is drawn around the sheep and not from memory. */
  herds?: { id: string; name: string | null; lat: number; lng: number }[];
  /** A new zone being drawn; `null` when the map is only looked at. */
  draft: ZoneDraft | null;
  className?: string;
}

const FALLBACK_CENTER: [number, number] = [41.3, 64.6];
const FALLBACK_ZOOM = 6;

type DrawTools = { Polygon: { _removeLastVertex(): void; _finishShape(): void } };

/**
 * The zones on satellite imagery, and the tool that draws a new one: tap each corner, undo, finish.
 * The buttons sit under the map, where a gloved thumb reaches them, not on Geoman's small toolbar.
 */
export function ZoneMap({ zones, outlines, herds, draft, className }: ZoneMapProps) {
  const { t } = useTranslation('tracking');
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const working = useRef<L.Polyline | null>(null);
  const layers = useRef<{ outlines?: L.Layer; zones?: L.Layer; herds?: L.Layer; draft?: L.Layer }>({});
  const fitted = useRef(false);
  const latest = useRef({ draft });
  latest.current = { draft };
  /** `null` until the drawing tools have loaded or failed. */
  const [canDraw, setCanDraw] = useState<boolean | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [corners, setCorners] = useState(0);
  const theme = useThemeTick();

  useEffect(() => {
    let cancelled = false;
    // Geoman attaches `map.pm` through an init hook, so it must be loaded before the map exists.
    void loadGeoman()
      .then(
        () => true,
        () => false,
      )
      .then((tools) => {
        if (cancelled || !container.current) return;
        const instance = L.map(container.current, { center: FALLBACK_CENTER, zoom: FALLBACK_ZOOM, zoomControl: false });
        L.control.zoom({ position: 'topright' }).addTo(instance);
        instance.attributionControl.setPosition('bottomleft');
        const { url, ...options } = BASE_LAYERS.satellite;
        L.tileLayer(url, options).addTo(instance);
        if (tools) {
          instance.on('pm:drawstart', ({ workingLayer }) => {
            if (!(workingLayer instanceof L.Polyline)) return;
            working.current = workingLayer;
            setCorners(0);
            workingLayer.on('pm:vertexadded', () => setCorners((workingLayer.getLatLngs() as L.LatLng[]).length));
          });
          instance.on('pm:drawend', () => {
            working.current = null;
            setDrawing(false);
          });
          instance.on('pm:create', ({ layer }) => {
            // The outline is kept as data and redrawn from it, so "draw again" has one thing to clear.
            const geometry = (layer as L.Polygon).toGeoJSON(9).geometry as Polygon;
            layer.remove();
            latest.current.draft?.onChange(geometry);
          });
        }
        map.current = instance;
        setCanDraw(tools);
      });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      working.current = null;
      layers.current = {};
      fitted.current = false;
    };
  }, []);

  const ready = canDraw !== null;

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    layers.current.outlines?.remove();
    layers.current.outlines = undefined;
    if (!outlines?.length) return;
    const color = token('--card');
    layers.current.outlines = L.geoJSON({ type: 'FeatureCollection', features: outlines.map((geometry) => ({ type: 'Feature', geometry, properties: {} })) } as never, {
      style: { color, weight: 1.5, opacity: 0.8, fill: false },
      pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 5, color, weight: 1.5, opacity: 0.8, fill: false, interactive: false }),
      interactive: false,
    }).addTo(instance);
  }, [ready, outlines, theme]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    layers.current.zones?.remove();
    layers.current.zones = zones.length ? zoneLayer(zones).addTo(instance) : undefined;
  }, [ready, zones, theme]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    layers.current.herds?.remove();
    layers.current.herds = undefined;
    if (!herds?.length) return;
    const ring = token('--card');
    const fill = token('--primary');
    layers.current.herds = L.layerGroup(
      herds.map((h) => {
        const dot = L.circleMarker([h.lat, h.lng], { radius: 7, color: ring, weight: 2, fillColor: fill, fillOpacity: 0.95, interactive: Boolean(h.name) });
        return h.name ? dot.bindTooltip(h.name, { direction: 'top', offset: [0, -6] }) : dot;
      }),
    ).addTo(instance);
  }, [ready, herds, theme]);

  const draftValue = draft?.value ?? null;
  const draftKind = draft?.kind ?? 'allowed';
  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    layers.current.draft?.remove();
    layers.current.draft = draftValue
      ? L.geoJSON(draftValue as never, { style: { ...zoneStyle({ kind: draftKind, active: true }), dashArray: '4 6' }, interactive: false }).addTo(instance)
      : undefined;
  }, [ready, draftValue, draftKind, theme]);

  // The form was closed with an outline half drawn.
  const drafting = draft !== null;
  useEffect(() => {
    if (!drafting) map.current?.pm?.disableDraw();
  }, [drafting]);

  // Fit once, when there is something to show; never again, so saving a zone does not move the view.
  const hasContent = zones.some((z) => z.geometry) || Boolean(outlines?.length) || Boolean(herds?.length);
  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance || fitted.current || !hasContent) return;
    const bounds = L.latLngBounds([]);
    for (const key of ['zones', 'outlines'] as const) {
      const layer = layers.current[key] as L.GeoJSON | undefined;
      if (layer && layer.getBounds().isValid()) bounds.extend(layer.getBounds());
    }
    for (const h of herds ?? []) bounds.extend([h.lat, h.lng]);
    if (!bounds.isValid()) return;
    instance.fitBounds(bounds.pad(0.15), { maxZoom: 17, animate: false });
    fitted.current = true;
  }, [ready, hasContent, zones, outlines, herds]);

  const tools = () => map.current?.pm.Draw as unknown as DrawTools | undefined;
  const start = () => {
    const instance = map.current;
    if (!instance || !draft) return;
    draft.onChange(null);
    const color = token(draft.kind === 'forbidden' ? '--destructive' : '--accent');
    instance.pm.enableDraw('Polygon', {
      snappable: true,
      snapDistance: 12,
      allowSelfIntersection: false,
      continueDrawing: false,
      tooltips: false,
      templineStyle: { color },
      hintlineStyle: { color, dashArray: [5, 5] },
      pathOptions: { color, fillColor: color, fillOpacity: 0.3 },
    });
    setDrawing(true);
  };
  const undo = () => {
    tools()?.Polygon._removeLastVertex();
    setCorners(((working.current?.getLatLngs() ?? []) as L.LatLng[]).length);
  };
  const finish = () => tools()?.Polygon._finishShape();
  const cancel = () => map.current?.pm.disableDraw();

  return (
    <div className="space-y-2">
      <div ref={container} className={`farm-map ${className ?? ''}`} />
      {draft && canDraw === false && <Alert tone="warning">{t('zones.draw.unavailable')}</Alert>}
      {draft && canDraw && (
        <div className="space-y-2" aria-live="polite">
          {drawing ? (
            <>
              <p className="text-sm text-muted-foreground">{t('zones.draw.hint')}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={finish} disabled={corners < 3}>
                  {t('zones.draw.finish')}
                </Button>
                <Button type="button" variant="outline" onClick={undo} disabled={corners < 1}>
                  {t('zones.draw.undo')}
                </Button>
                <Button type="button" variant="ghost" onClick={cancel}>
                  {t('common:actions.cancel')}
                </Button>
              </div>
            </>
          ) : draft.value ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-sm text-success">{t('zones.draw.done')}</span>
              <Button type="button" variant="outline" onClick={start}>
                {t('zones.draw.again')}
              </Button>
            </div>
          ) : (
            <Button type="button" variant="accent" onClick={start}>
              {t('zones.draw.start')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
