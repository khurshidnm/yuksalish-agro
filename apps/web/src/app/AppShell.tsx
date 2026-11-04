import { Bell, ChevronDown, Check, KeyRound, Languages, LogOut, Menu, Moon, Sun, User, WifiOff } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet, ScrollRestoration, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui';
import { ChangePasswordDialog } from '@/features/auth/ChangePasswordDialog';
import { ProfileDialog } from '@/features/auth/ProfileDialog';
import { OutboxBar } from '@/features/today/OutboxBar';
import { api } from '@/lib/api';
import { useAuth, useSession } from '@/lib/auth';
import { LANGUAGES, changeLanguage } from '@/lib/i18n';
import { errorMessage } from '@/lib/query';
import { cn, storageGet, storageSet } from '@/lib/utils';
import { LogoMark } from './Logo';
import type { NavItem, NavSection } from './nav';
import { PageSkeleton } from './pages';
import { useTheme } from './theme';
import { useVisibleNav } from './useNav';

const SECTIONS_KEY = 'yap.nav.open';

function isActive(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/';
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** The most specific menu entry for this URL, so /farm/map does not also light up /farm. */
function activeItem(sections: NavSection[], pathname: string): NavItem | undefined {
  return sections
    .flatMap((section) => section.items)
    .filter((item) => isActive(pathname, item.to))
    .sort((a, b) => b.to.length - a.to.length)[0];
}

function readOpenSections(): string[] {
  try {
    const parsed: unknown = JSON.parse(storageGet(SECTIONS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function NavEntry({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate?: () => void }) {
  const { t } = useTranslation();
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'focus-ring flex min-h-11 items-center gap-3 rounded-lg px-3 py-1.5 text-sm leading-tight font-medium transition-colors lg:min-h-9',
        active ? 'bg-sidebar-active text-sidebar-active-foreground' : 'text-sidebar-foreground hover:bg-sidebar-hover',
      )}
    >
      <item.icon className="size-4.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{t(`nav:item.${item.key}`)}</span>
    </NavLink>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const { sections } = useVisibleNav();
  const { pathname } = useLocation();
  const [open, setOpen] = useState<string[]>(readOpenSections);
  const current = useMemo(() => activeItem(sections, pathname), [sections, pathname]);
  const currentSection = sections.find((section) => section.items.includes(current as NavItem))?.key;

  const toggle = (key: string, next: boolean) => {
    setOpen((prev) => {
      const updated = next ? [...new Set([...prev, key])] : prev.filter((k) => k !== key);
      storageSet(SECTIONS_KEY, JSON.stringify(updated));
      return updated;
    });
  };

  return (
    <nav aria-label={t('nav:shell.mainNav')} className="flex flex-col gap-1 p-3">
      {sections.map((section) => {
        // The overview group, and any group of one, is always shown flat: fewer taps.
        if (section.key === 'overview' || section.items.length === 1) {
          return (
            <div key={section.key} className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <NavEntry key={item.key} item={item} active={item === current} onNavigate={onNavigate} />
              ))}
            </div>
          );
        }
        const expanded = open.includes(section.key) || section.key === currentSection;
        const label = t(`nav:section.${section.key}`);
        return (
          <Collapsible.Root key={section.key} open={expanded} onOpenChange={(next) => toggle(section.key, next)}>
            <Collapsible.Trigger
              aria-label={t('nav:shell.toggleSection', { section: label })}
              className="focus-ring flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-foreground lg:min-h-9"
            >
              <section.icon className="size-4.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 text-left leading-tight break-words">{label}</span>
              <ChevronDown className={cn('size-4 shrink-0 transition-transform', expanded && 'rotate-180')} aria-hidden />
            </Collapsible.Trigger>
            <Collapsible.Content className="data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden">
              <div className="mt-0.5 ml-5 flex flex-col gap-0.5 border-l border-sidebar-border pl-2">
                {section.items.map((item) => (
                  <NavEntry key={item.key} item={item} active={item === current} onNavigate={onNavigate} />
                ))}
              </div>
            </Collapsible.Content>
          </Collapsible.Root>
        );
      })}
    </nav>
  );
}

