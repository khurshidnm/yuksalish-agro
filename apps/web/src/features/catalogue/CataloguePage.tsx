import { PRODUCT_NAME } from '@yap/shared';
import { latinToCyrillic } from '@yap/shared/i18n';
import { Check, CircleCheck, Loader2, PawPrint, Send } from 'lucide-react';
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { Skeleton } from '@/components/ui';
import { formatMoney, formatQty } from '@/lib/format';
import { LANGUAGES, changeLanguage } from '@/lib/i18n';

/**
 * A farm's public page of animals for sale, outside the signed-in shell. It talks to the server with
 * plain fetch, as the public contact form does: a visitor has no session, and nothing here needs one.
 * Everything shown is what the farm chose to publish; the visitor never sees a tag or an animal's own id.
 */

interface LocalName {
  uz: string;
  ru: string;
  en: string;
}

interface OfferedAnimal {
  /** The listing's id, not the animal's. */
  id: string;
  species: LocalName;
  breed: LocalName | null;
  sex: 'female' | 'male';
  ageMonths: number | null;
  weightKg: number | null;
  photoUrl: string | null;
  /** Null: the farm did not publish a price. */
  price: number | null;
  reserved: boolean;
}

interface Catalogue {
  name: string;
  contact: string | null;
  currency: string;
  animals: OfferedAnimal[];
}

type Page = { state: 'loading' } | { state: 'missing' } | { state: 'failed' } | { state: 'ready'; catalogue: Catalogue };
type Status = 'idle' | 'sending' | 'done';
type FieldName = 'name' | 'phone' | 'consent';

/** The server takes no more in one request. */
const MAX_CHOSEN = 10;
const LOAD_TIMEOUT_MS = 15_000;
const TOKEN_TIMEOUT_MS = 10_000;

const control =
  'focus-ring block min-h-12 w-full rounded-lg border border-input bg-popover px-3 py-2 text-base text-foreground placeholder:text-muted-foreground aria-invalid:border-destructive';

/** The server times the form from this token. Sent before `sendableAt`, a request counts as a bot's. */
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

function LanguageSelect() {
  const { t, i18n } = useTranslation('sales');
  return (
    <select
      aria-label={t('catalogue.public.language')}
      value={i18n.language}
      onChange={(event) => changeLanguage(event.target.value)}
      className="focus-ring min-h-11 shrink-0 rounded-lg border border-input bg-popover px-2 text-sm text-foreground"
    >
      {LANGUAGES.map((language) => (
        <option key={language.code} value={language.code}>
          {language.label}
        </option>
      ))}
    </select>
  );
}

function Message({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-4 py-12 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <PawPrint className="size-7" aria-hidden />
      </span>
      <p className="text-lg font-semibold text-heading">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      {action}
    </div>
  );
}

