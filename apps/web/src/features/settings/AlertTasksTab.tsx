import { DEFAULT_ROLE_PERMISSIONS, ROLE_KEYS } from '@yap/shared';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorCard } from '@/components';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Select, Skeleton, Switch } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useApiMutation, useDetail } from '@/lib/query';
import type { AutoTaskRule } from '@/features/alerts/types';

const RULES = '/alerts/rules';

/** Roles that work on tasks. An investor or an auditor reads; a task given to them would wait for ever. */
const TASK_ROLES = ROLE_KEYS.filter((role) => DEFAULT_ROLE_PERMISSIONS[role].includes('tasks.update'));

/**
 * One switch per alert rule: when it is on, a new alert of that rule gets its task straight away.
 * Each change is saved by itself, so there is no form to forget to submit.
 */
export function AlertTasksTab() {
  const { t } = useTranslation('alerts');
  const canUpdate = useCan()('settings.update');
  const rules = useDetail<AutoTaskRule[]>(RULES);
  const save = useApiMutation<AutoTaskRule>({
    mutationFn: ({ ruleKey, enabled, assigneeRole }) =>
      api.patch('/settings/policy', { alerts: { autoTask: { [ruleKey]: { enabled, assigneeRole } } } }),
    invalidate: [RULES],
    successMessage: 'alerts:autoTask.saved',
  });

  if (rules.error) return <ErrorCard error={rules.error} onRetry={() => void rules.refetch()} />;
  if (!rules.data) return <Skeleton className="h-96 w-full rounded-xl" />;
  if (rules.data.length === 0) return <EmptyState title={t('autoTask.emptyTitle')} />;

  const roleOptions = TASK_ROLES.map((role) => ({ value: role, label: t(`enums:role.${role}`) }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('autoTask.title')}</CardTitle>
        <CardDescription>
          {t('autoTask.description')} {t('autoTask.roleHint')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y divide-border">
          {rules.data.map((rule) => {
            const name = t(`ruleNames.${rule.ruleKey}`, { defaultValue: rule.ruleKey });
            const saving = save.isPending && save.variables?.ruleKey === rule.ruleKey;
            return (
              <li key={rule.ruleKey} className="flex flex-col gap-2 py-2 md:flex-row md:items-center md:gap-4">
                <div className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="min-w-0 break-words">{name}</span>
                  <Switch
                    aria-label={t('autoTask.switchLabel', { rule: name })}
                    checked={rule.enabled}
                    disabled={!canUpdate || saving}
                    onCheckedChange={(enabled) => save.mutate({ ...rule, enabled })}
                  />
                </div>
                {rule.enabled && (
                  <Select
                    aria-label={`${t('autoTask.role')}: ${name}`}
                    value={rule.assigneeRole ?? ''}
                    disabled={!canUpdate || saving}
                    onChange={(e) => save.mutate({ ...rule, assigneeRole: e.target.value || null })}
                    options={roleOptions}
                    placeholder={t('autoTask.noRole')}
                    className="md:w-72"
                  />
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
