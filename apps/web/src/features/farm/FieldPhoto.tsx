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

/** Sizes tried in turn: the imagery service refuses a small contour asked for finer than its pictures go. */
const SCALES = [1, 0.5];

/**
 * The field from above with its boundary on top. Falls back to the outline alone with no connection,
 * so a shepherd on the steppe still sees the shape of the field.
 */
export function FieldPhoto({ geometry, width = 480, aspect = 1.6, credit, className }: FieldPhotoProps) {
  const { t } = useTranslation('farm');
  const height = Math.round(width / aspect);

  const picture = useMemo(() => {
    const rings = outerRings(geometry);
    const bounds = boundsOf(rings);
    if (!bounds) return null;
    const box = frame(bounds, aspect);
    const urls = SCALES.map((scale) => aerialUrl(box, Math.round(width * scale), Math.round(height * scale)));
    return { urls, path: outlinePath(rings, box, width, height) };
  }, [aspect, geometry, height, width]);

  // Failures count for this picture only: another field shown in the same place starts again at full size.
  const [errors, setErrors] = useState({ url: '', count: 0 });
  const tries = picture && errors.url === picture.urls[0] ? errors.count : 0;
  const failed = tries >= SCALES.length;

  return (
    <div className={cn('relative overflow-hidden bg-secondary', className)} style={{ aspectRatio: aspect }}>
      {!picture ? (
        <span className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          <MapPinOff className="size-6" aria-hidden />
        </span>
      ) : (
        <>
          {!failed && (
            <img
              key={picture.urls[tries]}
              src={picture.urls[tries]}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setErrors({ url: picture.urls[0], count: tries + 1 })}
              className="absolute inset-0 size-full object-cover"
            />
          )}
          <svg viewBox={`0 0 ${width} ${height}`} aria-hidden className="absolute inset-0 size-full">
            <path d={picture.path} vectorEffect="non-scaling-stroke" strokeWidth={2.5} strokeLinejoin="round" className={failed ? 'fill-mark/30 stroke-mark' : 'fill-accent/20 stroke-accent'} />
          </svg>
          {credit && !failed && <span className="absolute right-1.5 bottom-1 rounded bg-black/50 px-1 text-[0.625rem] leading-4 text-white">{t('map.imageryCredit')}</span>}
        </>
      )}
    </div>
  );
}