function Brand() {
  const { t } = useTranslation();
  return (
    <Link to="/" className="focus-ring flex min-h-11 items-center gap-2.5 rounded-lg">
      <LogoMark />
      <span className="min-w-0 leading-tight">
        <span className="block truncate font-semibold text-sidebar-foreground">{t('common:app.name')}</span>
        <span className="block truncate text-xs text-sidebar-muted">{t('common:app.tagline')}</span>
      </span>
    </Link>
  );
}

function Sidebar() {
  return (
    <aside data-app-chrome className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col bg-sidebar lg:flex">
      <div className="border-b border-sidebar-border p-3">
        <Brand />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SidebarContent />
      </div>
    </aside>
  );
}

function MobileDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="border-sidebar-border bg-sidebar text-sidebar-foreground [&>button]:text-sidebar-muted [&>button]:hover:bg-sidebar-hover [&>button]:hover:text-sidebar-foreground">
        <SheetTitle className="sr-only">{t('nav:shell.menu')}</SheetTitle>
        <SheetDescription className="sr-only">{t('nav:shell.mainNav')}</SheetDescription>
        <div className="border-b border-sidebar-border p-3 pr-14">
          <Brand />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
          <SidebarContent onNavigate={() => onOpenChange(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function BottomNav({ onMenu }: { onMenu: () => void }) {
  const { t } = useTranslation();
  const { sections, bottom } = useVisibleNav();
  const { pathname } = useLocation();
  const current = activeItem(sections, pathname);

  const itemClass = 'focus-ring flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[0.6875rem] leading-tight font-medium';

  return (
    <nav
      data-bottom-nav
      data-app-chrome
      aria-label={t('nav:shell.bottomNav')}
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-card pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {bottom.map((item) => {
        const active = item === current;
        return (
          <Link key={item.key} to={item.to} aria-current={active ? 'page' : undefined} className={cn(itemClass, active ? 'text-primary' : 'text-muted-foreground')}>
            <item.icon className="size-6 shrink-0" aria-hidden />
            <span className="w-full truncate text-center">{t([`nav:short.${item.key}`, `nav:item.${item.key}`])}</span>
          </Link>
        );
      })}
      <button type="button" onClick={onMenu} className={cn(itemClass, 'text-muted-foreground')}>
        <Menu className="size-6 shrink-0" aria-hidden />
        <span>{t('nav:shell.menu')}</span>
      </button>
    </nav>
  );
}

function FarmSwitcher() {
  const { t } = useTranslation();
  const { switchFarm } = useAuth();
  const session = useSession();
  const memberships = session.memberships;
  const current = memberships.find((m) => m.farmId === session.farm?.id && m.tenantId === session.tenant?.id);
  const name = session.farm?.name ?? session.tenant?.name ?? t('common:app.name');

  if (memberships.length <= 1) {
    return <p className="min-w-0 truncate text-sm font-semibold">{name}</p>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('nav:shell.switchFarm')}
          className="focus-ring flex min-h-11 min-w-0 items-center gap-1 rounded-lg px-2 text-sm font-semibold hover:bg-muted"
        >
          <span className="truncate">{name}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[min(20rem,calc(100vw-2rem))]">
        <DropdownMenuLabel>{t('nav:shell.farms')}</DropdownMenuLabel>
        {memberships.map((m) => (
          <DropdownMenuItem
            key={m.id}
            onSelect={() => {
              if (m.id === current?.id) return;
              switchFarm(m.id).catch((error: unknown) => toast.error(errorMessage(error)));
            }}
          >
            <Check className={cn(m.id === current?.id ? 'opacity-100' : 'opacity-0')} aria-hidden />
            <span className="min-w-0">
              <span className="block truncate">{m.farmName}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {m.tenantName} · {t(`enums:role.${m.roleKey}`, { defaultValue: m.roleName })}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LanguageItems() {
  const { i18n } = useTranslation();
  return LANGUAGES.map((language) => (
    <DropdownMenuItem key={language.code} onSelect={() => changeLanguage(language.code)}>
      <Check className={cn(i18n.language === language.code ? 'opacity-100' : 'opacity-0')} aria-hidden />
      {language.label}
    </DropdownMenuItem>
  ));
}

function LanguageMenu() {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('common:language.label')}>
          <Languages aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <LanguageItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeButton() {
  const { t } = useTranslation();
  const { resolved, toggle } = useTheme();
  return (
    <Button variant="ghost" size="icon" aria-label={t('common:theme.toggle')} onClick={toggle}>
      {resolved === 'dark' ? <Sun aria-hidden /> : <Moon aria-hidden />}
    </Button>
  );
}

function NotificationBell() {
  const { t } = useTranslation();
  const session = useSession();
  // Polling must never disturb the page: a failure just leaves the badge as it was.
  const { data } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => api.get<{ count: number } | number>('/notifications/unread-count'),
    refetchInterval: 60_000,
    retry: false,
    enabled: Boolean(session.tenant),
  });
  const count = typeof data === 'number' ? data : (data?.count ?? 0);
  const label = count > 0 ? t('nav:shell.unread', { count }) : t('nav:shell.notifications');

  return (
    <Button asChild variant="ghost" size="icon" className="relative">
      <Link to="/notifications" aria-label={label}>
        <Bell aria-hidden />
        {count > 0 && (
          <span className="absolute top-1 right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[0.6875rem] font-semibold text-destructive-foreground tabular-nums">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </Link>
    </Button>
  );
}

function UserMenu() {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const session = useSession();
  const { resolved, toggle } = useTheme();
  const [profileOpen, setProfileOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const initials = session.user.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('nav:shell.account')}
            className="focus-ring flex size-11 items-center justify-center rounded-full md:size-10"
          >
            <span className="flex size-9 items-center justify-center rounded-full bg-secondary text-sm font-semibold text-secondary-foreground">{initials}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64 max-w-[calc(100vw-2rem)]">
          <div className="px-2.5 py-1.5">
            <p className="truncate text-sm font-semibold">{session.user.fullName}</p>
            {session.role && (
              <p className="truncate text-xs text-muted-foreground">{t(`enums:role.${session.role.key}`, { defaultValue: session.role.name })}</p>
            )}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setProfileOpen(true)}>
            <User aria-hidden />
            {t('auth:profile.title')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setPasswordOpen(true)}>
            <KeyRound aria-hidden />
            {t('auth:password.title')}
          </DropdownMenuItem>
          {/* On phones the top bar has no room for these two. */}
          <div className="md:hidden">
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={toggle}>
              {resolved === 'dark' ? <Sun aria-hidden /> : <Moon aria-hidden />}
              {t('common:theme.toggle')}
            </DropdownMenuItem>
            <DropdownMenuLabel>{t('common:language.label')}</DropdownMenuLabel>
            <LanguageItems />
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => void logout()}>
            <LogOut aria-hidden />
            {t('auth:twoFactor.signOutInstead')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </>
  );
}

function TopBar() {
  return (
    <header data-app-chrome className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-background/95 px-3 pt-[env(safe-area-inset-top)] backdrop-blur md:h-16 md:px-4">
      <LogoMark className="size-8 lg:hidden" />
      <div className="min-w-0 flex-1">
        <FarmSwitcher />
      </div>
      <div className="hidden items-center gap-1 md:flex">
        <LanguageMenu />
        <ThemeButton />
      </div>
      <NotificationBell />
      <UserMenu />
    </header>
  );
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

export function AppShell() {
  const { t } = useTranslation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const online = useOnline();

  return (
    <div className="flex min-h-dvh">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {!online && (
          <div role="status" className="flex items-center justify-center gap-2 bg-warning-soft px-4 py-1.5 text-sm text-warning">
            <WifiOff className="size-4" aria-hidden />
            {t('common:status.offline')}
          </div>
        )}
        <OutboxBar />
        <main className="mx-auto w-full max-w-[100rem] flex-1 px-4 pt-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:px-6 md:pt-6 lg:pb-8">
          <Suspense fallback={<PageSkeleton />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <BottomNav onMenu={() => setDrawerOpen(true)} />
      <MobileDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />
      <ScrollRestoration />
    </div>
  );
}
