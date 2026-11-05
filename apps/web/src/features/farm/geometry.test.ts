import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { aerialUrl, boundsOf, frame, outerRings, outlinePath } from './geometry';

const square: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [64.0, 39.0],
      [64.01, 39.0],
      [64.01, 39.01],
      [64.0, 39.01],
      [64.0, 39.0],
    ],
  ],
};

describe('field geometry', () => {
  it('finds nothing to frame for a point or a shape with no size', () => {
    expect(outerRings({ type: 'Point', coordinates: [64, 39] })).toEqual([]);
    expect(outerRings(null)).toEqual([]);
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([[[64, 39], [64, 39.01]]])).toBeNull();
  });

  it('keeps only the outer ring', () => {
    const withHole: Polygon = { type: 'Polygon', coordinates: [square.coordinates[0], square.coordinates[0]] };
    expect(outerRings(withHole)).toHaveLength(1);
    expect(outerRings({ type: 'MultiPolygon', coordinates: [square.coordinates, square.coordinates] })).toHaveLength(2);
  });

  it('frames a square at 39°N to the requested aspect on the ground', () => {
    const box = frame(boundsOf(outerRings(square))!, 2);
    const scale = Math.cos((39.005 * Math.PI) / 180);
    const groundWidth = (box.east - box.west) * scale;
    expect(groundWidth / (box.north - box.south)).toBeCloseTo(2, 6);
  });

  it('keeps the whole field inside the frame, with the padding around it', () => {
    const bounds = boundsOf(outerRings(square))!;
    const box = frame(bounds, 1);
    expect(box.west).toBeLessThan(bounds.west);
    expect(box.east).toBeGreaterThan(bounds.east);
    expect(box.south).toBeLessThan(bounds.south);
    expect(box.north).toBeGreaterThan(bounds.north);
  });

  it('draws north at the top of the canvas', () => {
    const box = { west: 0, east: 10, south: 0, north: 10 };
    const path = outlinePath([[[0, 10], [10, 0]]], box, 100, 100);
    expect(path).toBe('M0.0 0.0L100.0 100.0Z');
  });

  it('asks the imagery service for the same box the outline is drawn in', () => {
    const url = aerialUrl({ west: 64.1, south: 39.2, east: 64.3, north: 39.4 }, 480, 300);
    expect(url).toContain('bbox=64.100000,39.200000,64.300000,39.400000');
    expect(url).toContain('size=480,300');
    expect(url).toContain('bboxSR=4326');
    expect(url).toContain('imageSR=4326');
  });
});
