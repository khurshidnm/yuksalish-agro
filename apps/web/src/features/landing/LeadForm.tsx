import type { LandingCopy, LandingLanguage } from '@yap/shared/landing';
import { CircleCheck, Loader2, Send } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { telHref } from './site';

type Status = 'idle' | 'sending' | 'done';
type FieldName = 'fullName' | 'phone' | 'consent';

/** Fixed, not useId(): the page has one form, and these must match the prerendered markup. */
const id = 'lead';

const FARM_TYPES = ['livestock', 'crops', 'mixed', 'other'] as const;

const control =
  'focus-ring block min-h-12 w-full rounded-lg border border-input bg-popover px-3 py-2 text-base text-foreground placeholder:text-muted-foreground aria-invalid:border-destructive';

const TOKEN_TIMEOUT_MS = 10_000;

/** The server times the form from this token. Sent before `sendableAt`, an enquiry counts as a bot's. */
interface FormStamp {
  token: string;
  sendableAt: number;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchStamp(): Promise<FormStamp | null> {
  try {
    const response = await fetch('/api/v1/leads/form-token', { signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
    if (!response.ok) return null;
    const { data } = (await response.json()) as { data: { token: string; waitMs: number } };
    return { token: data.token, sendableAt: Date.now() + data.waitMs };
  } catch {
    return null;
  }
}

const errorCode = async (response: Response) => ((await response.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code;

function campaign(): Record<string, string> | undefined {
  const entries = [...new URLSearchParams(window.location.search)].filter(([name]) => name.startsWith('utm_')).slice(0, 8);
  return entries.length > 0 ? Object.fromEntries(entries.map(([name, value]) => [name.slice(0, 40), value.slice(0, 200)])) : undefined;
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
        {hint && <span className="font-normal text-muted-foreground"> ({hint})</span>}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The only interactive part of the public page, hydrated on its own. It stays free of the app's form
 * libraries and API client so that a visitor on a slow rural connection downloads almost nothing.
 */
export function LeadForm({ copy, language, phone }: { copy: LandingCopy['form']; language: LandingLanguage; phone?: string }) {
  const stamp = useRef<Promise<FormStamp | null> | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    stamp.current = fetchStamp();
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = (name: string) => String(data.get(name) ?? '').trim();

    const found: typeof errors = {};
    if (value('fullName').length < 2) found.fullName = copy.errorName;
    if (value('phone').replace(/\D/g, '').length < 9) found.phone = copy.errorPhone;
    if (data.get('consent') !== 'on') found.consent = copy.errorConsent;
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;

    setStatus('sending');
    const optional = Object.fromEntries(['farmType', 'farmSize', 'region', 'message'].flatMap((name) => (value(name) ? [[name, value(name)]] : [])));
    const enquiry = {
      fullName: value('fullName'),
      phone: value('phone'),
      ...optional,
      language,
      source: window.location.pathname,
      utm: campaign(),
      consent: true,
      website: value('website'),
    };
    const send = async () => {
      const held = await stamp.current;
      if (held) await wait(held.sendableAt - Date.now());
      return fetch('/api/v1/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...enquiry, formToken: held?.token }),
      });
    };
    try {
      let response = await send();
      let code = response.ok ? undefined : await errorCode(response);
      // A tab left open for hours, or a token that could not be fetched when the page loaded.
      if (code === 'FORM_EXPIRED') {
        stamp.current = fetchStamp();
        response = await send();
        code = response.ok ? undefined : await errorCode(response);
      }
      if (response.ok) {
        form.reset();
        setStatus('done');
        return;
      }
      if (code === 'INVALID_PHONE') setErrors({ phone: copy.errorPhone });
      else setFailure(response.status === 429 ? copy.errorRate : copy.errorGeneric);
    } catch {
      setFailure(copy.errorGeneric);
    }
    setStatus('idle');
  };

  if (status === 'done') {
    return (
      <div role="status" className="flex flex-col items-center gap-3 py-10 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
          <CircleCheck className="size-7" aria-hidden />
        </span>
        <p className="text-xl font-semibold text-heading">{copy.successTitle}</p>
        <p className="text-muted-foreground">{copy.successBody}</p>
        <button type="button" onClick={() => setStatus('idle')} className="focus-ring mt-2 min-h-11 rounded-lg px-3 text-sm font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground">
          {copy.again}
        </button>
      </div>
    );
  }

  const sending = status === 'sending';
  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
      <p className="text-xl font-semibold text-heading">{copy.title}</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${id}-name`} label={copy.name} error={errors.fullName}>
          <input
            id={`${id}-name`}
            name="fullName"
            autoComplete="name"
            maxLength={120}
            placeholder={copy.namePlaceholder}
            aria-required
            aria-invalid={Boolean(errors.fullName)}
            aria-describedby={errors.fullName ? `${id}-name-error` : undefined}
            className={control}
          />
        </Field>
        <Field id={`${id}-phone`} label={copy.phone} error={errors.phone}>
          <input
            id={`${id}-phone`}
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            maxLength={24}
            placeholder={copy.phonePlaceholder}
            aria-required
            aria-invalid={Boolean(errors.phone)}
            aria-describedby={errors.phone ? `${id}-phone-error` : undefined}
            className={control}
          />
        </Field>
      </div>

      {/* Bottom-aligned, so a label that wraps in one language does not push its control below the other. These two never show an error. */}
      <div className="grid gap-4 sm:grid-cols-2 sm:items-end">
        <Field id={`${id}-type`} label={copy.farmType} hint={copy.optional}>
          <select id={`${id}-type`} name="farmType" defaultValue="" className={control}>
            <option value="">{copy.farmTypePlaceholder}</option>
            {FARM_TYPES.map((type) => (
              <option key={type} value={type}>
                {copy.types[type]}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${id}-size`} label={copy.size} hint={copy.optional}>
          <input id={`${id}-size`} name="farmSize" maxLength={120} placeholder={copy.sizePlaceholder} className={control} />
        </Field>
      </div>

      <Field id={`${id}-region`} label={copy.region} hint={copy.optional}>
        <input id={`${id}-region`} name="region" autoComplete="address-level1" maxLength={120} placeholder={copy.regionPlaceholder} className={control} />
      </Field>

      <Field id={`${id}-message`} label={copy.message} hint={copy.optional}>
        <textarea id={`${id}-message`} name="message" rows={3} maxLength={2000} placeholder={copy.messagePlaceholder} className={control} />
      </Field>

      {/* A trap: out of sight for people and screen readers, irresistible to form-filling bots. */}
      <div aria-hidden className="absolute -left-[9999px] size-px overflow-hidden">
        <label>
          Website
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <div>
        <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            name="consent"
            aria-required
            aria-invalid={Boolean(errors.consent)}
            className="focus-ring mt-0.5 size-5 shrink-0 accent-primary"
          />
          <span>{copy.consent}</span>
        </label>
        {errors.consent && <p className="mt-1 text-sm text-danger">{errors.consent}</p>}
      </div>

      {failure && (
        <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">
          {failure}
          {/* Only a build with a published number offers to call. */}
          {phone && (
            <>
              {` ${copy.errorCall} `}
              <a href={telHref(phone)} className="font-semibold underline underline-offset-2">
                {phone}
              </a>
            </>
          )}
        </p>
      )}

      <button
        type="submit"
        disabled={sending}
        className="focus-ring inline-flex min-h-13 w-full items-center justify-center gap-2 rounded-lg bg-primary px-6 text-base font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
      >
        {sending ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Send className="size-5" aria-hidden />}
        {sending ? copy.sending : copy.submit}
      </button>
    </form>
  );
}
