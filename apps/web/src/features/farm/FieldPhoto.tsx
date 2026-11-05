import type { Geometry } from 'geojson';
import { MapPinOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { aerialUrl, boundsOf, frame, outerRings, outlinePath } from './geometry';

export interface FieldPhotoProps {
  geometry: Geometry | null | undefined;
  /** Width of the picture requested, in pixels; twice the width shown keeps it sharp on a phone. */
  width?: number;
  /** Width / height. */
  aspect?: number;
  /** Prints the imagery credit, for pictures large enough to carry it. */
  credit?: boolean;
  className?: string;
}

/**
 * The field from above with its boundary on top. Falls back to the outline alone with no connection,
 * so a shepherd on the steppe still sees the shape of the field.
 */
export function FieldPhoto({ geometry, width = 480, aspect = 1.6, credit, className }: FieldPhotoProps) {
  const { t } = useTranslation('farm');
  const [failed, setFailed] = useState(false);
  const height = Math.round(width / aspect);

  const picture = useMemo(() => {
    const rings = outerRings(geometry);
    const bounds = boundsOf(rings);
    if (!bounds) return null;
    const box = frame(bounds, aspect);
    return { url: aerialUrl(box, width, height), path: outlinePath(rings, box, width, height) };
  }, [aspect, geometry, height, width]);

  return (
    <div className={cn('relative overflow-hidden bg-secondary', className)} style={{ aspectRatio: aspect }}>
      {!picture ? (
        <span className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          <MapPinOff className="size-6" aria-hidden />
        </span>
      ) : (
        <>
          {!failed && <img src={picture.url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />}
          <svg viewBox={`0 0 ${width} ${height}`} aria-hidden className="absolute inset-0 size-full">
            <path d={picture.path} vectorEffect="non-scaling-stroke" strokeWidth={2.5} strokeLinejoin="round" className={failed ? 'fill-mark/30 stroke-mark' : 'fill-accent/20 stroke-accent'} />
          </svg>
          {credit && !failed && <span className="absolute right-1.5 bottom-1 rounded bg-black/50 px-1 text-[0.625rem] leading-4 text-white">{t('map.imageryCredit')}</span>}
        </>
      )}
    </div>
  );
}
