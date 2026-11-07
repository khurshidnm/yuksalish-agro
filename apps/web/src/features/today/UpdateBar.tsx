import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import { useUpdateReady } from './pwa';

/** Waits for a tap, because a reload nobody asked for could lose what is being typed. */
export function UpdateBar() {
  const { t } = useTranslation();
  const ready = useUpdateReady();
  if (!ready) return null;
  return (
    <div role="status" data-testid="update-bar" className="flex min-h-14 items-center justify-center gap-3 bg-info-soft px-4 py-1.5 text-sm font-semibold text-info">
      <span className="min-w-0">{t('common:update.ready')}</span>
      <Button size="sm" onClick={() => window.location.reload()}>
        {t('common:update.apply')}
      </Button>
    </div>
  );
}
