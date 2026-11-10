import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { NUTRIENTS, PREGNANCY_STAGES, type BalanceFlag, type BalanceLine, type Nutrient, type NutrientAmounts } from '@yap/shared/formulas/nutrition';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, type BadgeVariant, ErrorCard, Label, Meter, Select, Skeleton } from '@/components';
import { api } from '@/lib/api';
import { formatNumber, formatPercent } from '@/lib/format';
import { useDetail } from '@/lib/query';
import type { MixMissingField, RationNutrients, RequirementChoice } from './types';

const BADGE: Record<BalanceFlag, BadgeVariant> = { short: 'danger', enough: 'success', over: 'warning' };
const METER: Record<BalanceFlag, 'danger' | 'success' | 'warning'> = { short: 'danger', enough: 'success', over: 'warning' };
/** Decimals worth showing: kilograms to ten grams, megajoules and minerals to a tenth, protein to the gram. */
const DIGITS: Record<Nutrient, number> = { dryMatter: 2, energy: 1, protein: 0, calcium: 1, phosphorus: 1 };

/** Supply with no requirement beside it, as balance lines. */
export function supplyLines(supply: NutrientAmounts): BalanceLine[] {
  return NUTRIENTS.map((nutrient) => ({ nutrient, supply: supply[nutrient], requirement: null, coveredPct: null, flag: null }));
}

