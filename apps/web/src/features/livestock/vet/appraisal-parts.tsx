import { BODY_CONDITION_STEPS, isThin } from '@yap/shared/formulas/body-condition';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui';
import i18n from '@/lib/i18n';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

/** A farm may keep its own grading classes; one without a label of ours is shown as the farm wrote it. */
export const classLabel = (key: string) => i18n.t(`enums:gradingClass.${key}`, { defaultValue: key });

interface ScoreButtonsProps {
  value: number | null;
  onPick: (score: number) => void;
  /** Names the group for a screen reader, e.g. "Score for 0142". */
  label: string;
}

/** Body condition 1 to 5 in half steps, each a button a gloved thumb can hit: five to a row on a phone. */
export function ScoreButtons({ value, onPick, label }: ScoreButtonsProps) {
  return (
    <div className="flex max-w-68 flex-wrap gap-2 sm:max-w-none" role="group" aria-label={label}>
      {BODY_CONDITION_STEPS.map((step) => {
        const on = value === step;
        return (
          <button
            key={step}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(step)}
            className={cn(
              'focus-ring flex size-12 items-center justify-center rounded-lg border-2 text-base font-bold tabular-nums transition-colors',
              on ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-foreground hover:border-input',
            )}
          >
            {formatNumber(step, 1)}
          </button>
        );
      })}
    </div>
  );
}

/** The latest condition score. Thin is marked; no score is a dash, never a zero. */
export function ConditionBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant={isThin(score) ? 'warning' : 'neutral'} className="tabular-nums">
      {formatNumber(score, 1)}
    </Badge>
  );
}

/** Shown on a card and in lists when a person has marked the animal for culling. */
export function CullBadge() {
  const { t } = useTranslation('vet');
  return <Badge variant="warning">{t('culling.badge')}</Badge>;
}
