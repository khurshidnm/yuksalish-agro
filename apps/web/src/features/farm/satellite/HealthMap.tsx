import type { Geometry } from 'geojson';
import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { BASE_LAYERS } from '../map/FarmMapCanvas';
import '../map/farm-map.css';
import { HEALTH_PANE, ensureHealthPane, gridImage } from './ndvi';
import type { VegetationGrid, WeakZone } from './types';

export interface Position {
  lat: number;
  lng: number;
  accuracyM: number;
}

export interface HealthMapProps {
  boundary: Geometry;
  grid: VegetationGrid | null;
  zones: WeakZone[];
  selectedZone: number | null;
  onSelectZone: (index: number) => void;
  /** The person's own position, while they walk to a zone. */
  position: Position | null;
  /** Accessible name of each zone marker. */
  zoneLabel: (index: number) => string;
  className?: string;
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * One field from above: satellite imagery, the crop-health grid laid over it, numbered weak zones,
 * and the person's own dot when they ask where they are. Leaflet is driven imperatively, as on the farm map.
 */
export function HealthMap({ boundary, grid, zones, selectedZone, onSelectZone, position, zoneLabel, className }: HealthMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const outline = useRef<L.GeoJSON | null>(null);
  const overlay = useRef<L.ImageOverlay | null>(null);
  const markers = useRef<L.LayerGroup | null>(null);
  const me = useRef<L.LayerGroup | null>(null);
  const latest = useRef({ onSelectZone, zoneLabel });
  latest.current = { onSelectZone, zoneLabel };

  useEffect(() => {
    if (!container.current) return;
    const instance = L.map(container.current, { zoomControl: false, attributionControl: true });
    L.control.zoom({ position: 'topright' }).addTo(instance);
    instance.attributionControl.setPosition('bottomleft');
    const { url, ...options } = BASE_LAYERS.satellite;
    L.tileLayer(url, options).addTo(instance);
    ensureHealthPane(instance);
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
      outline.current = null;
      overlay.current = null;
      markers.current = null;
      me.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    outline.current?.remove();
    outline.current = L.geoJSON(boundary as never, {
      style: { color: token('--accent'), weight: 2, fill: false },
      interactive: false,
    }).addTo(instance);
    const bounds = outline.current.getBounds();
    if (bounds.isValid()) instance.fitBounds(bounds, { padding: [24, 24], maxZoom: 18 });
  }, [boundary]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    overlay.current?.remove();
    overlay.current = null;
    if (!grid) return;
    const url = gridImage(grid);
    if (!url) return;
    overlay.current = L.imageOverlay(url, [
      [grid.south, grid.west],
      [grid.north, grid.east],
    ], { className: 'health-grid', interactive: false, pane: HEALTH_PANE }).addTo(instance);
  }, [grid]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    markers.current?.remove();
    const group = L.layerGroup();
    zones.forEach((zone, index) => {
      const selected = index === selectedZone;
      const icon = L.divIcon({
        className: `health-zone${selected ? ' health-zone-selected' : ''}`,
        html: `<span>${index + 1}</span>`,
        iconSize: [44, 44],
      });
      const marker = L.marker([zone.lat, zone.lng], { icon, keyboard: true, title: latest.current.zoneLabel(index), alt: latest.current.zoneLabel(index) });
      marker.on('click', () => latest.current.onSelectZone(index));
      group.addLayer(marker);
    });
    group.addTo(instance);
    markers.current = group;
  }, [zones, selectedZone]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    me.current?.remove();
    me.current = null;
    if (!position) return;
    const color = token('--info');
    const group = L.layerGroup([
      L.circle([position.lat, position.lng], { radius: position.accuracyM, color, weight: 1, fillColor: color, fillOpacity: 0.12, interactive: false }),
      L.circleMarker([position.lat, position.lng], { radius: 7, color: token('--card'), weight: 2, fillColor: color, fillOpacity: 1, interactive: false }),
    ]).addTo(instance);
    me.current = group;
    const target = selectedZone !== null ? zones[selectedZone] : null;
    const view = L.latLngBounds([[position.lat, position.lng]]);
    if (target) view.extend([target.lat, target.lng]);
    else if (outline.current) view.extend(outline.current.getBounds());
    instance.fitBounds(view, { padding: [40, 40], maxZoom: 18 });
  }, [position, selectedZone, zones]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || selectedZone === null || position) return;
    const zone = zones[selectedZone];
    if (zone) instance.setView([zone.lat, zone.lng], Math.max(instance.getZoom(), 17));
  }, [selectedZone, zones, position]);

  return <div ref={container} className={`farm-map ${className ?? ''}`} />;
}
