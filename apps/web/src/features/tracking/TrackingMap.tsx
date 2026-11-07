import type { Geometry } from 'geojson';
import L from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import { BASE_LAYERS } from '@/features/farm/map/FarmMapCanvas';
import '@/features/farm/map/farm-map.css';
import './tracking-map.css';
import type { TrackingFlag } from './types';

export interface MapAnimal {
  id: string;
  lat: number;
  lng: number;
  /** The most urgent flag, if any: drawn as a large pin that a gloved finger can hit. */
  flag: TrackingFlag | null;
  /** No reading for a while: grey, so nobody walks to where she was hours ago. */
  stale: boolean;
  /** Accessible name and tooltip. */
  label: string;
}

export interface TrackingMapProps {
  animals: MapAnimal[];
  /** A day's walk, oldest first. */
  track?: { lat: number; lng: number }[];
  /** Field and yard outlines, for orientation. */
  outlines?: Geometry[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** The view fits the animals again whenever this changes, such as when the herd filter does. */
  fitKey?: string;
  className?: string;
}

/** Uzbekistan as a whole, until there is something to show. */
const FALLBACK_CENTER: [number, number] = [41.3, 64.6];
const FALLBACK_ZOOM = 6;

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Repaint when the theme changes: canvas and SVG colours are resolved when drawn. */
function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setTick((n) => n + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => observer.disconnect();
  }, []);
  return tick;
}

/**
 * Where the flock is: one dot per sheep on satellite imagery, flagged sheep as big pins, and on the
 * passport the day's track. Leaflet is driven imperatively, as on the farm map, and draws on canvas
 * so 700 dots stay smooth on a phone.
 */
export function TrackingMap({ animals, track, outlines, selectedId, onSelect, fitKey, className }: TrackingMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const outlineLayer = useRef<L.GeoJSON | null>(null);
  const dots = useRef<L.LayerGroup | null>(null);
  const trackLayer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef<string | null>(null);
  const latest = useRef({ onSelect });
  latest.current = { onSelect };
  const theme = useThemeTick();

  useEffect(() => {
    if (!container.current) return;
    const instance = L.map(container.current, { zoomControl: false, attributionControl: true, preferCanvas: true });
    L.control.zoom({ position: 'topright' }).addTo(instance);
    instance.attributionControl.setPosition('bottomleft');
    const { url, ...options } = BASE_LAYERS.satellite;
    L.tileLayer(url, options).addTo(instance);
    instance.setView(FALLBACK_CENTER, FALLBACK_ZOOM);
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
      outlineLayer.current = null;
      dots.current = null;
      trackLayer.current = null;
      fitted.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    outlineLayer.current?.remove();
    outlineLayer.current = null;
    if (!outlines?.length) return;
    outlineLayer.current = L.geoJSON({ type: 'FeatureCollection', features: outlines.map((geometry) => ({ type: 'Feature', geometry, properties: {} })) } as never, {
      style: { color: token('--card'), weight: 1.5, opacity: 0.8, fill: false },
      interactive: false,
    }).addTo(instance);
  }, [outlines, theme]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    dots.current?.remove();
    const group = L.layerGroup();
    const ring = token('--card');
    const fill = { ok: token('--primary'), stale: token('--muted-foreground') };
    // Plain dots first, so pins and the selected sheep sit on top.
    for (const a of animals.filter((x) => !x.flag)) {
      const selected = a.id === selectedId;
      const dot = L.circleMarker([a.lat, a.lng], {
        radius: selected ? 9 : 6,
        color: selected ? token('--accent') : ring,
        weight: selected ? 3 : 1.5,
        fillColor: a.stale ? fill.stale : fill.ok,
        fillOpacity: 0.95,
      });
      dot.bindTooltip(a.label, { direction: 'top', offset: [0, -6] });
      dot.on('click', () => latest.current.onSelect?.(a.id));
      group.addLayer(dot);
    }
    for (const a of animals.filter((x) => x.flag)) {
      const selected = a.id === selectedId;
      const icon = L.divIcon({
        className: `tracking-pin tracking-pin-${a.flag}${a.stale ? ' tracking-pin-stale' : ''}${selected ? ' tracking-pin-selected' : ''}`,
        html: '<span></span>',
        iconSize: [44, 44],
      });
      const pin = L.marker([a.lat, a.lng], { icon, keyboard: true, title: a.label, alt: a.label, zIndexOffset: selected ? 1000 : 500 });
      pin.on('click', () => latest.current.onSelect?.(a.id));
      group.addLayer(pin);
    }
    group.addTo(instance);
    dots.current = group;
  }, [animals, selectedId, theme]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    trackLayer.current?.remove();
    trackLayer.current = null;
    if (!track || track.length < 2) return;
    const color = token('--info');
    const points = track.map((p) => [p.lat, p.lng] as [number, number]);
    trackLayer.current = L.layerGroup([
      L.polyline(points, { color, weight: 3, opacity: 0.9, interactive: false }),
      L.circleMarker(points[0]!, { radius: 4, color, weight: 2, fillColor: token('--card'), fillOpacity: 1, interactive: false }),
    ]).addTo(instance);
  }, [track, theme]);

  // Fit once there is something to show, and again when the caller asks; never on a mere refresh,
  // which would pull the view away from where the shepherd zoomed in.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const key = fitKey ?? '';
    if (fitted.current === key) return;
    const bounds = L.latLngBounds([]);
    for (const a of animals) bounds.extend([a.lat, a.lng]);
    for (const p of track ?? []) bounds.extend([p.lat, p.lng]);
    if (!bounds.isValid() && outlineLayer.current) bounds.extend(outlineLayer.current.getBounds());
    if (!bounds.isValid()) return;
    instance.fitBounds(bounds.pad(0.15), { maxZoom: 17, animate: false });
    fitted.current = key;
  }, [animals, track, outlines, fitKey]);

  useEffect(() => {
    const instance = map.current;
    const a = animals.find((x) => x.id === selectedId);
    if (!instance || !a) return;
    if (!instance.getBounds().pad(-0.1).contains([a.lat, a.lng])) instance.panTo([a.lat, a.lng]);
  }, [selectedId, animals]);

  return <div ref={container} className={`farm-map ${className ?? ''}`} />;
}
