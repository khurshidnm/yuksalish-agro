import { CloudOff, Leaf, Loader2, ShieldOff, Sprout, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useRouteError } from 'react-router';
import { EmptyState } from '@/components/EmptyState';
import { Button, Card, Skeleton } from '@/components/ui';
import { InvitationList } from '@/features/auth/Invitations';
import { useSession } from '@/lib/auth';
import { LogoMark } from './Logo';
import { useSignOut } from './useSignOut';

function HomeButton() {
  const { t } = useTranslation();
  return (
    <Button asChild variant="outline">
      <Link to="/">{t('common:pages.backHome')}</Link>
    </Button>
  );
}

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <Card>
      <EmptyState icon={Leaf} title={t('common:pages.notFoundTitle')} description={t('common:pages.notFoundBody')} action={<HomeButton />} />
    </Card>
  );
}

export function ForbiddenPage() {
  const { t } = useTranslation();
  return (
    <Card>
      <EmptyState icon={ShieldOff} title={t('common:pages.forbiddenTitle')} description={t('common:pages.forbiddenBody')} action={<HomeButton />} />
    </Card>
  );
}

export function ModuleOffPage() {
  const { t } = useTranslation();
  return (
    <Card>
      <EmptyState icon={Sprout} title={t('common:pages.moduleOffTitle')} description={t('common:pages.moduleOffBody')} action={<HomeButton />} />
    </Card>
  );
}

/** A signed-in user with no farm: nothing to show until someone adds them, or they accept an invitation. */
export function NoAccessScreen() {
  const { t } = useTranslation();
  const signOut = useSignOut();
  const { invitations } = useSession();
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-md">
        {invitations.length > 0 && (
          <div className="p-5 pb-0">
            <InvitationList />
          </div>
        )}
        <EmptyState
          icon={ShieldOff}
          title={t('common:pages.forbiddenTitle')}
          description={t('common:pages.forbiddenBody')}
          action={
            <Button variant="outline" onClick={() => void signOut()}>
              {t('auth:twoFactor.signOutInstead')}
            </Button>
          }
        />
      </Card>
    </div>
  );
}

/**
 * A page whose code is not on the phone and could not be fetched. That is not a fault of the app:
 * with no connection, the screens field staff need are cached, so point them there.
 */
export function MissingCodeCard() {
  const { t } = useTranslation();
  const offline = !navigator.onLine;
  return (
    <Card>
      <EmptyState
        icon={CloudOff}
        title={t(offline ? 'common:pages.offlineTitle' : 'common:update.pageTitle')}
        description={t(offline ? 'common:pages.offlineBody' : 'common:update.pageBody')}
        action={offline ? <Button onClick={() => window.location.assign('/today')}>{t('common:pages.offlineAction')}</Button> : <Button onClick={() => window.location.reload()}>{t('common:pages.reload')}</Button>}
      />
    </Card>
  );
}

/** What browsers say when an import or its styles fail. A lazy() that skipped lazyPage ends up here. */
const MISSING_CODE = /dynamically imported module|importing a module script failed|unable to preload css/i;

export function RouteErrorPage() {
  const { t } = useTranslation();
  const error = useRouteError();
  console.error(error);
  const missingCode = error instanceof Error && MISSING_CODE.test(error.message);
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      {missingCode || !navigator.onLine ? (
        <div className="w-full max-w-md">
          <MissingCodeCard />
        </div>
      ) : (
        <Card className="w-full max-w-md">
          <EmptyState
            icon={TriangleAlert}
            title={t('common:pages.errorTitle')}
            description={t('common:pages.errorBody')}
            action={<Button onClick={() => window.location.reload()}>{t('common:pages.reload')}</Button>}
          />
        </Card>
      )}
    </div>
  );
}

export function SplashScreen() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-sidebar">
      <LogoMark className="size-14" />
      <Loader2 className="size-6 animate-spin text-sidebar-muted" aria-label={t('common:status.loading')} />
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-4">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}