export default function CataloguePage() {
  const { slug = '' } = useParams();
  const { t, i18n } = useTranslation('sales');
  const [page, setPage] = useState<Page>({ state: 'loading' });
  const [chosen, setChosen] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setPage({ state: 'loading' });
      try {
        const response = await fetch(`/api/v1/sales/catalogue/pages/${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(LOAD_TIMEOUT_MS) });
        if (response.status === 404) return setPage({ state: 'missing' });
        if (!response.ok) return setPage({ state: 'failed' });
        const { data } = (await response.json()) as { data: Catalogue };
        setPage({ state: 'ready', catalogue: data });
        // An animal taken off the page, or reserved meanwhile, cannot stay chosen.
        setChosen((ids) => ids.filter((id) => data.animals.some((animal) => animal.id === id && !animal.reserved)));
      } catch {
        setPage({ state: 'failed' });
      }
    },
    [slug],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const farmName = page.state === 'ready' ? page.catalogue.name : null;
  useEffect(() => {
    if (!farmName) return;
    const before = document.title;
    document.title = `${farmName} · ${t('catalogue.public.title')}`;
    return () => {
      document.title = before;
    };
  }, [farmName, t]);

  const localName = (name: LocalName) => {
    if (i18n.language === 'uz-Cyrl') return latinToCyrillic(name.uz);
    return name[i18n.language as keyof LocalName] ?? name.uz;
  };
  const ageText = (months: number | null) => {
    if (months === null) return '—';
    const years = Math.floor(months / 12);
    const rest = months % 12;
    if (years === 0) return t('livestock:age.months', { months });
    return rest === 0 ? t('livestock:age.years', { years }) : t('livestock:age.yearsMonths', { years, months: rest });
  };

  const toggle = (id: string) => {
    setNotice(null);
    setChosen((ids) => {
      if (ids.includes(id)) return ids.filter((other) => other !== id);
      if (ids.length >= MAX_CHOSEN) {
        setNotice(t('catalogue.public.tooMany', { max: MAX_CHOSEN }));
        return ids;
      }
      return [...ids, id];
    });
  };

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-heading">{farmName ?? t('catalogue.public.title')}</p>
            {farmName && <p className="text-sm text-muted-foreground">{t('catalogue.public.title')}</p>}
          </div>
          <LanguageSelect />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6">
        {page.state === 'loading' && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((n) => (
              <Skeleton key={n} className="h-72 w-full rounded-xl" />
            ))}
          </div>
        )}

        {page.state === 'missing' && <Message title={t('catalogue.public.notFoundTitle')} body={t('catalogue.public.notFoundBody')} />}

        {page.state === 'failed' && (
          <Message
            title={t('catalogue.public.errorTitle')}
            body={t('catalogue.public.errorGeneric')}
            action={
              <button
                type="button"
                onClick={() => void load()}
                className="focus-ring inline-flex min-h-11 items-center rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
              >
                {t('catalogue.public.retry')}
              </button>
            }
          />
        )}

        {page.state === 'ready' && (
          <>
            <p className="text-muted-foreground">{t('catalogue.public.intro')}</p>

            {page.catalogue.animals.length === 0 ? (
              <Message title={t('catalogue.public.emptyTitle')} body={t('catalogue.public.emptyBody')} />
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {page.catalogue.animals.map((animal) => {
                  const picked = chosen.includes(animal.id);
                  const species = localName(animal.species);
                  return (
                    <li key={animal.id} className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
                      <div className="flex aspect-[4/3] items-center justify-center bg-muted text-muted-foreground">
                        {animal.photoUrl ? (
                          <img src={animal.photoUrl} alt={t('catalogue.public.photoAlt', { species })} loading="lazy" className="size-full object-cover" />
                        ) : (
                          <PawPrint className="size-10" aria-hidden />
                        )}
                      </div>
                      <div className="flex flex-1 flex-col gap-3 p-4">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-semibold break-words text-heading">{animal.breed ? localName(animal.breed) : species}</p>
                            <p className="text-sm text-muted-foreground">
                              {animal.breed ? `${species} · ` : ''}
                              {t(`enums:sex.${animal.sex}`)}
                            </p>
                          </div>
                          {animal.reserved && (
                            <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">{t('catalogue.public.reserved')}</span>
                          )}
                        </div>
                        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                          <div>
                            <dt className="text-muted-foreground">{t('catalogue.public.age')}</dt>
                            <dd className="font-medium">{ageText(animal.ageMonths)}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">{t('catalogue.public.weight')}</dt>
                            <dd className="font-medium tabular-nums">{formatQty(animal.weightKg, 'kg', 1)}</dd>
                          </div>
                          <div className="col-span-2">
                            <dt className="text-muted-foreground">{t('catalogue.public.price')}</dt>
                            <dd className="font-medium tabular-nums">
                              {animal.price === null ? t('catalogue.public.askPrice') : formatMoney(animal.price, { currency: page.catalogue.currency })}
                            </dd>
                          </div>
                        </dl>
                        {!animal.reserved && (
                          <button
                            type="button"
                            aria-pressed={picked}
                            onClick={() => toggle(animal.id)}
                            className={`focus-ring mt-auto inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border px-4 text-base font-semibold transition-colors ${
                              picked ? 'border-primary bg-primary text-primary-foreground hover:bg-primary-hover' : 'border-input bg-popover text-foreground hover:bg-muted'
                            }`}
                          >
                            {picked && <Check className="size-5" aria-hidden />}
                            {picked ? t('catalogue.public.chosen') : t('catalogue.public.choose')}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {notice && (
              <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">
                {notice}
              </p>
            )}

            <section className="rounded-xl border border-border bg-card p-4 sm:p-6">
              <RequestForm slug={slug} chosen={chosen} onSent={() => setChosen([])} onUnavailable={() => void load(true)} />
            </section>

            {page.catalogue.contact && (
              <p className="text-sm break-words text-muted-foreground">
                <span className="font-medium text-foreground">{t('catalogue.public.contact')}:</span> {page.catalogue.contact}
              </p>
            )}
          </>
        )}
      </main>

      <footer className="mx-auto w-full max-w-5xl px-4 pb-8 text-xs text-muted-foreground">{t('catalogue.public.madeWith', { product: PRODUCT_NAME })}</footer>
    </div>
  );
}

interface RequestFormProps {
  slug: string;
  /** Listing ids the visitor chose. */
  chosen: string[];
  onSent: () => void;
  /** A chosen animal went meanwhile: the list is read again. */
  onUnavailable: () => void;
}

/** The pre-order. The same protection as the public contact form: a timed token, a trap field, plain text only. */
function RequestForm({ slug, chosen, onSent, onUnavailable }: RequestFormProps) {
  const { t, i18n } = useTranslation('sales');
  const stamp = useRef<Promise<FormStamp | null> | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const copy = (key: string, options?: Record<string, unknown>) => t(`catalogue.public.${key}`, options);

  useEffect(() => {
    stamp.current = fetchStamp();
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = (name: string) => String(data.get(name) ?? '').trim();

    const found: typeof errors = {};
    if (value('name').length < 2) found.name = copy('errorName');
    if (value('phone').replace(/\D/g, '').length < 9) found.phone = copy('errorPhone');
    if (data.get('consent') !== 'on') found.consent = copy('errorConsent');
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;
    if (chosen.length === 0 && !value('wanted')) return setFailure(copy('errorEmpty'));

    setStatus('sending');
    const request = {
      name: value('name'),
      phone: value('phone'),
      animals: chosen,
      ...(value('wanted') ? { wanted: value('wanted') } : {}),
      ...(value('note') ? { note: value('note') } : {}),
      language: i18n.language,
      consent: true,
      website: value('website'),
    };
    const send = async () => {
      const held = await stamp.current;
      if (held) await wait(held.sendableAt - Date.now());
      return fetch(`/api/v1/sales/catalogue/pages/${encodeURIComponent(slug)}/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, formToken: held?.token }),
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
        // The token is spent: the next request needs its own.
        stamp.current = fetchStamp();
        onSent();
        setStatus('done');
        return;
      }
      if (code === 'INVALID_PHONE') setErrors({ phone: copy('errorPhone') });
      else if (code === 'CATALOGUE_REQUEST_EMPTY') setFailure(copy('errorEmpty'));
      else if (code === 'CATALOGUE_ANIMAL_UNAVAILABLE') {
        setFailure(copy('errorUnavailable'));
        onUnavailable();
      } else setFailure(copy(response.status === 429 ? 'errorRate' : 'errorGeneric'));
    } catch {
      setFailure(copy('errorGeneric'));
    }
    setStatus('idle');
  };

  if (status === 'done') {
    return (
      <div role="status" className="flex flex-col items-center gap-3 py-8 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
          <CircleCheck className="size-7" aria-hidden />
        </span>
        <p className="text-xl font-semibold text-heading">{copy('successTitle')}</p>
        <p className="text-muted-foreground">{copy('successBody')}</p>
        <button type="button" onClick={() => setStatus('idle')} className="focus-ring mt-2 min-h-11 rounded-lg px-3 text-sm font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground">
          {copy('again')}
        </button>
      </div>
    );
  }

  const sending = status === 'sending';
  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="relative flex flex-col gap-4">
      <div>
        <p className="text-xl font-semibold text-heading">{copy('formTitle')}</p>
        {chosen.length > 0 && <p className="mt-1 text-sm text-muted-foreground">{copy('chosenCount', { count: chosen.length })}</p>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="request-name" label={copy('name')} error={errors.name}>
          <input
            id="request-name"
            name="name"
            autoComplete="name"
            maxLength={120}
            aria-required
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? 'request-name-error' : undefined}
            className={control}
          />
        </Field>
        <Field id="request-phone" label={copy('phone')} error={errors.phone}>
          <input
            id="request-phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            maxLength={24}
            placeholder={copy('phonePlaceholder')}
            aria-required
            aria-invalid={Boolean(errors.phone)}
            aria-describedby={errors.phone ? 'request-phone-error' : undefined}
            className={control}
          />
        </Field>
      </div>

      <Field id="request-wanted" label={copy('wanted')} hint={chosen.length > 0 ? copy('optional') : undefined}>
        <textarea id="request-wanted" name="wanted" rows={2} maxLength={500} placeholder={copy('wantedPlaceholder')} className={control} />
      </Field>

      <Field id="request-note" label={copy('note')} hint={copy('optional')}>
        <textarea id="request-note" name="note" rows={2} maxLength={1000} className={control} />
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
          <input type="checkbox" name="consent" aria-required aria-invalid={Boolean(errors.consent)} className="focus-ring mt-0.5 size-5 shrink-0 accent-primary" />
          <span>{copy('consent')}</span>
        </label>
        {errors.consent && <p className="mt-1 text-sm text-danger">{errors.consent}</p>}
      </div>

      {failure && (
        <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">
          {failure}
        </p>
      )}

      <button
        type="submit"
        disabled={sending}
        className="focus-ring inline-flex min-h-13 w-full items-center justify-center gap-2 rounded-lg bg-primary px-6 text-base font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
      >
        {sending ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Send className="size-5" aria-hidden />}
        {sending ? copy('sending') : copy('submit')}
      </button>
    </form>
  );
}
