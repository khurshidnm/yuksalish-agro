import { LANDING_LANGUAGES, type LandingCopy, type LandingLanguage, landingCopy } from '@yap/shared/landing';
import {
  ArrowRight,
  ArrowUpRight,
  Banknote,
  BarChart3,
  Bot,
  Boxes,
  Calculator,
  Camera,
  Check,
  ClipboardList,
  CreditCard,
  EyeOff,
  FileWarning,
  Heart,
  History,
  KeyRound,
  ListChecks,
  type LucideIcon,
  Map as MapIcon,
  Menu,
  MessageCircle,
  NotebookPen,
  PackageX,
  PawPrint,
  Phone,
  Plus,
  Send,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Sprout,
  Stethoscope,
  Tractor,
  User,
  Users,
  Warehouse,
  Wheat,
  Wrench,
} from 'lucide-react';
import { LogoMark } from '@/app/Logo';
import { cn } from '@/lib/utils';
import { LeadForm } from './LeadForm';
import { CONTACT_PHONE, CONTACT_TELEGRAM, LANDING_PATHS, LANGUAGE_CODES, LANGUAGE_NAMES, SITE_NAME, telHref } from './site';

/** Product pictures in each language. Uzbek Cyrillic shows the Uzbek pictures. */
const pictures = import.meta.glob('./img/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const picture = (name: string, language: LandingLanguage): string => pictures[`./img/${name}-${language === 'uz-Cyrl' ? 'uz' : language}.webp`];

const MODULE_ICONS: Record<string, LucideIcon> = {
  land: MapIcon,
  crops: Sprout,
  livestock: PawPrint,
  breeding: Heart,
  vet: Stethoscope,
  feed: Wheat,
  inventory: Boxes,
  finance: Banknote,
  costs: Calculator,
  sales: ShoppingCart,
  people: Users,
  machinery: Tractor,
  tasks: ListChecks,
  cameras: Camera,
  reports: BarChart3,
  ai: Bot,
};

const PROBLEM_ICONS: LucideIcon[] = [FileWarning, PackageX, NotebookPen];

const ROLE_ICONS: Record<string, LucideIcon> = {
  owner: User,
  agronomist: Sprout,
  zootechnician: PawPrint,
  veterinarian: Stethoscope,
  storekeeper: Warehouse,
  accountant: CreditCard,
  shepherd: ClipboardList,
  mechanic: Wrench,
};

const TRUST_ICONS: Record<string, LucideIcon> = {
  isolation: ShieldCheck,
  money: EyeOff,
  approval: Check,
  audit: History,
  twofactor: KeyRound,
  ai: Sparkles,
};

const shell = 'mx-auto w-full max-w-7xl px-4 md:px-6';
const accentButton =
  'focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-accent px-5 text-base font-semibold text-accent-foreground transition-colors hover:bg-accent-hover';

function SectionLabel({ label, index }: { label: string; index: number }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border pb-3 text-sm font-medium">
      <span className="flex items-center gap-2">
        <span aria-hidden className="size-2.5 rounded-[3px] bg-accent" />
        {label}
      </span>
      <span aria-hidden className="text-muted-foreground tabular-nums">
        {String(index).padStart(2, '0')}
      </span>
    </div>
  );
}

function Heading({ muted, title, lead }: { muted: string; title: string; lead?: string }) {
  return (
    <div className="mt-6 grid gap-4 md:grid-cols-2 md:items-end md:gap-10">
      <h2 className="text-3xl leading-[1.15] font-semibold tracking-tight break-words md:text-[2.5rem]">
        <span className="block font-normal text-muted-foreground">{muted}</span>
        <span className="block text-heading">{title}</span>
      </h2>
      {lead && <p className="max-w-lg text-muted-foreground md:justify-self-end">{lead}</p>}
    </div>
  );
}

