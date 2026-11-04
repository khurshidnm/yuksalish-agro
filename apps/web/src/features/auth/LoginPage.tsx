import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { LogoMark } from '@/app/Logo';
import { FormField, TextField } from '@/components/FormField';
import { Alert, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, PasswordInput } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { LANGUAGES, changeLanguage } from '@/lib/i18n';
import { errorMessage } from '@/lib/query';
import { zText } from '@/lib/forms';
import { normalizePhone } from '@/lib/utils';

const passwordSchema = z.object({ phone: zText(32), password: z.string().min(1) });
const codeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/) });

function LanguagePicker() {
  const { i18n } = useTranslation();
  const current = LANGUAGES.find((l) => l.code === i18n.language) ?? LANGUAGES[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          {current.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {LANGUAGES.map((language) => (
          <DropdownMenuItem key={language.code} onSelect={() => changeLanguage(language.code)}>
            {language.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PasswordStep({ onChallenge }: { onChallenge: (token: string) => void }) {
  const { t } = useTranslation();
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(passwordSchema), defaultValues: { phone: '', password: '' } });

  const submit = form.handleSubmit(async ({ phone, password }) => {
    setError(null);
    try {
      const outcome = await login(normalizePhone(phone), password);
      if (outcome.status === 'two-factor') onChallenge(outcome.challengeToken);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  });

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('auth:login.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('auth:login.subtitle')}</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <TextField form={form} name="phone" label={t('auth:login.phone')} type="tel" inputMode="tel" autoComplete="username" placeholder={t('auth:login.phonePlaceholder')} />
      <FormField form={form} name="password" label={t('auth:login.password')}>
        {(field) => <PasswordInput {...field} autoComplete="current-password" value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value)} />}
      </FormField>
      <Button type="submit" size="lg" loading={form.formState.isSubmitting}>
        {t('auth:login.submit')}
      </Button>
    </form>
  );
}

function CodeStep({ challengeToken, onBack }: { challengeToken: string; onBack: () => void }) {
  const { t } = useTranslation();
  const { verifyTwoFactor } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(codeSchema), defaultValues: { code: '' } });

  const submit = form.handleSubmit(async ({ code }) => {
    setError(null);
    try {
      await verifyTwoFactor(challengeToken, code);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  });

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('auth:otp.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('auth:otp.subtitle')}</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <TextField form={form} name="code" label={t('auth:otp.code')} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus />
      <Button type="submit" size="lg" loading={form.formState.isSubmitting}>
        {t('auth:otp.submit')}
      </Button>
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft aria-hidden />
        {t('auth:otp.back')}
      </Button>
    </form>
  );
}

const FIELD_EDGE = 'M0 120 C 200 70 400 170 640 96 V300 H0Z';

/** Rows of a ploughed field running to the horizon, drawn with theme tokens. */
function FieldRows() {
  return (
    <svg viewBox="0 0 640 300" preserveAspectRatio="xMidYMax slice" aria-hidden className="absolute inset-x-0 bottom-0 h-1/2 w-full">
      <defs>
        <clipPath id="field-edge">
          <path d={FIELD_EDGE} />
        </clipPath>
      </defs>
      <path d="M0 60 C 180 16 340 110 640 34 V300 H0Z" className="fill-sidebar-hover" />
      <path d={FIELD_EDGE} className="fill-sidebar-border" />
      <g clipPath="url(#field-edge)" className="stroke-sidebar-active" strokeWidth="2" opacity="0.5">
        {Array.from({ length: 15 }, (_, i) => (
          <line key={i} x1={470} y1={30} x2={-420 + i * 150} y2={300} />
        ))}
      </g>
    </svg>
  );
}

export default function LoginPage() {
  const { t } = useTranslation();
  const [challenge, setChallenge] = useState<string | null>(null);

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <section className="relative hidden flex-col overflow-hidden bg-sidebar p-10 text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-3">
          <LogoMark />
          <span className="text-lg font-semibold">{t('common:app.name')}</span>
        </div>
        <div className="relative z-10 mt-20 max-w-md">
          <p className="text-4xl leading-tight font-semibold tracking-tight">{t('auth:login.brandTitle')}</p>
          <p className="mt-4 text-sidebar-muted">{t('auth:login.brandBody')}</p>
        </div>
        <FieldRows />
      </section>

      <main className="flex flex-col p-4 sm:p-8">
        <div className="flex items-center justify-between lg:justify-end">
          <div className="flex items-center gap-2.5 lg:hidden">
            <LogoMark />
            <span className="font-semibold">{t('common:app.name')}</span>
          </div>
          <LanguagePicker />
        </div>
        <div className="flex flex-1 items-center justify-center py-8">
          <div className="w-full max-w-sm">
            {challenge ? <CodeStep challengeToken={challenge} onBack={() => setChallenge(null)} /> : <PasswordStep onChallenge={setChallenge} />}
          </div>
        </div>
      </main>
    </div>
  );
}
