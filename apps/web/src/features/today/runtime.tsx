import { useEffect } from 'react';
import { router } from '@/app/router';
import { useAuth } from '@/lib/auth';
import { outbox, startOutbox } from '@/lib/outbox';
import { clearReferenceData } from './data';
import { cacheScreensFor, clearSessionSnapshot, saveSessionSnapshot } from './pwa';

/**
 * Field staff who can also open the dashboard still start their day here. Shepherds and mechanics
 * have no dashboard, so its route already sends them to /today.
 */
const STARTS_ON_TODAY = new Set(['storekeeper']);

/** Connects the offline layer to the session. Renders nothing. */
export function OfflineRuntime() {
  const { status, session } = useAuth();
  const userId = session?.user.id;
  const farmId = session?.farm?.id;
  const roleKey = session?.role?.key;

  useEffect(() => startOutbox(), []);

  useEffect(() => {
    void outbox.setOwner(userId && farmId ? { userId, farmId } : null);
  }, [userId, farmId]);

  useEffect(() => {
    if (status === 'authenticated' && session) void saveSessionSnapshot(session);
    if (status === 'anonymous') {
      // Whoever uses this phone next must not find the last person's data.
      void clearSessionSnapshot();
      void clearReferenceData();
    }
  }, [status, session]);

  useEffect(() => {
    if (roleKey) void cacheScreensFor(roleKey);
  }, [roleKey]);

  // Once per sign-in: the dashboard link keeps working afterwards.
  useEffect(() => {
    if (status !== 'authenticated' || !roleKey || !STARTS_ON_TODAY.has(roleKey)) return undefined;
    let stop: () => void = () => undefined;
    const settle = (): boolean => {
      const { pathname } = router.state.location;
      if (pathname === '/login') return false;
      stop();
      if (pathname === '/') void router.navigate('/today', { replace: true });
      return true;
    };
    if (!settle()) stop = router.subscribe(() => void settle());
    return () => stop();
  }, [status, roleKey]);

  return null;
}