/** Fields seen from the air, drawn with theme tokens: original art, in the product's own colours. */
function FieldArt({ className }: { className?: string }) {
  const parcels: [string, string][] = [
    ['M-20 -20 H420 L360 210 L-20 260Z', 'fill-accent/10'],
    ['M440 -20 H820 L780 170 L380 210Z', 'fill-accent/20'],
    ['M840 -20 H1240 L1190 150 L800 170Z', 'fill-accent/5'],
    ['M1260 -20 H1620 V190 L1210 150Z', 'fill-accent/15'],
    ['M-20 280 L350 232 L300 520 L-20 580Z', 'fill-accent/15'],
    ['M372 230 L772 192 L740 450 L322 516Z', 'fill-accent/5'],
    ['M792 190 L1186 172 L1170 400 L760 448Z', 'fill-accent/25'],
    ['M1206 172 L1620 212 V470 L1190 400Z', 'fill-accent/10'],
    ['M-20 602 L296 542 L262 920 H-20Z', 'fill-accent/5'],
    ['M318 538 L736 472 L700 920 H284Z', 'fill-accent/20'],
    ['M756 470 L1166 422 L1150 920 H722Z', 'fill-accent/10'],
    ['M1186 422 L1620 492 V920 H1172Z', 'fill-accent/5'],
  ];
  return (
    <svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" aria-hidden className={className}>
      {parcels.map(([path, tone]) => (
        <path key={path} d={path} className={cn(tone, 'stroke-accent/25')} strokeWidth={1.5} />
      ))}
    </svg>
  );
}

