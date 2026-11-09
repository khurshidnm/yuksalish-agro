import { area } from '@turf/area';
import type { Feature, Geometry } from 'geojson';
import L from 'leaflet';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { HEALTH_PANE, ensureHealthPane, gridImage } from '../satellite/ndvi';
import type { VegetationGrid } from '../satellite/types';
import type { FarmMapData, MapProps } from '../types';
import { loadGeoman } from './geoman';
import { CROP_SLOT, LAND_USE_SLOT } from './slots';
import './farm-map.css';

export { CROP_SLOT, LAND_USE_SLOT };

export type BaseLayer = 'satellite' | 'streets';
export type ColorBy = 'landUse' | 'crop' | 'health';
export type DrawShape = 'Polygon' | 'CircleMarker';

export const BASE_LAYERS: Record<BaseLayer, { url: string; attribution: string; maxZoom: number }> = {
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    maxZoom: 19,
  },
  streets: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  },
};

/** Uzbekistan as a whole: a farm with no location set is not anywhere in particular. */
const FALLBACK_CENTER: [number, number] = [41.3, 64.6];
const FALLBACK_ZOOM = 6;

/** Below this zoom only crop fields keep a label. */
const COMPACT_BELOW_ZOOM = 14;

/** Leaflet writes SVG attributes, where `var()` is unreliable, so tokens are resolved first. */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function slotToken(slot: number | undefined): string {
  return slot ? `--chart-${slot}` : '--muted-foreground';
}

function strokeFor(props: MapProps, colorBy: ColorBy): string {
  if (props.kind === 'facility') return token('--foreground');
  // Over the crop-health images an outline only marks the edge.
  if (colorBy === 'health') return token('--accent');
  const slot = colorBy === 'crop' ? CROP_SLOT[props.cropKey ?? ''] : LAND_USE_SLOT[props.landUse];
  return token(slotToken(slot));
}

function styleFor(props: MapProps, colorBy: ColorBy, selected: boolean): L.PathOptions {
  const color = strokeFor(props, colorBy);
  const isFacility = props.kind === 'facility';
  return {
    color: selected ? token('--accent') : color,
    weight: selected ? 4 : 2,
    fillColor: color,
    fillOpacity: isFacility ? 0.55 : colorBy === 'health' ? 0 : colorBy === 'crop' && !(props as { cropKey: string | null }).cropKey ? 0.1 : 0.35,
  };
}

/** Geodesic hectares, for the live preview only. The saved figure comes from PostGIS. */
export function hectares(geometry: Geometry): number {
  return area({ type: 'Feature', properties: {}, geometry }) / 10_000;
}

function labelFor(props: MapProps): string | null {
  if (props.kind === 'field') return `№${props.number}`;
  return null;
}

export interface DrawnShape {
  geometry: Geometry;
  areaHa: number | null;
}

export interface FarmMapHandle {
  startDraw(shape: DrawShape): void;
  undoPoint(): void;
  finishDraw(): void;
  cancelDraw(): void;
  /** Remove the shape left on the map after drawing. */
  clearDrawn(): void;
  startEdit(id: string): boolean;
  stopEdit(): void;
  editedGeometry(): Geometry | null;
  /** Fits the map to a feature. `cover` is how far a panel over the map hides its left or bottom edge, in pixels. */
  focus(id: string, cover?: { left?: number; bottom?: number }): void;
}

export interface FarmMapCanvasProps {
  data: FarmMapData | undefined;
  baseLayer: BaseLayer;
  colorBy: ColorBy;
  selectedId: string | null;
  className?: string;
  /** Height of whatever covers the bottom of the map, so the first view does not hide fields under it. */
  fitBottom?: number;
  onSelect: (props: MapProps | null) => void;
  onDrawn: (shape: DrawnShape) => void;
  onLiveArea: (hectares: number | null) => void;
  /** Crop-health images laid over their fields, when colouring by health. */
  overlays?: VegetationGrid[];
  /** Reports whether drawing tools are available. */
  onReady: (canDraw: boolean) => void;
}

/**
 * The Leaflet map, kept imperative: Geoman owns the layers while drawing, which React's
 * render cycle would fight. React state stays in FarmMapPage, which drives this through a handle.
 */
