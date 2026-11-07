import type { Geometry } from 'geojson';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { boundsOf, frame, outerRings, outlinePath } from './geometry';

const SIZE = 40;

/** The real outline of a field as a small icon, so a list reads like the map. Slots follow the map's. */
export function FieldShape({ geometry, slot, className }: { geometry: Geometry | null | undefined; slot?: number; className?: string }) {
  const path = useMemo(() => {
    const rings = outerRings(geometry);
    const bounds = boundsOf(rings);
    return bounds ? outlinePath(rings, frame(bounds, 1, 0.06), SIZE, SIZE) : null;
  }, [geometry]);

  const color = slot ? `var(--chart-${slot})` : 'var(--muted-foreground)';
  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden className={cn('size-9 shrink-0', className)}>
      {path ? (
        <path d={path} fill={color} fillOpacity={0.3} stroke={color} strokeWidth={2} strokeLinejoin="round" />
      ) : (
        <rect x={7} y={7} width={26} height={26} rx={6} fill="none" stroke="var(--input)" strokeWidth={2} strokeDasharray="4 4" />
      )}
    </svg>
  );
}