function Header({ copy, language }: { copy: LandingCopy; language: LandingLanguage }) {
  const links: [string, string][] = [
    ['#features', copy.nav.features],
    ['#product', copy.nav.product],
    ['#how', copy.nav.how],
    ['#faq', copy.nav.faq],
    ['#contact', copy.nav.contact],
  ];
  const languages = (short: boolean) => (
    <ul className="flex flex-wrap items-center gap-0.5" aria-label={copy.nav.language}>
      {LANDING_LANGUAGES.map((code) => (
        <li key={code}>
          <a
            href={LANDING_PATHS[code]}
            hrefLang={code}
            lang={code}
            aria-label={LANGUAGE_NAMES[code]}
            aria-current={code === language ? 'true' : undefined}
            className={cn(
              'focus-ring inline-flex min-h-11 items-center rounded-lg px-2 text-sm whitespace-nowrap hover:bg-muted',
              code === language ? 'bg-muted font-semibold text-heading' : 'text-muted-foreground',
            )}
          >
            {short ? LANGUAGE_CODES[code] : LANGUAGE_NAMES[code]}
          </a>
        </li>
      ))}
    </ul>
  );

  return (
    <header className="sticky top-0 z-30 bg-background/90 backdrop-blur">
      <div className={cn(shell, 'flex h-16 items-center justify-between gap-3')}>
        <a href={LANDING_PATHS[language]} className="focus-ring flex min-h-11 shrink-0 items-center gap-2.5 rounded-lg">
          <LogoMark />
          <span className="font-semibold text-heading">{SITE_NAME}</span>
        </a>

        <nav aria-label={copy.nav.menu} className="hidden items-center gap-1 xl:flex">
          {links.map(([href, label]) => (
            <a key={href} href={href} className="focus-ring inline-flex min-h-9 items-center rounded-lg px-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
              {label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-1">
          <div className="hidden xl:block">{languages(true)}</div>
          <a href="/login" className="focus-ring hidden min-h-11 items-center rounded-lg px-3 text-sm font-medium hover:bg-muted sm:inline-flex">
            {copy.nav.login}
          </a>
          <a href="#contact" className={cn(accentButton, 'hidden min-h-11 text-sm sm:inline-flex')}>
            {copy.nav.cta}
          </a>
          {/* A native disclosure: the menu works before any script has loaded. */}
          <details className="relative xl:hidden">
            <summary aria-label={copy.nav.menu} className="focus-ring flex size-11 cursor-pointer list-none items-center justify-center rounded-lg hover:bg-muted [&::-webkit-details-marker]:hidden">
              <Menu className="size-6" aria-hidden />
            </summary>
            <div className="absolute right-0 mt-2 flex w-64 flex-col gap-1 rounded-xl border border-border bg-popover p-2 shadow-pop">
              {links.map(([href, label]) => (
                <a key={href} href={href} className="focus-ring flex min-h-11 items-center rounded-lg px-3 text-sm font-medium hover:bg-muted">
                  {label}
                </a>
              ))}
              <a href="/login" className="focus-ring flex min-h-11 items-center rounded-lg px-3 text-sm font-medium hover:bg-muted sm:hidden">
                {copy.nav.login}
              </a>
              <div className="mt-1 border-t border-border pt-1">{languages(false)}</div>
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}

function Hero({ copy, language }: { copy: LandingCopy; language: LandingLanguage }) {
  return (
    <section className="px-2 pt-1 md:px-4">
      <div className="relative overflow-hidden rounded-3xl bg-feature text-feature-foreground">
        <FieldArt className="absolute inset-0 size-full" />
        <div aria-hidden className="pointer-events-none absolute inset-3 rounded-2xl border border-feature-foreground/15 md:inset-5" />
        <div className={cn(shell, 'relative grid gap-10 py-14 md:px-12 md:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-center lg:gap-14')}>
          <div>
            <p className="inline-flex items-center gap-2 rounded-full bg-feature-foreground/10 px-3 py-1.5 text-sm font-medium">
              <span aria-hidden className="size-2 rounded-full bg-accent" />
              {copy.hero.eyebrow}
            </p>
            <h1 className="mt-5 text-[2.25rem] leading-[1.1] font-semibold tracking-tight break-words md:text-6xl">
              <span className="block font-normal text-feature-muted">{copy.hero.titleMuted}</span>
              <span className="block">{copy.hero.title}</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg text-feature-muted">{copy.hero.lead}</p>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <a href="#contact" className={accentButton}>
                {copy.hero.cta}
                <ArrowRight className="size-5" aria-hidden />
              </a>
              <a
                href="#features"
                className="focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-feature-foreground/30 px-5 text-base font-medium transition-colors hover:bg-feature-foreground/10"
              >
                {copy.hero.secondary}
              </a>
            </div>
            <ul className="mt-7 flex flex-col gap-2 text-sm sm:flex-row sm:flex-wrap sm:gap-x-5">
              {copy.hero.points.map((point) => (
                <li key={point} className="flex items-center gap-2">
                  <Check className="size-4 shrink-0 text-accent" aria-hidden />
                  {point}
                </li>
              ))}
            </ul>
          </div>

          <div className="relative pr-8 pb-10">
            <img
              src={picture('dashboard', language)}
              alt={copy.hero.imageAlt}
              width={1440}
              height={900}
              fetchPriority="high"
              decoding="async"
              className="w-full rounded-xl shadow-pop ring-1 ring-feature-foreground/20"
            />
            <img
              src={picture('phone', language)}
              alt={copy.hero.phoneAlt}
              width={780}
              height={1560}
              loading="lazy"
              decoding="async"
              className="absolute right-0 bottom-0 w-[23%] max-w-36 rounded-xl shadow-pop ring-4 ring-feature"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function Problem({ copy }: { copy: LandingCopy }) {
  return (
    <section className={cn(shell, 'py-16 md:py-24')}>
      <SectionLabel label={copy.problem.label} index={1} />
      <Heading muted={copy.problem.titleMuted} title={copy.problem.title} lead={copy.problem.lead} />
      <ul className="mt-10 grid gap-4 md:grid-cols-3">
        {copy.problem.items.map((item, index) => {
          const Icon = PROBLEM_ICONS[index];
          return (
            <li key={item.title} className="rounded-2xl bg-muted p-6">
              <span className="flex size-11 items-center justify-center rounded-xl bg-card text-danger shadow-card">
                <Icon className="size-5" aria-hidden />
              </span>
              <h3 className="mt-4 text-lg font-semibold text-heading">{item.title}</h3>
              <p className="mt-2 text-muted-foreground">{item.body}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Modules({ copy }: { copy: LandingCopy }) {
  return (
    <section id="features" className={cn(shell, 'scroll-mt-20 pb-16 md:pb-24')}>
      <SectionLabel label={copy.modules.label} index={2} />
      <Heading muted={copy.modules.titleMuted} title={copy.modules.title} lead={copy.modules.lead} />
      <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {copy.modules.items.map((item) => {
          const Icon = MODULE_ICONS[item.key];
          return (
            <li key={item.key} className="flex flex-col rounded-2xl border border-border bg-card p-5 shadow-card">
              <div className="flex items-center gap-3 sm:block">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
                  <Icon className="size-5" aria-hidden />
                </span>
                <h3 className="text-lg leading-snug font-semibold text-heading sm:mt-4">{item.title}</h3>
              </div>
              <p className="mt-2 text-sm text-muted-foreground sm:mt-1">{item.body}</p>
              <ul className="mt-3 flex flex-col gap-1.5 border-t border-dashed border-border pt-3 text-sm">
                {item.points.map((point) => (
                  <li key={point} className="flex items-start gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-mark" aria-hidden />
                    {point}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Showcase({ copy, language }: { copy: LandingCopy; language: LandingLanguage }) {
  return (
    <section id="product" className="scroll-mt-20 bg-muted py-16 md:py-24">
      <div className={shell}>
        <SectionLabel label={copy.showcase.label} index={3} />
        <Heading muted={copy.showcase.titleMuted} title={copy.showcase.title} lead={copy.showcase.lead} />
        <div className="mt-12 flex flex-col gap-14 md:gap-20">
          {copy.showcase.items.map((item, index) => {
            const phone = item.key === 'phone';
            return (
              <article key={item.key} className="grid items-center gap-8 lg:grid-cols-2 lg:gap-14">
                <div className={cn('min-w-0', index % 2 === 1 && 'lg:order-2')}>
                  <img
                    src={picture(item.key, language)}
                    alt={item.alt}
                    width={phone ? 780 : 1440}
                    height={phone ? 1560 : 900}
                    loading="lazy"
                    decoding="async"
                    className={cn('rounded-2xl bg-card shadow-pop', phone ? 'mx-auto w-64 md:w-72' : 'w-full')}
                  />
                </div>
                <div className={cn('min-w-0', index % 2 === 1 && 'lg:order-1')}>
                  <h3 className="text-2xl font-semibold tracking-tight text-heading md:text-3xl">{item.title}</h3>
                  <p className="mt-3 text-muted-foreground">{item.body}</p>
                  <ul className="mt-5 flex flex-col gap-2">
                    {item.points.map((point) => (
                      <li key={point} className="flex items-start gap-2.5">
                        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
                          <Check className="size-3.5" aria-hidden />
                        </span>
                        {point}
                      </li>
                    ))}
                  </ul>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Roles({ copy }: { copy: LandingCopy }) {
  return (
    <section className={cn(shell, 'py-16 md:py-24')}>
      <SectionLabel label={copy.roles.label} index={4} />
      <Heading muted={copy.roles.titleMuted} title={copy.roles.title} lead={copy.roles.lead} />
      <ul className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {copy.roles.items.map((item) => {
          const Icon = ROLE_ICONS[item.key];
          return (
            <li key={item.key} className="flex items-start gap-3 rounded-xl bg-muted p-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-card text-heading shadow-card">
                <Icon className="size-5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block font-semibold text-heading">{item.title}</span>
                <span className="block text-sm text-muted-foreground">{item.body}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Trust({ copy }: { copy: LandingCopy }) {
  return (
    <section className={cn(shell, 'pb-16 md:pb-24')}>
      <SectionLabel label={copy.trust.label} index={5} />
      <Heading muted={copy.trust.titleMuted} title={copy.trust.title} lead={copy.trust.lead} />
      <ul className="mt-10 grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
        {copy.trust.items.map((item) => {
          const Icon = TRUST_ICONS[item.key];
          return (
            <li key={item.key} className="flex items-start gap-3 border-t border-dashed border-border pt-5">
              <Icon className="mt-0.5 size-5 shrink-0 text-mark" aria-hidden />
              <span className="min-w-0">
                <span className="block font-semibold text-heading">{item.title}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{item.body}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Steps({ copy }: { copy: LandingCopy }) {
  return (
    <section id="how" className={cn(shell, 'scroll-mt-20 pb-16 md:pb-24')}>
      <SectionLabel label={copy.how.label} index={6} />
      <Heading muted={copy.how.titleMuted} title={copy.how.title} lead={copy.how.lead} />
      <ol className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {copy.how.items.map((item, index) => (
          <li key={item.title} className="rounded-2xl bg-muted p-5">
            <span className="flex size-10 items-center justify-center rounded-lg bg-accent font-semibold text-accent-foreground">{index + 1}</span>
            <h3 className="mt-4 text-lg font-semibold text-heading">{item.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{item.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Pilot({ copy }: { copy: LandingCopy }) {
  return (
    <section className="px-2 md:px-4">
      <div className="relative overflow-hidden rounded-3xl bg-feature text-feature-foreground">
        <FieldArt className="absolute inset-0 size-full opacity-60" />
        <div className={cn(shell, 'relative py-14 md:px-12 md:py-20')}>
          <p className="flex items-center gap-2 text-sm font-medium text-feature-muted">
            <span aria-hidden className="size-2.5 rounded-[3px] bg-accent" />
            {copy.pilot.label}
          </p>
          <h2 className="mt-4 max-w-3xl text-3xl leading-tight font-semibold tracking-tight md:text-[2.5rem]">{copy.pilot.title}</h2>
          <p className="mt-3 max-w-2xl text-feature-muted">{copy.pilot.lead}</p>
          <dl className="mt-10 grid grid-cols-2 gap-6 lg:grid-cols-4">
            {copy.pilot.facts.map((fact) => (
              <div key={fact.label} className="flex flex-col-reverse border-t border-feature-foreground/20 pt-4">
                <dt className="mt-1 text-sm text-feature-muted">{fact.label}</dt>
                <dd className="text-3xl font-medium tracking-tight md:text-4xl">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

function Faq({ copy }: { copy: LandingCopy }) {
  return (
    <section id="faq" className={cn(shell, 'scroll-mt-20 py-16 md:py-24')}>
      <SectionLabel label={copy.faq.label} index={7} />
      <Heading muted={copy.faq.titleMuted} title={copy.faq.title} />
      <div className="mt-8 max-w-4xl">
        {copy.faq.items.map((item) => (
          <details key={item.q} className="group border-b border-dashed border-border">
            <summary className="focus-ring flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded py-3 font-medium [&::-webkit-details-marker]:hidden">
              {item.q}
              <Plus className="size-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-45" aria-hidden />
            </summary>
            <p className="pb-4 text-muted-foreground">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function Contact({ copy, language }: { copy: LandingCopy; language: LandingLanguage }) {
  return (
    <section id="contact" className="scroll-mt-20 bg-muted py-16 md:py-24">
      <div className={shell}>
        <SectionLabel label={copy.contact.label} index={8} />
        <div className="mt-8 grid gap-10 lg:grid-cols-2 lg:gap-14">
          <div className="min-w-0">
            <h2 className="text-3xl leading-[1.15] font-semibold tracking-tight md:text-[2.5rem]">
              <span className="block font-normal text-muted-foreground">{copy.contact.titleMuted}</span>
              <span className="block text-heading">{copy.contact.title}</span>
            </h2>
            <p className="mt-4 max-w-lg text-muted-foreground">{copy.contact.lead}</p>
            <ul className="mt-6 flex flex-col gap-2">
              {copy.contact.points.map((point) => (
                <li key={point} className="flex items-start gap-2.5">
                  <Check className="mt-0.5 size-5 shrink-0 text-mark" aria-hidden />
                  {point}
                </li>
              ))}
            </ul>
            {(CONTACT_PHONE || CONTACT_TELEGRAM) && (
              <div className="mt-8 flex flex-col gap-3">
                {CONTACT_PHONE && (
                  <a href={telHref(CONTACT_PHONE)} className="focus-ring flex min-h-16 items-center gap-3 rounded-xl bg-card p-3 shadow-card transition-colors hover:bg-secondary">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                      <Phone className="size-5" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm text-muted-foreground">{copy.contact.phoneLabel}</span>
                      <span className="block text-xl font-semibold text-heading">{CONTACT_PHONE}</span>
                    </span>
                  </a>
                )}
                {CONTACT_TELEGRAM && (
                  <a href={`https://t.me/${CONTACT_TELEGRAM}`} target="_blank" rel="noreferrer" className="focus-ring flex min-h-16 items-center gap-3 rounded-xl bg-card p-3 shadow-card transition-colors hover:bg-secondary">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-info-soft text-info">
                      <Send className="size-5" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm text-muted-foreground">{copy.contact.telegramLabel}</span>
                      <span className="block font-semibold text-heading">@{CONTACT_TELEGRAM}</span>
                    </span>
                    <ArrowUpRight className="ms-auto size-5 shrink-0 text-muted-foreground" aria-hidden />
                  </a>
                )}
              </div>
            )}
          </div>
          <div id="lead-form" data-language={language} data-copy={JSON.stringify(copy.form)} className="relative min-w-0 rounded-2xl border border-border bg-card p-5 shadow-card md:p-7">
            <div data-form>
              <LeadForm copy={copy.form} language={language} phone={CONTACT_PHONE || undefined} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function LandingPage({ language }: { language: LandingLanguage }) {
  const copy = landingCopy[language];
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <a href="#features" className="focus-ring sr-only focus:not-sr-only">
        {copy.nav.features}
      </a>
      <Header copy={copy} language={language} />
      <main>
        <Hero copy={copy} language={language} />
        <Problem copy={copy} />
        <Modules copy={copy} />
        <Showcase copy={copy} language={language} />
        <Roles copy={copy} />
        <Trust copy={copy} />
        <Steps copy={copy} />
        <Pilot copy={copy} />
        <Faq copy={copy} />
        <section className="px-2 pb-6 md:px-4">
          <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-5 rounded-3xl bg-accent p-7 text-accent-foreground md:flex-row md:items-center md:p-10">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">{copy.cta.title}</h2>
              <p className="mt-2">{copy.cta.lead}</p>
            </div>
            <a
              href="#contact"
              className="focus-ring inline-flex min-h-12 shrink-0 items-center gap-2 rounded-lg bg-primary px-5 font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
            >
              <MessageCircle className="size-5" aria-hidden />
              {copy.cta.button}
            </a>
          </div>
        </section>
        <Contact copy={copy} language={language} />
      </main>
      <footer className={cn(shell, 'flex flex-col gap-4 py-8 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between')}>
        <span className="flex items-center gap-2.5">
          <LogoMark className="size-7" />
          <span>
            <span className="font-semibold text-heading">{SITE_NAME}</span> · {copy.footer.tagline}
          </span>
        </span>
        <span>
          © {new Date().getFullYear()} {SITE_NAME}. {copy.footer.rights}
        </span>
      </footer>
    </div>
  );
}
