import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { LogoMark } from '@/app/Logo';
import { TextField } from '@/components/FormField';
import { ErrorCard } from '@/components/ErrorCard';
import { Alert, Button, Card, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth, useSession } from '@/lib/auth';
import { errorMessage } from '@/lib/query';

const schema = z.object({ code: z.string().trim().regex(/^\d{6}$/) });

interface SetupData {
  secret: string;
  otpauthUrl: string;
}

export default function TwoFactorSetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { reloadSession, logout } = useAuth();
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { code: '' } });

  const setup = useQuery({
    queryKey: ['auth', '2fa', 'setup'],
    queryFn: () => api.post<SetupData>('/auth/2fa/setup'),
    // Each call issues a new secret, so one must never replace the code already on screen.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnReconnect: false,
    enabled: !session.user.totpEnabled,
  });

  if (session.user.totpEnabled) return <Navigate to="/" replace />;

  const submit = form.handleSubmit(async ({ code }) => {
    setError(null);
    try {
      await api.post('/auth/2fa/enable', { code });
      await reloadSession();
      toast.success(t('auth:twoFactor.enabled'));
      navigate('/', { replace: true });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  });

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-md p-5">
        <div className="mb-4 flex items-center gap-3">
          <LogoMark />
          <h1 className="text-xl font-semibold tracking-tight">{t('auth:twoFactor.title')}</h1>
        </div>
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
          <Button variant="ghost" onClick={() => void logout()}>
            {t('auth:twoFactor.signOutInstead')}
          </Button>
        </form>
      </Card>
    </main>
  );
}
