import type { Permission } from '@yap/shared';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, refreshSession, setAccessToken, setAuthEvents } from './api';
import { setDefaultCurrency } from './format';
import i18n, { LANGUAGES } from './i18n';
import { queryClient } from './query';
import type { AuthResult, Session, TwoFactorChallenge } from './types';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export type LoginOutcome = { status: 'ok' } | { status: 'two-factor'; challengeToken: string };

interface AuthContextValue {
  status: AuthStatus;
  session: Session | null;
  login(phone: string, password: string): Promise<LoginOutcome>;
  verifyTwoFactor(challengeToken: string, code: string): Promise<void>;
  logout(): Promise<void>;
  switchFarm(membershipId: string): Promise<void>;
  /** Reload the session from the server, e.g. after enabling two-factor. */
  reloadSession(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function useProvideAuth(): AuthContextValue {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const languageApplied = useRef(false);

  const applySession = useCallback((next: Session) => {
    setSession(next);
    setDefaultCurrency(next.tenant?.currency);
    setStatus('authenticated');
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
    setAccessToken(null);
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
    });
  }, [applySession, clear]);

  // Restore the session from the refresh cookie on load. A success arrives through onRefreshed.
  useEffect(() => {
    let cancelled = false;
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

  const login = useCallback(
    async (phone: string, password: string): Promise<LoginOutcome> => {
      const result = await api.post<AuthResult | TwoFactorChallenge>('/auth/login', { phone, password });
      if ('twoFactorRequired' in result) return { status: 'two-factor', challengeToken: result.challengeToken };
      setAccessToken(result.accessToken);
      applySession(result.session);
      return { status: 'ok' };
    },
    [applySession],
  );

  const verifyTwoFactor = useCallback(
    async (challengeToken: string, code: string) => {
      const result = await api.post<AuthResult>('/auth/2fa/verify', { challengeToken, code });
      setAccessToken(result.accessToken);
      applySession(result.session);
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Sign out locally even when the server cannot be reached.
    }
    clear();
  }, [clear]);

  const switchFarm = useCallback(
    async (membershipId: string) => {
      const result = await api.post<AuthResult>('/auth/switch-farm', { membershipId });
      setAccessToken(result.accessToken);
      applySession(result.session);
      // Everything cached belongs to the previous farm.
      queryClient.clear();
    },
    [applySession],
  );

  const reloadSession = useCallback(async () => {
    applySession(await api.get<Session>('/auth/me'));
  }, [applySession]);

  return useMemo(
    () => ({ status, session, login, verifyTwoFactor, logout, switchFarm, reloadSession }),
    [status, session, login, verifyTwoFactor, logout, switchFarm, reloadSession],
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
