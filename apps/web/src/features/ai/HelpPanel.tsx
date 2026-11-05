import { useTranslation } from 'react-i18next';
import { Alert, Button } from '@/components/ui';

const GROUPS = {
  expense: ['fuelShort', 'repair'],
  stock: ['feed', 'diesel'],
  income: ['subsidy'],
  debt: ['supplier'],
  transfer: ['bank'],
  several: ['two'],
  ask: ['status', 'cash'],
} as const;

/**
 * What can be said, in the person's language. A tap fills the box, so nothing is sent by accident.
 * Without `onPick` there is no box to fill, so the examples are plain text.
 */
export function HelpPanel({ onPick }: { onPick?: (text: string) => void }) {
  const { t } = useTranslation('ai');
  return (
    <div className="flex flex-col gap-4" data-testid="help-panel">
      <p className="text-sm text-muted-foreground">
        {t('records.help.intro')}
        {onPick && ` ${t('records.help.tapHint')}`}
      </p>
      {Object.entries(GROUPS).map(([group, examples]) => (
        <section key={group} className="flex flex-col gap-1.5">
          <h3 className="text-sm font-semibold">{t(`records.help.groups.${group}`)}</h3>
          {examples.map((example) => {
            const text = t(`records.help.examples.${example}`);
            return onPick ? (
              <Button key={example} variant="outline" className="h-auto min-h-11 justify-start py-2 text-left whitespace-normal" onClick={() => onPick(text)}>
                {text}
              </Button>
            ) : (
              <p key={example} className="rounded-lg bg-muted px-3 py-2">
                {text}
              </p>
            );
          })}
        </section>
      ))}
      <Alert tone="info" title={t('records.help.safetyTitle')}>
        {t('records.help.safetyBody')}
      </Alert>
      <p className="text-sm text-muted-foreground">{t('records.help.elsewhere')}</p>
      <p className="text-sm text-muted-foreground">{t('records.help.telegram')}</p>
    </div>
  );
}
