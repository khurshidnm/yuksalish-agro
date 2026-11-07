import type { Geometry, Position } from 'geojson';

export interface GeoBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** The outer ring of every polygon. Holes do not matter at thumbnail size; a point has no outline. */
export function outerRings(geometry: Geometry | null | undefined): Position[][] {
  if (geometry?.type === 'Polygon') return geometry.coordinates.slice(0, 1);
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates.map((polygon) => polygon[0]);
  return [];
}

/** `null` when there is nothing to frame: no rings, or a shape with no width or height. */
export function boundsOf(rings: Position[][]): GeoBox | null {
  const points = rings.flat();
  if (points.length === 0) return null;
  const lngs = points.map(([lng]) => lng);
  const lats = points.map(([, lat]) => lat);
  const box = { west: Math.min(...lngs), south: Math.min(...lats), east: Math.max(...lngs), north: Math.max(...lats) };
  return box.east > box.west && box.north > box.south ? box : null;
}

/** A degree of longitude shrinks towards the poles; this is its ground width against a degree of latitude. */
const groundScale = (latitude: number) => Math.cos((latitude * Math.PI) / 180);

/** The box grown around `bounds` to a ground aspect of width / height, so a field keeps its true shape. */
export function frame(bounds: GeoBox, aspect: number, padding = 0.16): GeoBox {
  const scale = groundScale((bounds.north + bounds.south) / 2);
  let width = (bounds.east - bounds.west) * scale * (1 + padding * 2);
  let height = (bounds.north - bounds.south) * (1 + padding * 2);
  if (width / height < aspect) width = height * aspect;
  else height = width / aspect;
  const lng = (bounds.east + bounds.west) / 2;
  const lat = (bounds.north + bounds.south) / 2;
  return { west: lng - width / scale / 2, east: lng + width / scale / 2, south: lat - height / 2, north: lat + height / 2 };
}

/** An SVG path for the rings, drawn into a width × height canvas showing `box`. */
export function outlinePath(rings: Position[][], box: GeoBox, width: number, height: number): string {
  const x = (lng: number) => (((lng - box.west) / (box.east - box.west)) * width).toFixed(1);
  const y = (lat: number) => (((box.north - lat) / (box.north - box.south)) * height).toFixed(1);
  return rings.map((ring) => `M${ring.map(([lng, lat]) => `${x(lng)} ${y(lat)}`).join('L')}Z`).join('');
}

const IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export';

/** One aerial picture of `box` from the imagery the map already uses, covered by the same CSP entry. */
export function aerialUrl(box: GeoBox, width: number, height: number): string {
  const bbox = [box.west, box.south, box.east, box.north].map((value) => value.toFixed(6)).join(',');
  return `${IMAGERY}?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=${width},${height}&format=jpg&f=image`;
}
