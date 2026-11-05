import { type ComponentType, lazy } from 'react';
import { toast } from 'sonner';
import { lookForNewVersion, restartOnNewVersion } from '@/features/today/pwa';
import i18n from '@/lib/i18n';
import { MissingCodeCard } from './pages';

type Load<P> = () => Promise<{ default: ComponentType<P> }>;

/**
 * `lazy` for a whole page. Its code can be missing after a deploy, or on a bad link, and neither is a crash:
 * the app restarts on the new version, or says why the page did not open and keeps the menu working.
 */
export function lazyPage<P extends object>(load: Load<P>) {
  return lazy<ComponentType<P>>(() =>
    load().catch(async (error: unknown) => {
      console.warn(error);
      await restartOnNewVersion();
      return { default: MissingCodeCard };
    }),
  );
}

/** `lazy` for one part of a page, where a restart could lose what is being typed around it. */
export function lazyPart<P extends object>(load: Load<P>) {
  return lazy<ComponentType<P>>(() =>
    load().catch((error: unknown) => {
      console.warn(error);
      lookForNewVersion();
      toast.error(i18n.t('common:update.partFailed'));
      return { default: () => null };
    }),
  );
}
