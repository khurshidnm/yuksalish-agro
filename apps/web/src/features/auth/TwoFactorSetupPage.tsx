import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { type ReactNode, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { LogoMark } from '@/app/Logo';
import { TextField } from '@/components/FormField';
import { ErrorCard } from '@/components/ErrorCard';
import { Alert, Button, Card, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useSignOut } from '@/app/useSignOut';
import { useAuth, useSession } from '@/lib/auth';
import { errorMessage } from '@/lib/query';
import type { RecoveryCodesResult } from '@/lib/types';
import { RecoveryCodes } from './RecoveryCodes';

const schema = z.object({ code: z.string().trim().regex(/^\d{6}$/) });
const anyCodeSchema = z.object({ code: z.string().trim().min(6).max(32) });

interface SetupData {
  secret: string;
  otpauthUrl: string;
}

function Screen({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-md p-5">
        <div className="mb-4 flex items-center gap-3">
          <LogoMark />
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        </div>
        {children}
      </Card>
    </main>
  );
}

/** Proof comes first. Once it is accepted the old authenticator is gone, and the page below takes over. */
function ReplaceStep() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { reloadSession } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(anyCodeSchema), defaultValues: { code: '' } });

  const submit = form.handleSubmit(async ({ code }) => {
    setError(null);
    try {
      await api.post('/auth/2fa/replace', { code });
      await reloadSession();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  });

  return (
    <Screen title={t('auth:twoFactor.replace')}>
      <p className="text-sm text-muted-foreground">{t('auth:twoFactor.replaceBody')}</p>
      <form onSubmit={(e) => void submit(e)} noValidate className="mt-4 flex flex-col gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <TextField form={form} name="code" label={t('auth:twoFactor.replaceCode')} autoComplete="one-time-code" maxLength={32} autoFocus />
        <Button type="submit" size="lg" loading={form.formState.isSubmitting}>
          {t('auth:twoFactor.recoveryContinue')}
        </Button>
        <Button variant="ghost" onClick={() => navigate('/', { replace: true })}>
          {t('auth:twoFactor.later')}
        </Button>
      </form>
    </Screen>
  );
}

export default function TwoFactorSetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { reloadSession } = useAuth();
  const signOut = useSignOut();
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  // Held here and not read from the session, which a background refresh can replace while they are on screen.
  const [codes, setCodes] = useState<string[] | null>(null);
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { code: '' } });

  const setup = useQuery({
    queryKey: ['auth', '2fa', 'setup'],
    queryFn: () => api.post<SetupData>('/auth/2fa/setup'),
    // The server answers with the same secret until 2FA is on, so a reload or retry is safe. gcTime keeps it out of memory after this page.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnReconnect: false,
    enabled: !session.user.totpEnabled,
  });

  const copyKey = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      toast.success(t('auth:twoFactor.recoveryCopied'));
    } catch {
      toast.error(t('auth:twoFactor.keyCopyFailed'));
    }
  };

  const finish = async () => {
    await reloadSession();
    toast.success(t('auth:twoFactor.enabled'));
    navigate('/', { replace: true });
  };

  if (codes) {
    return (
      <Screen title={t('auth:twoFactor.recoveryTitle')}>
        <RecoveryCodes codes={codes} onDone={() => void finish()} />
      </Screen>
    );
  }
  if (session.user.totpEnabled) return params.has('replace') ? <ReplaceStep /> : <Navigate to="/" replace />;

  const submit = form.handleSubmit(async ({ code }) => {
    setError(null);
    try {
      const result = await api.post<RecoveryCodesResult>('/auth/2fa/enable', { code });
      setCodes(result.recoveryCodes);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  });

  return (
    <Screen title={t('auth:twoFactor.title')}>
      <p className="text-sm text-muted-foreground">{t('auth:twoFactor.intro')}</p>
      {session.mustEnroll2fa && (
        <Alert tone="warning" className="mt-3">
          {t('auth:twoFactor.required')}
        </Alert>
      )}

      {setup.isError ? (
        <ErrorCard error={setup.error} title={t('auth:twoFactor.setupFailed')} onRetry={() => void setup.refetch()} className="mt-4 border-0 shadow-none" />
      ) : (
        <ol className="mt-4 flex list-decimal flex-col gap-3 pl-5 text-sm">
          <li>{t('auth:twoFactor.step1')}</li>
          <li>
            {t('auth:twoFactor.step2')}
            <div className="mt-2 flex justify-center">
              {setup.data ? (
                // The QR code needs its light background in both themes, or scanners fail.
                <div className="rounded-lg bg-white p-3">
                  <QRCodeSVG value={setup.data.otpauthUrl} size={176} />
                </div>
              ) : (
                <Skeleton className="size-[200px]" />
              )}
            </div>
            {setup.data && (
              <div className="mt-2">
                <p className="text-muted-foreground">{t('auth:twoFactor.manual')}</p>
                <code className="mt-1 block rounded-md bg-muted px-2 py-1.5 text-sm break-all select-all">{setup.data.secret}</code>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Button variant="outline" className="min-h-11" onClick={() => void copyKey(setup.data.secret)}>
                    {t('auth:twoFactor.recoveryCopy')}
                  </Button>
                  {/* Someone enrolling on this same phone cannot scan its own screen. */}
                  <Button variant="outline" className="min-h-11" asChild>
                    <a href={setup.data.otpauthUrl}>{t('auth:twoFactor.openApp')}</a>
                  </Button>
                </div>
              </div>
            )}
          </li>
          <li>{t('auth:twoFactor.step3')}</li>
        </ol>
      )}

      <form onSubmit={(e) => void submit(e)} noValidate className="mt-4 flex flex-col gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <TextField form={form} name="code" label={t('auth:twoFactor.code')} inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
        <Button type="submit" size="lg" loading={form.formState.isSubmitting} disabled={!setup.data}>
          {t('auth:twoFactor.enable')}
        </Button>
        <Button variant="ghost" onClick={() => void signOut()}>
          {t('auth:twoFactor.signOutInstead')}
        </Button>
      </form>
    </Screen>
  );
}
