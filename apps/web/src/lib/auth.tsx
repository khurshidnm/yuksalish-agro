import type { Permission } from '@yap/shared';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  bindTabIdentity,
  deliverSignOut,
  forgetOpenSaves,
  oweSignOut,
  refreshSession,
  setAccessToken,
  setAuthEvents,
  settleSignOut,
} from './api';
import { setDefaultCurrency } from './format';
import i18n, { LANGUAGES } from './i18n';
import { queryClient } from './query';
import type { AuthResult, Session, TwoFactorChallenge } from './types';
import { storageGet, storageRemove, storageSet } from './utils';

/** Who is signed in on this browser: read by the public page before anything loads, and by every other tab. */
const SIGNED_IN_KEY = 'yap.signedIn';

/** Whether a session could be restored here. Blocked storage holds no mark, and then only the server can tell. */
function maybeSignedIn(): boolean {
  if (storageGet(SIGNED_IN_KEY) !== null) return true;
  const probe = 'yap.storageProbe';
  storageSet(probe, '1');
  const blocked = storageGet(probe) === null;
  storageRemove(probe);
  return blocked;
}

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export type LoginOutcome = { status: 'ok' } | { status: 'two-factor'; challengeToken: string };

interface AuthContextValue {
  status: AuthStatus;
  session: Session | null;
  login(phone: string, password: string): Promise<LoginOutcome>;
  verifyTwoFactor(challengeToken: string, code: string): Promise<Session>;
  logout(): Promise<void>;
  switchFarm(membershipId: string): Promise<void>;
  /** Join a farm that invited this person, and land on it. */
  acceptInvitation(id: string): Promise<void>;
  /** Reload the session from the server, e.g. after enabling two-factor. */
  reloadSession(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function useProvideAuth(): AuthContextValue {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const languageApplied = useRef(false);
  /** This tab's person, once storage holds the mark. Blocked storage leaves it null, and then tabs cannot compare. */
  const signedInAs = useRef<string | null>(null);

  const applySession = useCallback((next: Session) => {
    bindTabIdentity({ userId: next.user.id, farmId: next.farm?.id ?? null });
    setSession(next);
    setDefaultCurrency(next.tenant?.currency);
    setStatus('authenticated');
    storageSet(SIGNED_IN_KEY, next.user.id);
    signedInAs.current = storageGet(SIGNED_IN_KEY) === next.user.id ? next.user.id : null;
    // A saved account language applies once, so it never overrides a switch made during the session.
    if (!languageApplied.current) {
      languageApplied.current = true;
      const locale = next.user.locale;
      const hasLocalChoice = (() => {
        try {
          return localStorage.getItem('yap.language') !== null;
        } catch {
          return true;
        }
      })();
      if (locale && !hasLocalChoice && LANGUAGES.some((l) => l.code === locale)) void i18n.changeLanguage(locale);
    }
  }, []);

  const clear = useCallback(() => {
    // By now the mark may be the next person's, signed in from another tab. Removing it would end theirs.
    if (signedInAs.current && storageGet(SIGNED_IN_KEY) === signedInAs.current) storageRemove(SIGNED_IN_KEY);
    signedInAs.current = null;
    bindTabIdentity(null);
    setAccessToken(null);
    forgetOpenSaves();
    setSession(null);
    setStatus('anonymous');
    queryClient.clear();
  }, []);

  useEffect(() => {
    setAuthEvents({
      onRefreshed: (next) => {
        if (next) applySession(next as Session);
      },
      onSignedOut: clear,
      // A full start, because the last person's cards live in component state as well as in the cache.
      onSomeoneElse: () => window.location.reload(),
    });
  }, [applySession, clear]);

  // Sign-out ends every tab, and a tab asleep at that moment finds out as it wakes.
  useEffect(() => {
    const compare = () => {
      if (!signedInAs.current) return;
      const now = storageGet(SIGNED_IN_KEY);
      if (now === null) clear();
      else if (now !== signedInAs.current) window.location.reload();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === SIGNED_IN_KEY || event.key === null) compare();
    };
    const retrySignOut = () => void deliverSignOut();
    window.addEventListener('storage', onStorage);
    window.addEventListener('pageshow', compare);
    document.addEventListener('visibilitychange', compare);
    window.addEventListener('online', retrySignOut);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pageshow', compare);
      document.removeEventListener('visibilitychange', compare);
      window.removeEventListener('online', retrySignOut);
    };
  }, [clear]);

