import { ACTIONS, FINANCE_CAPITAL, FINANCE_SUMMARY_VIEW, MODULES, PII_VIEW } from '@yap/shared';
import { useTranslation } from 'react-i18next';
import { Checkbox } from '@/components/ui';
import { useCan } from '@/lib/auth';

export interface PermissionMatrixProps {
  value: string[];
  onChange: (next: string[]) => void;
  readOnly?: boolean;
}

/**
 * Module × action grid. A right the editor lacks cannot be ticked: the server refuses it anyway,
 * and a disabled box explains that sooner. Rights already on the role can still be removed.
 * On phones each module is its own block, with the action named beside every box.
 */
export function PermissionMatrix({ value, onChange, readOnly }: PermissionMatrixProps) {
  const { t } = useTranslation('settings');
  const can = useCan();
  const held = new Set(value);

  const toggle = (permission: string, on: boolean) =>
    onChange(on ? [...value, permission] : value.filter((p) => p !== permission));

  const box = (permission: string, label: string) => {
    const checked = held.has(permission);
    return (
      <Checkbox
        checked={checked}
        disabled={readOnly || (!checked && !can(permission))}
        aria-label={label}
        title={!checked && !can(permission) ? t('roles.cannotGrant') : undefined}
        onCheckedChange={(next) => toggle(permission, next === true)}
      />
    );
  };

  return (
    <div className="flex flex-col">
      <div className="hidden grid-cols-[minmax(0,1fr)_repeat(5,5.5rem)] items-center gap-2 border-b border-border pb-2 text-xs font-medium text-muted-foreground md:grid">
        <span>{t('roles.module')}</span>
        {ACTIONS.map((action) => (
          <span key={action} className="text-center">
            {t(`enums:action.${action}`)}
          </span>
        ))}
      </div>

      {MODULES.map((module) => {
        const moduleName = t(`enums:module.${module}`);
        return (
          <div
            key={module}
            className="flex flex-col gap-1 border-b border-border py-2.5 last:border-b-0 md:grid md:grid-cols-[minmax(0,1fr)_repeat(5,5.5rem)] md:items-center md:gap-2"
          >
            <span className="text-sm font-medium">{moduleName}</span>
            <div className="grid grid-cols-2 gap-x-3 sm:grid-cols-3 md:contents">
              {ACTIONS.map((action) => {
                const actionName = t(`enums:action.${action}`);
                return (
                  // A real label: on a phone the whole row is the tap target, not just the small box.
                  <label key={action} className="flex min-h-11 cursor-pointer items-center gap-2 md:justify-center">
                    {box(`${module}.${action}`, `${moduleName}: ${actionName}`)}
                    <span className="text-sm text-muted-foreground md:hidden">{actionName}</span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}

      <label className="flex min-h-11 cursor-pointer items-center gap-3 pt-3">
        {box(PII_VIEW, t('roles.pii'))}
        <span className="min-w-0">
          <span className="block text-sm font-medium">{t('roles.pii')}</span>
          <span className="block text-xs text-muted-foreground">{t('roles.piiHint')}</span>
        </span>
      </label>

      <label className="flex min-h-11 cursor-pointer items-center gap-3">
        {box(FINANCE_SUMMARY_VIEW, t('roles.financeSummary'))}
        <span className="min-w-0">
          <span className="block text-sm font-medium">{t('roles.financeSummary')}</span>
          <span className="block text-xs text-muted-foreground">{t('roles.financeSummaryHint')}</span>
        </span>
      </label>

      <label className="flex min-h-11 cursor-pointer items-center gap-3">
        {box(FINANCE_CAPITAL, t('roles.financeCapital'))}
        <span className="min-w-0">
          <span className="block text-sm font-medium">{t('roles.financeCapital')}</span>
          <span className="block text-xs text-muted-foreground">{t('roles.financeCapitalHint')}</span>
        </span>
      </label>
    </div>
  );
}