/** One row per nutrient: what the ration gives, what the animal needs, the share covered and a plain flag. */
export function BalanceLines({ lines }: { lines: BalanceLine[] }) {
  const { t } = useTranslation('feed');
  return (
    <ul className="flex flex-col gap-2.5">
      {lines.map((line) => {
        const name = t(`nutrients.name.${line.nutrient}`);
        const unit = t(`nutrients.unit.${line.nutrient}`);
        const digits = DIGITS[line.nutrient];
        const supply = line.supply === null ? null : formatNumber(line.supply, digits);
        const requirement = line.requirement === null ? null : formatNumber(line.requirement, digits);

        if (requirement === null) {
          return (
            <li key={line.nutrient} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 break-words text-muted-foreground">{name}</span>
              <span className="shrink-0 font-medium tabular-nums">{supply === null ? '—' : t('nutrients.amount', { value: supply, unit })}</span>
            </li>
          );
        }
        return (
          <li key={line.nutrient} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 break-words">{name}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="font-medium tabular-nums">{formatPercent(line.coveredPct, 0)}</span>
                {line.flag && <Badge variant={BADGE[line.flag]}>{t(`nutrients.flag.${line.flag}`)}</Badge>}
              </span>
            </div>
            {line.coveredPct !== null && line.flag && <Meter value={line.coveredPct} tone={METER[line.flag]} label={t('nutrients.covered', { name })} />}
            <p className="text-xs text-muted-foreground tabular-nums">
              {supply === null ? t('nutrients.needs', { requirement, unit }) : t('nutrients.ofRequirement', { supply, requirement, unit })}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/** Feeds that lack a figure, by name, with the figures they lack. */
export function MissingData({ missing, title, children }: {
  missing: { itemId: string; itemName: string; fields: MixMissingField[] }[];
  title: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation('feed');
  if (missing.length === 0) return null;
  return (
    <Alert tone="warning" title={title}>
      <ul className="mt-1 flex flex-col gap-0.5">
        {missing.map((feed) => (
          <li key={feed.itemId}>{t('nutrients.missingLine', { name: feed.itemName, fields: feed.fields.map((field) => t(`nutrients.field.${field}`)).join(', ') })}</li>
        ))}
      </ul>
      {children}
    </Alert>
  );
}

/** A "pregnant" or "lactating" ration does not say the stage or the number of lambs: the reader does. */
export function RequirementChoiceSelects({ stage, litter, onChange }: {
  stage: 'early' | 'late' | null;
  litter: 1 | 2 | null;
  onChange: (choice: RequirementChoice) => void;
}) {
  const { t } = useTranslation('feed');
  const id = useId();
  if (stage === null && litter === null) return null;
  return (
    <div className="flex flex-wrap gap-3">
      {stage !== null && (
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <Label htmlFor={`${id}-stage`}>{t('nutrients.stage.label')}</Label>
          <Select
            id={`${id}-stage`}
            value={stage}
            onChange={(e) => onChange({ stage: e.target.value as 'early' | 'late', litter: litter ?? undefined })}
            options={PREGNANCY_STAGES.map((value) => ({ value, label: t(`nutrients.stage.${value}`) }))}
          />
        </div>
      )}
      {litter !== null && (
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <Label htmlFor={`${id}-litter`}>{t('nutrients.litter.label')}</Label>
          <Select
            id={`${id}-litter`}
            value={String(litter)}
            onChange={(e) => onChange({ stage: stage ?? undefined, litter: e.target.value === '2' ? 2 : 1 })}
            options={[
              { value: '1', label: t('nutrients.litter.1') },
              { value: '2', label: t('nutrients.litter.2') },
            ]}
          />
        </div>
      )}
    </div>
  );
}

/** The balance of one ration: per herd it feeds, or the bare supply when no herd is on it. */
export function NutrientBalanceView({ data, onChoice }: { data: RationNutrients; onChoice: (choice: RequirementChoice) => void }) {
  const { t } = useTranslation('feed');
  const compared = data.herds.some((herd) => herd.requirement !== null);

  return (
    <div className="flex flex-col gap-3">
      {data.herds.length > 0 && <RequirementChoiceSelects stage={data.stage} litter={data.litter} onChange={onChoice} />}
      <MissingData missing={data.missing} title={t('nutrients.missingTitle')}>
        <p className="mt-1">{t('nutrients.missingHint')}</p>
      </MissingData>

      {data.herds.length === 0 && (
        <>
          <p className="text-sm text-muted-foreground">{t('nutrients.noHerd')}</p>
          <BalanceLines lines={supplyLines(data.supply)} />
        </>
      )}

      {data.herds.map((herd) => (
        <section key={herd.herdId} className="flex flex-col gap-2">
          <div>
            <p className="text-sm font-medium break-words">{t('nutrients.herd', { name: herd.herdName, head: herd.head })}</p>
            {herd.avgWeightKg !== null && (
              <p className="text-xs text-muted-foreground">
                {t('nutrients.weight', { weight: formatNumber(herd.avgWeightKg, 1), weighed: herd.weighedHead, head: herd.head })}
              </p>
            )}
            {herd.requirement?.weightClamped && (
              <p className="text-xs text-muted-foreground">{t('nutrients.clamped', { used: formatNumber(herd.requirement.weightUsedKg, 0) })}</p>
            )}
          </div>
          {herd.reason && <p className="text-sm text-muted-foreground">{t(`nutrients.reasons.${herd.reason}`)}</p>}
          <BalanceLines lines={herd.lines} />
        </section>
      ))}

      <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2 text-sm">
        <span className="text-muted-foreground">{t('nutrients.roughage')}</span>
        <span className="font-medium tabular-nums">{formatPercent(data.roughageSharePct, 0)}</span>
      </div>
      {compared && <p className="text-xs text-muted-foreground">{t('nutrients.source')}</p>}
    </div>
  );
}

function Heading() {
  const { t } = useTranslation('feed');
  return (
    <div>
      <p className="text-sm font-semibold">{t('nutrients.title')}</p>
      <p className="text-xs text-muted-foreground">{t('nutrients.perHeadDay')}</p>
    </div>
  );
}

/** Nutrient balance of a saved ration, on its card. No money in it: everyone who sees rations sees this. */
export function RationNutrientsSection({ rationId }: { rationId: string }) {
  const [choice, setChoice] = useState<RequirementChoice>({});
  const balance = useDetail<RationNutrients>(`/feed/rations/${rationId}/nutrients`, { ...choice }, { placeholderData: keepPreviousData });

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <Heading />
      {balance.isLoading && <Skeleton className="h-40" />}
      {balance.error && <ErrorCard error={balance.error} onRetry={() => void balance.refetch()} className="py-6" />}
      {balance.data && !balance.error && <NutrientBalanceView data={balance.data} onChoice={setChoice} />}
    </div>
  );
}

/** The value, once it has stopped changing for a moment: typing an amount does not ask on every key. */
function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

interface DraftLine {
  itemId?: string | null;
  kgPerHeadDay?: number | null;
}

/** The same balance while a ration is being edited, from the lines as they stand. Saves nothing. */
export function RationDraftBalance({ rationId, state, lines }: { rationId?: string; state: string; lines: (DraftLine | undefined)[] }) {
  const { t } = useTranslation('feed');
  const [choice, setChoice] = useState<RequirementChoice>({});
  const complete = lines.flatMap((line) =>
    line?.itemId && typeof line.kgPerHeadDay === 'number' && line.kgPerHeadDay > 0 && line.kgPerHeadDay <= 100
      ? [{ itemId: line.itemId, kgPerHeadDay: line.kgPerHeadDay }]
      : [],
  );
  // A string, so that the same lines typed again are the same request.
  const body = useSettled(complete.length > 0 ? JSON.stringify({ rationId, state, lines: complete, ...choice }) : null, 400);
  const balance = useQuery<RationNutrients>({
    queryKey: ['feed', 'nutrient-balance', body],
    queryFn: () => api.post<RationNutrients>('/feed/nutrient-balance', JSON.parse(body as string)),
    enabled: body !== null,
    placeholderData: keepPreviousData,
  });

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <Heading />
      {body === null && <p className="text-sm text-muted-foreground">{t('nutrients.draftEmpty')}</p>}
      {body !== null && balance.isLoading && <Skeleton className="h-40" />}
      {body !== null && balance.error && <ErrorCard error={balance.error} onRetry={() => void balance.refetch()} className="py-6" />}
      {body !== null && balance.data && !balance.error && <NutrientBalanceView data={balance.data} onChoice={setChoice} />}
    </div>
  );
}
