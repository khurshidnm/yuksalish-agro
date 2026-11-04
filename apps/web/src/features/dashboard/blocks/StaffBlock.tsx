import type { TFunction } from 'i18next';
import type { DashboardData } from '../types';
import { blockTiles } from '../headline';
import { type LinkTo, Tile } from '../shared';

/** This block is figures only, so the tiles are the whole of it. */
export function StaffBlock({ dashboard, t, link }: { dashboard: DashboardData; t: TFunction; link: LinkTo }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {blockTiles('staff', dashboard, t, link).map(({ key, ...tile }) => (
        <Tile key={key} {...tile} />
      ))}
    </div>
  );
}
