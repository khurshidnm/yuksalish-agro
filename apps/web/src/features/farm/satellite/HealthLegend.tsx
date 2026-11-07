import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { NDVI_BANDS } from './ndvi';

/** The ramp as a CSS gradient. */
const RAMP = 'linear-gradient(to right, var(--ndvi-1), var(--ndvi-2), var(--ndvi-3), var(--ndvi-4), var(--ndvi-5), var(--ndvi-6))';

/** Crop-health colours, bare soil to dense crop, in words. */
export function HealthLegend({ className }: { className?: string }) {
  const { t } = useTranslation('farm');
  return (
    <div aria-label={t('satellite.legend')} role="group" className={cn('min-w-0', className)}>
      <div className="h-3 rounded-full" style={{ background: RAMP }} aria-hidden />
      <ul className="mt-1 flex justify-between gap-1 text-xs text-muted-foreground">
        {NDVI_BANDS.map((band) => (
          <li key={band}>{t(`satellite.band.${band}`)}</li>
        ))}
      </ul>
    </div>
  );
}
