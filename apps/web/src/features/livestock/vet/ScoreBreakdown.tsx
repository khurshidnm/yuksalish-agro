import { EWE_SCORE_COMPONENTS } from '@yap/shared';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui';
import { formatNumber, formatPercent } from '@/lib/format';
import type { EweScore, ScorePart } from './types';

/** The fact behind a part, written the way its sentence needs it. */
function factValue(part: ScorePart): string {
  switch (part.key) {
    case 'rearing':
      return formatPercent(part.value * 100, 0);
    case 'lamb_growth':
      return formatPercent(part.value, 0);
    case 'lambing_interval':
      return formatNumber(part.value, 0);
    case 'prolificacy':
      return formatNumber(part.value, 2);
    default:
      return formatNumber(part.value, 1);
  }
}

interface Props {
  /** The ewe whose score is open, or null when the dialog is closed. */
  ewe: (EweScore & { tag: string }) | null;
  onClose: () => void;
}

/** A ewe's score taken apart, in words: what each part was, what it earned, and what was missing. */
export function ScoreBreakdownDialog({ ewe, onClose }: Props) {
  const { t } = useTranslation('vet');
  const order = (key: string) => EWE_SCORE_COMPONENTS.indexOf(key as (typeof EWE_SCORE_COMPONENTS)[number]);
  const parts = ewe ? [...ewe.parts].sort((a, b) => order(a.key) - order(b.key)) : [];

  return (
    <Dialog open={ewe !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('score.breakdownTitle', { tag: ewe?.tag ?? '' })}</DialogTitle>
          <DialogDescription>
            {ewe && ewe.score !== null ? t('score.total', { score: formatNumber(ewe.score, 1) }) : t('score.none')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {parts.length > 0 && (
            <ul className="space-y-4">
              {parts.map((part) => (
                <li key={part.key} className="space-y-1.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <p className="font-medium">{t(`enums:eweScoreComponent.${part.key}`)}</p>
                    <p className="text-sm text-muted-foreground tabular-nums">
                      {t('score.earned', { points: formatNumber(part.points, 0), weight: formatPercent(part.weight * 100, 0) })}
                    </p>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, part.points))}%` }} />
                  </div>
                  <p className="text-sm break-words text-muted-foreground">{t(`score.fact.${part.key}`, { value: factValue(part) })}</p>
                </li>
              ))}
            </ul>
          )}
          {ewe && ewe.score !== null && ewe.missing.length > 0 && (
            <div className="rounded-lg border border-border p-3 text-sm">
              <p className="font-medium">{t('score.missingTitle')}</p>
              <p className="break-words text-muted-foreground">
                {ewe.missing.map((key) => t(`enums:eweScoreComponent.${key}`)).join(', ')}. {t('score.missingBody')}
              </p>
            </div>
          )}
          <p className="text-sm text-muted-foreground">{t('score.startingValues')}</p>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
