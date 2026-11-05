import { useMemo } from 'react';
import { useCan, useModuleEnabled } from '@/lib/auth';
import { useDetail } from '@/lib/query';
import { aerialUrl, boundsOf, frame, outerRings } from './geometry';
import type { FarmMapData } from './types';

/** An aerial picture of the farm's largest field, for a tile. Nothing for people who cannot see the map. */
export function useFarmBackdrop(width = 720, aspect = 2.2): string | undefined {
  const can = useCan();
  const moduleEnabled = useModuleEnabled();
  const { data } = useDetail<FarmMapData>(can('farm.view') && moduleEnabled('farm') ? '/farm/map' : null);

  return useMemo(() => {
    const fields = (data?.features ?? []).filter((feature) => feature.properties.kind === 'field');
    const largest = fields.reduce<(typeof fields)[number] | null>((best, feature) => ((feature.properties.areaHa ?? 0) > (best?.properties.areaHa ?? 0) ? feature : best), null);
    const bounds = boundsOf(outerRings(largest?.geometry));
    return bounds ? aerialUrl(frame(bounds, aspect), width, Math.round(width / aspect)) : undefined;
  }, [aspect, data, width]);
}
