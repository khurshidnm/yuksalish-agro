import type { VegetationGrid } from './types';

/** Leaflet pane for crop-health images: under the outlines, and never in the way of a tap. */
export const HEALTH_PANE = 'health';

/** Create the pane on a map, once. */
export function ensureHealthPane(map: { getPane(name: string): HTMLElement | undefined; createPane(name: string): HTMLElement }): void {
  if (map.getPane(HEALTH_PANE)) return;
  const pane = map.createPane(HEALTH_PANE);
  pane.style.zIndex = '350';
  pane.style.pointerEvents = 'none';
}

/** NDVI at each step of the theme's crop-health ramp, --ndvi-1 to --ndvi-6. */
export const NDVI_STOPS = [0.1, 0.2, 0.3, 0.45, 0.6, 0.75] as const;

/** Legend bands, low to high: bare soil to dense crop. */
export const NDVI_BANDS = ['bare', 'sparse', 'moderate', 'good', 'dense'] as const;
export type NdviBand = (typeof NDVI_BANDS)[number];

/** Which band a value falls in, for words next to the number. */
export function ndviBand(value: number | null | undefined): NdviBand | null {
  if (value == null) return null;
  if (value < 0.2) return 'bare';
  if (value < 0.3) return 'sparse';
  if (value < 0.45) return 'moderate';
  if (value < 0.6) return 'good';
  return 'dense';
}

/** Cells of a stored grid, row 0 north: NDVI, or null where the cell is outside the field or under cloud. */
export function decodeGrid(grid: VegetationGrid): (number | null)[] {
  const bytes = Uint8Array.from(atob(grid.data), (c) => c.charCodeAt(0));
  return Array.from(bytes, (b) => (b === 255 ? null : b / 100 - 1));
}

export type Rgb = [number, number, number];

function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

/** The ramp's colours as the theme defines them. */
export function rampColors(): Rgb[] {
  const style = getComputedStyle(document.documentElement);
  return NDVI_STOPS.map((_, i) => parseHex(style.getPropertyValue(`--ndvi-${i + 1}`)) ?? [128, 128, 128]);
}

/** Colour for a value, blended between the two nearest stops. */
export function colorAt(value: number, colors: Rgb[]): Rgb {
  if (value <= NDVI_STOPS[0]) return colors[0];
  for (let i = 1; i < NDVI_STOPS.length; i++) {
    if (value <= NDVI_STOPS[i]) {
      const t = (value - NDVI_STOPS[i - 1]) / (NDVI_STOPS[i] - NDVI_STOPS[i - 1]);
      const a = colors[i - 1];
      const b = colors[i];
      return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t)) as Rgb;
    }
  }
  return colors[colors.length - 1];
}

/** The grid as an image, one pixel per 10 m cell, for laying over the map. */
export function gridImage(grid: VegetationGrid, colors: Rgb[] = rampColors()): string {
  const canvas = document.createElement('canvas');
  canvas.width = grid.width;
  canvas.height = grid.height;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const image = context.createImageData(grid.width, grid.height);
  decodeGrid(grid).forEach((value, i) => {
    if (value === null) return;
    const [r, g, b] = colorAt(value, colors);
    image.data.set([r, g, b, 235], i * 4);
  });
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Distance in metres and compass bearing in degrees from one point to another. */
export function distanceAndBearing(from: { lat: number; lng: number }, to: { lat: number; lng: number }): { metres: number; bearing: number } {
  const rad = Math.PI / 180;
  const φ1 = from.lat * rad;
  const φ2 = to.lat * rad;
  const Δφ = (to.lat - from.lat) * rad;
  const Δλ = (to.lng - from.lng) * rad;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const metres = 2 * 6_371_000 * Math.asin(Math.sqrt(a));
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const bearing = ((Math.atan2(y, x) / rad) + 360) % 360;
  return { metres, bearing };
}

export const COMPASS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;

/** Eight-point compass direction for a bearing. */
export function compassPoint(bearing: number): (typeof COMPASS)[number] {
  return COMPASS[Math.round(bearing / 45) % 8];
}
