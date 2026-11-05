import { Ban, CheckCircle2, KeyRound, ShieldCheck, Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTable, PageHeader, useConfirm, useUrlParam } from '@/components';
import { Badge, Select } from '@/components/ui';
import { ShowOnceDialog } from '@/features/settings/shared';
import { api } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { useApiMutation } from '@/lib/query';

const USERS = '/platform/users';

interface Membership {
  tenant: string;
  farm: string;
  role: string;
  status: string;
}

interface PlatformUser {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  status: 'active' | 'blocked';
  isPlatformAdmin: boolean;
  totpEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  memberships: Membership[];
}

export default function UsersPage() {
  const { t } = useTranslation('platform');
  const confirm = useConfirm();
  const session = useSession();
  const [status, setStatus] = useUrlParam('status');
  const [reset, setReset] = useState<{ password: string; name: string } | null>(null);

  const setBlocked = useApiMutation<{ id: string; block: boolean }>({
    mutationFn: ({ id, block }) => api.post(`${USERS}/${id}/${block ? 'block' : 'unblock'}`),
    invalidate: [USERS],
    successMessage: 'common:toast.updated',
  });
  const resetPassword = useApiMutation<PlatformUser, { oneTimePassword: string }>({
    mutationFn: (user) => api.post(`${USERS}/${user.id}/reset-password`),
    onSuccess: (result, user) => setReset({ password: result.oneTimePassword, name: user.fullName }),
  });

  const columns: Column<PlatformUser>[] = [
    {
      key: 'fullName',
      header: t('users.name'),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {row.fullName}
          {row.isPlatformAdmin && (
            <Badge variant="info">
              <ShieldCheck aria-hidden />
              {t('users.admin')}
            </Badge>
          )}
        </span>
      ),
      mobile: 'title',
    },
    { key: 'phone', header: t('users.phone'), cell: (row) => row.phone, mobile: 'subtitle' },
    {
      key: 'memberships',
      header: t('users.workplaces'),
      cell: (row) =>
        row.memberships.length === 0 ? (
          t('users.noWorkplace')
        ) : (
          <span className="flex flex-col gap-0.5">
            {row.memberships.map((m) => (
              <span key={`${m.tenant}-${m.farm}`} className="text-sm">
                {m.tenant} · {t(`enums:role.${m.role}`, { defaultValue: m.role })}
                {m.status !== 'active' && <span className="text-muted-foreground"> ({t('users.statuses.blocked')})</span>}
              </span>
            ))}
          </span>
        ),
    },
    {
      key: 'status',
      header: t('users.status'),
      cell: (row) => <Badge variant={row.status === 'active' ? 'success' : 'danger'}>{t(`users.statuses.${row.status}`)}</Badge>,
    },
    {
      key: 'totpEnabled',
      header: t('users.twoFactor'),
      cell: (row) => (row.totpEnabled ? <Badge variant="success">{t('users.twoFactorOn')}</Badge> : t('users.twoFactorOff')),
      mobile: 'hidden',
    },
    { key: 'lastLoginAt', header: t('users.lastLogin'), cell: (row) => (row.lastLoginAt ? formatDateTime(row.lastLoginAt) : t('users.neverSignedIn')) },
  ];

  return (
    <>
      <PageHeader title={t('users.title')} description={t('users.description')} />

      <DataTable<PlatformUser>
        path={USERS}
        params={{ status: status || undefined }}
        columns={columns}
        searchPlaceholder={t('users.searchPlaceholder')}
        filters={
          <Select
            aria-label={t('users.status')}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: 'active', label: t('users.statuses.active') },
              { value: 'blocked', label: t('users.statuses.blocked') },
            ]}
            placeholder={t('users.allStatuses')}
            className="md:w-48"
          />
        }
        empty={{ icon: Users, title: t('users.emptyTitle') }}
        rowActions={(row) =>
          // Your own account is changed from your profile, so nobody locks themselves out from here.
          row.id === session.user.id
            ? []
            : [
                {
                  label: t('users.resetPassword'),
                  icon: KeyRound,
                  onClick: () =>
                    void confirm({
                      title: t('users.resetTitle'),
                      description: t('users.resetBody', { name: row.fullName }),
                      confirmLabel: t('users.resetPassword'),
                    }).then((ok) => ok && resetPassword.mutate(row)),
                },
                row.status === 'active'
                  ? {
                      label: t('users.block'),
                      icon: Ban,
                      destructive: true,
                      onClick: () =>
                        void confirm({
                          title: t('users.blockTitle'),
                          description: t('users.blockBody', { name: row.fullName }),
                          confirmLabel: t('users.block'),
                          destructive: true,
                        }).then((ok) => ok && setBlocked.mutate({ id: row.id, block: true })),
                    }
                  : { label: t('users.unblock'), icon: CheckCircle2, onClick: () => setBlocked.mutate({ id: row.id, block: false }) },
              ]
        }
      />

      <ShowOnceDialog
        secret={reset?.password ?? null}
        title={t('users.resetDoneTitle')}
        description={t('users.resetDoneBody', { name: reset?.name })}
        label={t('users.oneTimePassword')}
        onClose={() => setReset(null)}
      />
    </>
  );
}
