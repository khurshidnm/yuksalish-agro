import { Lock, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { EmptyState, ErrorCard, FormDialog, SelectField, TextField, useConfirm, useUrlParam } from '@/components';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { zOptionalRef, zText } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';
import { cn } from '@/lib/utils';
import { PermissionMatrix } from './PermissionMatrix';
import { useRoleLabel } from './shared';

export const ROLES = '/settings/roles';

export interface Role {
  id: string;
  key: string;
  name: string;
  permissions: string[];
  isSystem: boolean;
  memberCount: number;
}

const createSchema = z.object({ name: zText(80), copyFrom: zOptionalRef() });

function RoleEditor({ role, onDeleted }: { role: Role; onDeleted: () => void }) {
  const { t } = useTranslation('settings');
  const can = useCan();
  const confirm = useConfirm();
  const label = useRoleLabel();
  const [name, setName] = useState(role.name);
  const [permissions, setPermissions] = useState(role.permissions);

  useEffect(() => {
    setName(role.name);
    setPermissions(role.permissions);
  }, [role]);

  const locked = role.key === 'owner';
  const readOnly = locked || !can('users.update');
  const dirty =
    name !== role.name ||
    permissions.length !== role.permissions.length ||
    permissions.some((p) => !role.permissions.includes(p));

  const save = useApiMutation({
    mutationFn: () => api.patch(`${ROLES}/${role.id}`, { ...(role.isSystem ? {} : { name }), permissions }),
    invalidate: [ROLES],
    successMessage: 'common:toast.saved',
  });
  const remove = useApiMutation({
    mutationFn: () => api.delete(`${ROLES}/${role.id}`),
    invalidate: [ROLES],
    successMessage: 'common:toast.deleted',
    onSuccess: onDeleted,
  });

  return (
    <Card className="min-w-0 flex-1">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {label(role)}
          {role.isSystem ? <Badge>{t('roles.system')}</Badge> : <Badge variant="info">{t('roles.custom')}</Badge>}
        </CardTitle>
        <CardDescription>{t('roles.membersCount', { count: role.memberCount })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {locked && (
          <Alert tone="info" title={t('roles.ownerLockedTitle')}>
            {t('roles.ownerLocked')}
          </Alert>
        )}
        {!role.isSystem && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="role-name">{t('roles.name')}</Label>
            <Input id="role-name" value={name} disabled={readOnly} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        <PermissionMatrix value={permissions} onChange={setPermissions} readOnly={readOnly} />
        {!readOnly && (
          <div className="flex flex-wrap justify-between gap-2">
            {!role.isSystem && can('users.delete') ? (
              <Button
                variant="ghost"
                onClick={() =>
                  void confirm({
                    title: t('roles.deleteTitle'),
                    description: t('roles.deleteBody', { name: role.name }),
                    destructive: true,
                  }).then((ok) => ok && remove.mutate())
                }
              >
                <Trash2 aria-hidden />
                {t('common:actions.delete')}
              </Button>
            ) : (
              <span />
            )}
            <Button loading={save.isPending} disabled={!dirty || name.trim().length < 2} onClick={() => save.mutate()}>
              {t('common:actions.save')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function RolesTab() {
  const { t } = useTranslation('settings');
  const can = useCan();
  const label = useRoleLabel();
  const query = useDetail<Role[]>(ROLES);
  const [selected, setSelected] = useUrlParam('role');
  const [creating, setCreating] = useState(false);

  const create = useApiMutation<{ name: string; permissions: string[] }, Role>({
    mutationFn: (values) => api.post(ROLES, values),
    invalidate: [ROLES],
    silentError: true,
    onSuccess: (role) => setSelected(role.id),
  });

  if (query.error) return <ErrorCard error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <Skeleton className="h-96 w-full rounded-xl" />;

  const roles = query.data;
  const active = roles.find((role) => role.id === selected) ?? roles[0];
  if (!active) return <EmptyState icon={ShieldCheck} title={t('roles.emptyTitle')} />;

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="flex shrink-0 flex-col gap-3 lg:w-64">
        <div className="lg:hidden">
          <Label htmlFor="role-select" className="mb-1.5 block">
            {t('roles.chooseRole')}
          </Label>
          <Select
            id="role-select"
            value={active.id}
            onChange={(e) => setSelected(e.target.value)}
            options={roles.map((role) => ({ value: role.id, label: label(role) }))}
          />
        </div>
        <nav aria-label={t('roles.chooseRole')} className="hidden flex-col gap-0.5 lg:flex">
          {roles.map((role) => (
            <button
              key={role.id}
              type="button"
              aria-current={role.id === active.id ? 'true' : undefined}
              onClick={() => setSelected(role.id)}
              className={cn(
                'focus-ring flex min-h-10 items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-left text-sm',
                role.id === active.id ? 'bg-secondary font-medium text-secondary-foreground' : 'hover:bg-muted',
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                {role.key === 'owner' && <Lock className="size-3.5 shrink-0" aria-hidden />}
                <span className="truncate">{label(role)}</span>
              </span>
              <span className="text-xs text-muted-foreground">{role.memberCount}</span>
            </button>
          ))}
        </nav>
        {can('users.create') && (
          <Button variant="outline" onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {t('roles.add')}
          </Button>
        )}
      </div>

      <RoleEditor role={active} onDeleted={() => setSelected('')} />

      <FormDialog
        open={creating}
        onOpenChange={setCreating}
        title={t('roles.add')}
        description={t('roles.addHint')}
        schema={createSchema}
        defaultValues={{ name: '', copyFrom: '' }}
        successMessage="common:toast.created"
        onSubmit={(values) => {
          const source = roles.find((role) => role.id === values.copyFrom);
          // Only rights the creator holds can go on a new role.
          return create.mutateAsync({ name: values.name, permissions: (source?.permissions ?? []).filter((p) => can(p)) });
        }}
      >
        {(form) => (
          <>
            <TextField form={form} name="name" label={t('roles.name')} required autoFocus />
            <SelectField
              form={form}
              name="copyFrom"
              label={t('roles.copyFrom')}
              hint={t('roles.copyFromHint')}
              placeholder={t('roles.startEmpty')}
              options={roles.map((role) => ({ value: role.id, label: label(role) }))}
            />
          </>
        )}
      </FormDialog>
    </div>
  );
}