  // Restore the session from the refresh cookie on load. A success arrives through onRefreshed.
  useEffect(() => {
    let cancelled = false;
    void deliverSignOut();
    if (!maybeSignedIn()) {
      setStatus('anonymous');
      return undefined;
    }
    void refreshSession().then(async (result) => {
      if (cancelled) return;
      if (!result) {
        setStatus('anonymous');
      } else if (!result.session) {
        await api.get<Session>('/auth/me').then(applySession, () => setStatus('anonymous'));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [applySession]);

  const enter = useCallback(
    (result: AuthResult) => {
      settleSignOut();
      setAccessToken(result.accessToken);
      applySession(result.session);
    },
    [applySession],
  );

  const login = useCallback(
    async (phone: string, password: string): Promise<LoginOutcome> => {
      // First, because a logout arriving after the new cookie would end the new session.
      await deliverSignOut();
      const result = await api.post<AuthResult | TwoFactorChallenge>('/auth/login', { phone, password });
      if ('twoFactorRequired' in result) return { status: 'two-factor', challengeToken: result.challengeToken };
      enter(result);
      return { status: 'ok' };
    },
    [enter],
  );

  const verifyTwoFactor = useCallback(
    async (challengeToken: string, code: string) => {
      const result = await api.post<AuthResult>('/auth/2fa/verify', { challengeToken, code });
      enter(result);
      return result.session;
    },
    [enter],
  );

  /** Over here and now, signal or not. The server hears of it as soon as it can be reached. */
  const logout = useCallback(async () => {
    oweSignOut();
    clear();
    await deliverSignOut();
  }, [clear]);

  const landOnFarm = useCallback(
    (result: AuthResult) => {
      setAccessToken(result.accessToken);
      applySession(result.session);
      // Everything cached belongs to the previous farm, and so does an unanswered save.
      forgetOpenSaves();
      queryClient.clear();
    },
    [applySession],
  );

  const switchFarm = useCallback(
    async (membershipId: string) => landOnFarm(await api.post<AuthResult>('/auth/switch-farm', { membershipId })),
    [landOnFarm],
  );

  const acceptInvitation = useCallback(
    async (id: string) => landOnFarm(await api.post<AuthResult>(`/auth/invitations/${id}/accept`)),
    [landOnFarm],
  );

  const reloadSession = useCallback(async () => {
    applySession(await api.get<Session>('/auth/me'));
  }, [applySession]);

  return useMemo(
    () => ({ status, session, login, verifyTwoFactor, logout, switchFarm, acceptInvitation, reloadSession }),
    [status, session, login, verifyTwoFactor, logout, switchFarm, acceptInvitation, reloadSession],
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const value = useProvideAuth();
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

/** The signed-in session. Only call below RequireAuth. */
export function useSession(): Session {
  const { session } = useAuth();
  if (!session) throw new Error('useSession called without a session');
  return session;
}

/** `(permission) => boolean` for the current user. Prefer usePermission for a single check. */
export function useCan(): (permission: Permission | string) => boolean {
  const { session } = useAuth();
  return useMemo(() => {
    const set = new Set(session?.permissions ?? []);
    return (permission) => set.has(permission);
  }, [session]);
}

export function usePermission(permission: Permission | string): boolean {
  return useCan()(permission);
}

/** Costs of one module: finance.view, or the module's manager, e.g. 'crops.approve'. Mirrors canSeeMoney. */
export function useSeesCost(domain: Permission): boolean {
  const can = useCan();
  return can('finance.view') || can(domain);
}

/** Toggleable modules; these always stay on. */
const CORE_MODULES = new Set(['dashboard', 'tasks', 'users', 'settings', 'audit']);

export function useModuleEnabled(): (module: string) => boolean {
  const { session } = useAuth();
  return useMemo(() => {
    const modules = session?.tenant?.modules;
    return (module) => CORE_MODULES.has(module) || !modules?.length || modules.includes(module);
  }, [session]);
}