export const FarmMapCanvas = forwardRef<FarmMapHandle, FarmMapCanvasProps>(function FarmMapCanvas(props, ref) {
  const { data, baseLayer, colorBy, selectedId, className, fitBottom = 24, overlays } = props;
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const features = useRef<L.GeoJSON | null>(null);
  const images = useRef<L.LayerGroup | null>(null);
  const layers = useRef(new Map<string, L.Path>());
  const drawn = useRef<L.Layer | null>(null);
  const working = useRef<L.Polygon | null>(null);
  const editing = useRef<L.Polygon | null>(null);
  const fitted = useRef(false);
  const mode = useRef<'view' | 'draw' | 'edit'>('view');
  const [ready, setReady] = useState(false);
  // A cancelled edit leaves moved vertices on the layer, so cancelling rebuilds from the data.
  const [generation, setGeneration] = useState(0);

  // Event handlers outlive renders; they read the newest props through this.
  const latest = useRef(props);
  latest.current = props;

  /** Area of the outline so far, closing it through the cursor while it moves. */
  const reportWorking = useCallback((cursor?: L.LatLng) => {
    const points = [...((working.current?.getLatLngs() ?? []) as L.LatLng[]), ...(cursor ? [cursor] : [])];
    if (points.length < 3) return latest.current.onLiveArea(null);
    const ring = points.map((p) => [p.lng, p.lat]);
    latest.current.onLiveArea(hectares({ type: 'Polygon', coordinates: [[...ring, ring[0]]] }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadGeoman()
      .then(
        () => true,
        () => false,
      )
      .then((canDraw) => {
        if (cancelled || !container.current) return;
        const instance = L.map(container.current, { center: FALLBACK_CENTER, zoom: FALLBACK_ZOOM, zoomControl: false });
        L.control.zoom({ position: 'topright' }).addTo(instance);
        // On the left, where the assistant button can never cover the imagery credit.
        instance.attributionControl.setPosition('bottomleft');
        instance.on('click', () => {
          if (mode.current === 'view') latest.current.onSelect(null);
        });
        // Zoomed out on a phone, every label would pile onto its neighbours.
        const fitLabels = () => container.current?.classList.toggle('farm-map-compact', instance.getZoom() < COMPACT_BELOW_ZOOM);
        instance.on('zoomend', fitLabels);
        fitLabels();

        if (canDraw) {
          instance.on('pm:drawstart', ({ workingLayer }) => {
            // Placing a point also starts a draw, but its working layer has no outline to measure.
            if (!(workingLayer instanceof L.Polyline)) return;
            working.current = workingLayer as L.Polygon;
            workingLayer.on('pm:vertexadded', () => reportWorking());
          });
          instance.on('pm:drawend', () => {
            working.current = null;
            mode.current = 'view';
          });
          instance.on('mousemove', (event: L.LeafletMouseEvent) => {
            if (working.current) reportWorking(event.latlng);
          });
          instance.on('pm:create', ({ shape, layer }) => {
            drawn.current = layer;
            const geometry = (layer as L.Polygon).toGeoJSON(9).geometry;
            latest.current.onDrawn({ geometry, areaHa: shape === 'Polygon' ? hectares(geometry) : null });
          });
        }

        map.current = instance;
        latest.current.onReady(canDraw);
        setReady(true);
      });

    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      tiles.current = null;
      features.current = null;
      setReady(false);
    };
  }, [reportWorking]);

  useEffect(() => {
    if (!ready || !map.current) return;
    tiles.current?.remove();
    const { url, ...options } = BASE_LAYERS[baseLayer];
    tiles.current = L.tileLayer(url, options).addTo(map.current);
    // Through classList: Leaflet keeps its own classes on this element, which a new className would wipe.
    container.current?.classList.toggle('farm-map-streets', baseLayer === 'streets');
  }, [ready, baseLayer]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance || !data) return;
    features.current?.remove();
    layers.current.clear();

    // Largest first, so a contour lying inside another stays on top and can be clicked.
    const ordered = [...data.features].sort((a, b) => (b.properties.areaHa ?? 0) - (a.properties.areaHa ?? 0));

    const group = L.geoJSON(ordered as never, {
      style: (feature) => styleFor((feature as Feature).properties as MapProps, colorBy, false),
      pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 7 }),
      onEachFeature: (feature, layer) => {
        const properties = feature.properties as MapProps;
        layers.current.set(properties.id, layer as L.Path);
        const label = labelFor(properties);
        if (label) {
          const minor = properties.kind === 'field' && properties.landUse !== 'arable';
          layer.bindTooltip(label, { permanent: true, direction: 'center', className: `farm-map-label${minor ? ' farm-map-label-minor' : ''}` });
        }
        layer.on('click', (event) => {
          // While drawing, a click on a contour must still reach Geoman as a new point.
          if (mode.current !== 'view') return;
          L.DomEvent.stopPropagation(event);
          latest.current.onSelect(properties);
        });
      },
    }).addTo(instance);
    features.current = group;

    if (!fitted.current) {
      // The fields and the yard, not a pasture far off that would shrink them to specks.
      const core = L.latLngBounds([]);
      group.eachLayer((layer) => {
        const feature = (layer as L.Polygon & { feature?: { properties?: { landUse?: string } } }).feature;
        if ('getBounds' in layer && feature?.properties?.landUse !== 'pasture') core.extend((layer as L.Polygon).getBounds());
      });
      const bounds = core.isValid() ? core : group.getBounds();
      if (bounds.isValid()) {
        instance.fitBounds(bounds, { paddingTopLeft: [24, 24], paddingBottomRight: [24, fitBottom] });
        fitted.current = true;
      } else if (data.center) {
        instance.setView([data.center.lat, data.center.lng], 14);
        fitted.current = true;
      }
    }
  }, [ready, data, colorBy, generation]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    images.current?.remove();
    images.current = null;
    if (!overlays?.length) return;
    ensureHealthPane(instance);
    const group = L.layerGroup(
      overlays
        .map((grid) => ({ grid, url: gridImage(grid) }))
        .filter((o) => o.url)
        .map(({ grid, url }) => L.imageOverlay(url, [[grid.south, grid.west], [grid.north, grid.east]], { className: 'health-grid', interactive: false, pane: HEALTH_PANE })),
    ).addTo(instance);
    images.current = group;
  }, [ready, overlays]);

  const restyle = useCallback(() => {
    for (const [id, layer] of layers.current) {
      const properties = (layer as L.Path & { feature?: Feature }).feature?.properties as MapProps | undefined;
      if (properties) layer.setStyle(styleFor(properties, colorBy, id === selectedId));
    }
    if (selectedId) layers.current.get(selectedId)?.bringToFront();
  }, [colorBy, selectedId]);

  useEffect(restyle, [restyle, ready, data, generation]);

  // Colours are resolved once, so a theme switch has to repaint them.
  useEffect(() => {
    const observer = new MutationObserver(restyle);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [restyle]);

  useImperativeHandle(
    ref,
    () => ({
      startDraw(shape) {
        const instance = map.current;
        if (!instance) return;
        mode.current = 'draw';
        const accent = token('--accent');
        instance.pm.enableDraw(shape, {
          snappable: true,
          snapDistance: 12,
          allowSelfIntersection: false,
          continueDrawing: false,
          tooltips: false,
          templineStyle: { color: accent },
          hintlineStyle: { color: accent, dashArray: [5, 5] },
          pathOptions: { color: accent, fillColor: accent, fillOpacity: 0.3 },
        });
      },
      undoPoint() {
        (map.current?.pm.Draw as unknown as { Polygon: { _removeLastVertex(): void } }).Polygon._removeLastVertex();
        reportWorking();
      },
      finishDraw() {
        (map.current?.pm.Draw as unknown as { Polygon: { _finishShape(): void } }).Polygon._finishShape();
      },
      cancelDraw() {
        map.current?.pm.disableDraw();
        mode.current = 'view';
        latest.current.onLiveArea(null);
      },
      clearDrawn() {
        drawn.current?.remove();
        drawn.current = null;
      },
      startEdit(id) {
        const layer = layers.current.get(id) as L.Polygon | undefined;
        if (!layer?.pm) return false;
        mode.current = 'edit';
        editing.current = layer;
        layer.pm.enable({ allowSelfIntersection: false, snappable: true, snapDistance: 12 });
        // Measured only once a point moves: until then the saved PostGIS figure stands, not this rounder estimate.
        const report = () => latest.current.onLiveArea(hectares(layer.toGeoJSON(9).geometry));
        layer.on('pm:markerdrag pm:edit pm:vertexadded pm:vertexremoved', report);
        return true;
      },
      stopEdit() {
        const layer = editing.current;
        if (layer) {
          layer.off('pm:markerdrag pm:edit pm:vertexadded pm:vertexremoved');
          layer.pm.disable();
        }
        editing.current = null;
        mode.current = 'view';
        latest.current.onLiveArea(null);
        setGeneration((n) => n + 1);
      },
      editedGeometry() {
        return editing.current?.toGeoJSON(9).geometry ?? null;
      },
      focus(id, cover = {}) {
        const layer = layers.current.get(id);
        const instance = map.current;
        if (!layer || !instance) return;
        const pad = 48;
        // Whatever the panel hides, keep at least a 96 px view for the feature itself.
        const size = instance.getSize();
        const left = Math.max(0, Math.min(cover.left ?? 0, size.x - 2 * pad - 96));
        const bottom = Math.max(0, Math.min(cover.bottom ?? 0, size.y - 2 * pad - 96));
        const point = 'getBounds' in layer ? null : (layer as unknown as L.CircleMarker).getLatLng();
        const bounds = point ? L.latLngBounds(point, point) : (layer as L.Polygon).getBounds();
        instance.fitBounds(bounds, { paddingTopLeft: [pad + left, pad], paddingBottomRight: [pad, pad + bottom], maxZoom: 17 });
      },
    }),
    [reportWorking],
  );

  return <div ref={container} className={`farm-map ${className ?? ''}`} />;
});
