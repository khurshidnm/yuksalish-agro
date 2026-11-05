import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router';
import { LogoMark } from '@/app/Logo';
import { useSignOut } from '@/app/useSignOut';
import { Alert, Button, Card } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth, useSession } from '@/lib/auth';
import { errorMessage } from '@/lib/query';
import { emptyPasswords, PasswordFields, passwordSchema } from './passwordFields';

/** The stop after signing in with an issued password: nothing else opens until the person has their own. */
export default function ChangePasswordPage() {
  const { t } = useTranslation();
  const { reloadSession } = useAuth();
  const signOut = useSignOut();
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(passwordSchema), defaultValues: emptyPasswords });

  if (!session.mustChangePassword) return <Navigate to="/" replace />;

  const submit = form.handleSubmit(async ({ currentPassword, newPassword }) => {
    setError(null);
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      await reloadSession();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  });

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-md p-5">
        <div className="mb-4 flex items-center gap-3">
          <LogoMark />
          <h1 className="text-xl font-semibold tracking-tight">{t('auth:password.forcedTitle')}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t('auth:password.forcedBody')}</p>
        <form onSubmit={(e) => void submit(e)} noValidate className="mt-4 flex flex-col gap-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <PasswordFields form={form} currentLabel={t('auth:password.forcedCurrent')} />
          <Button type="submit" size="lg" loading={form.formState.isSubmitting}>
            {t('auth:password.forcedSubmit')}
          </Button>
          <Button variant="ghost" onClick={() => void signOut()}>
            {t('auth:twoFactor.signOutInstead')}
          </Button>
        </form>
      </Card>
    </main>
  );
}
