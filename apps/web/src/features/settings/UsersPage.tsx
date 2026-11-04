import { KeyRound, Plus, ShieldCheck, ShieldOff, UserCog, UserX, Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { type Column, DataTable, FormDialog, FormGrid, PageHeader, SelectField, TextField, UrlTabs, useConfirm, useUrlParam } from '@/components';
import { Badge, Button, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan, useSession } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { zOptionalText, zRef, zText } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';
import { LANGUAGES } from '@yap/shared/i18n';
import { ROLES, type Role, RolesTab } from './RolesTab';
import { ShowOnceDialog, useRoleLabel } from './shared';

const USERS = '/settings/users';

interface Member {
  id: string;
  userId: string;
  status: 'active' | 'blocked';
  fullName: string;
  phone: string | null;
  email: string | null;
  lastLoginAt: string | null;
  totpEnabled: boolean;
  roleId: string;
  roleKey: string;
  roleName: string;
}

interface AddResult {
  member: Member;
  oneTimePassword: string | null;
  existingUser: boolean;
}

const addSchema = z.object({
  phone: zText(20),
  fullName: zText(120),
  email: zOptionalText(200).refine((value) => !value || /^\S+@\S+\.\S+$/.test(value)),
  roleId: zRef(),
  locale: z.enum(['uz', 'uz-Cyrl', 'ru', 'en']),
});

const roleSchema = z.object({ roleId: zRef() });

function PeopleTab() {
  const { t } = useTranslation('settings');
  const session = useSession();
  const can = useCan();
  const confirm = useConfirm();
  const roleLabel = useRoleLabel();
  const roles = useDetail<Role[]>(ROLES);
  const roleOptions = (roles.data ?? []).map((role) => ({ value: role.id, label: roleLabel(role) }));

  const [roleFilter, setRoleFilter] = useUrlParam('role');
  const [statusFilter, setStatusFilter] = useUrlParam('status');
  const [adding, setAdding] = useState(false);
  const [changing, setChanging] = useState<Member | null>(null);
  const [secret, setSecret] = useState<{ value: string; name: string } | null>(null);

  const add = useApiMutation<z.output<typeof addSchema>, AddResult>({
    mutationFn: (values) => api.post(USERS, values),
    invalidate: [USERS, ROLES],
    silentError: true,
    onSuccess: (result) => {
      if (result.oneTimePassword) setSecret({ value: result.oneTimePassword, name: result.member.fullName });
      else toast.success(t('users.addedExisting', { name: result.member.fullName }));
    },
  });
  const changeRole = useApiMutation<{ id: string; roleId: string }>({
    mutationFn: ({ id, roleId }) => api.patch(`${USERS}/${id}`, { roleId }),
    invalidate: [USERS, ROLES],
    silentError: true,
  });
  const setBlocked = useApiMutation<{ id: string; blocked: boolean }>({
    mutationFn: ({ id, blocked }) => api.post(`${USERS}/${id}/${blocked ? 'block' : 'unblock'}`),
    invalidate: [USERS],
    successMessage: 'common:toast.updated',
  });
  const resetPassword = useApiMutation<Member, { oneTimePassword: string }>({
    mutationFn: (member) => api.post(`${USERS}/${member.id}/reset-password`),
    onSuccess: (result, member) => setSecret({ value: result.oneTimePassword, name: member.fullName }),
  });

  const columns: Column<Member>[] = [
    { key: 'fullName', header: t('users.name'), cell: (row) => row.fullName, sortable: true, mobile: 'title' },
    {
      key: 'role',
      header: t('users.role'),
      cell: (row) => <Badge>{roleLabel({ key: row.roleKey, name: row.roleName })}</Badge>,
      mobile: 'subtitle',
    },
    { key: 'phone', header: t('users.phone'), cell: (row) => row.phone ?? '—' },
    {
      key: 'status',
      header: t('users.status'),
      sortable: true,
      cell: (row) => <Badge variant={row.status === 'active' ? 'success' : 'danger'}>{t(`users.statuses.${row.status}`)}</Badge>,
    },
    {
      key: 'totp',
      header: t('users.twoFactor'),
      cell: (row) =>
        row.totpEnabled ? (
          <Badge variant="success">
            <ShieldCheck aria-hidden />
            {t('users.twoFactorOn')}
          </Badge>
        ) : (
          <Badge>
            <ShieldOff aria-hidden />
            {t('users.twoFactorOff')}
          </Badge>
        ),
      mobile: 'hidden',
    },
    { key: 'lastLoginAt', header: t('users.lastLogin'), cell: (row) => formatDateTime(row.lastLoginAt), mobile: 'hidden' },
  ];

  const addButton = can('users.create') && (
    <Button onClick={() => setAdding(true)}>
      <Plus aria-hidden />
      {t('users.add')}
    </Button>
  );

  return (
    <>
      <div className="mb-3 flex justify-end empty:hidden">{addButton}</div>
      <DataTable<Member>
        path={USERS}
        params={{ roleId: roleFilter || undefined, status: statusFilter || undefined }}
        columns={columns}
        defaultSort="fullName"
        searchPlaceholder={t('users.searchPlaceholder')}
        filters={
          <>
            <Select aria-label={t('users.role')} value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} options={roleOptions} placeholder={t('users.allRoles')} className="md:w-52" />
            <Select
              aria-label={t('users.status')}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              options={[
                { value: 'active', label: t('users.statuses.active') },
                { value: 'blocked', label: t('users.statuses.blocked') },
              ]}
              placeholder={t('users.allStatuses')}
              className="md:w-44"
            />
          </>
        }
        empty={{ icon: Users, title: t('users.emptyTitle'), description: t('users.emptyBody'), action: addButton }}
        rowActions={(row) => {
          const self = row.userId === session.user.id;
          return [
            { label: t('users.changeRole'), icon: UserCog, hidden: self || !can('users.update'), onClick: () => setChanging(row) },
            {
              label: t('users.resetPassword'),
              icon: KeyRound,
              hidden: self || !can('users.update'),
              onClick: () =>
                void confirm({ title: t('users.resetTitle'), description: t('users.resetBody', { name: row.fullName }) }).then((ok) => ok && resetPassword.mutate(row)),
            },
            row.status === 'active'
              ? {
                  label: t('users.block'),
                  icon: UserX,
                  destructive: true,
                  hidden: self || !can('users.update'),
                  onClick: () =>
                    void confirm({
                      title: t('users.blockTitle'),
                      description: t('users.blockBody', { name: row.fullName }),
                      confirmLabel: t('users.block'),
                      destructive: true,
                    }).then((ok) => ok && setBlocked.mutate({ id: row.id, blocked: true })),
                }
              : {
                  label: t('users.unblock'),
                  icon: UserCog,
                  hidden: !can('users.update'),
                  onClick: () => setBlocked.mutate({ id: row.id, blocked: false }),
                },
          ];
        }}
      />

      <FormDialog
        open={adding}
        onOpenChange={setAdding}
        title={t('users.add')}
        description={t('users.addHint')}
        schema={addSchema}
        defaultValues={{ phone: '', fullName: '', email: '', roleId: '', locale: 'uz' }}
        onSubmit={(values) => add.mutateAsync(values)}
      >
        {(form) => (
          <>
            <FormGrid>
              <TextField form={form} name="phone" label={t('users.phone')} required inputMode="tel" autoComplete="off" placeholder="+998 90 123 45 67" autoFocus />
              <TextField form={form} name="fullName" label={t('users.name')} required autoComplete="off" />
            </FormGrid>
            <SelectField form={form} name="roleId" label={t('users.role')} required options={roleOptions} />
            <FormGrid>
              <TextField form={form} name="email" label={t('users.email')} type="email" autoComplete="off" />
              <SelectField form={form} name="locale" label={t('users.language')} options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))} />
            </FormGrid>
          </>
        )}
      </FormDialog>

      <FormDialog
        open={changing !== null}
        onOpenChange={(open) => !open && setChanging(null)}
        title={t('users.changeRole')}
        description={changing?.fullName}
        schema={roleSchema}
        defaultValues={{ roleId: changing?.roleId ?? '' }}
        successMessage="common:toast.updated"
        onSubmit={(values) => changeRole.mutateAsync({ id: changing!.id, roleId: values.roleId })}
      >
        {(form) => <SelectField form={form} name="roleId" label={t('users.role')} required options={roleOptions} />}
      </FormDialog>

      <ShowOnceDialog
        secret={secret?.value ?? null}
        title={t('users.passwordTitle')}
        description={t('users.passwordBody', { name: secret?.name })}
        label={t('users.oneTimePassword')}
        onClose={() => setSecret(null)}
      />
    </>
  );
}

export default function UsersPage() {
  const { t } = useTranslation('settings');
  return (
    <>
      <PageHeader title={t('users.title')} description={t('users.description')} />
      <UrlTabs
        param="view"
        tabs={[
          { value: 'people', label: t('users.tabPeople'), content: <PeopleTab /> },
          { value: 'roles', label: t('users.tabRoles'), content: <RolesTab /> },
        ]}
      />
    </>
  );
}
