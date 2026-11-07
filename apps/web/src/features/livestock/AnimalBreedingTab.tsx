import { Baby, Pencil } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { z } from 'zod';
import { ComboboxField, EmptyState, ErrorCard, FormDialog, StatCard } from '@/components';
import { Alert, Badge, type BadgeVariant, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber, formatPercent, formatQty } from '@/lib/format';
import { zRef } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';
import { categoryLabel } from './category';
import { ANIMALS_PATH, BREEDING_PATH, animalOptions } from './vet/options';
import type { InbreedingCheck, LambDetail } from './vet/types';

interface Mating {
  id: string;
  source: 'mating' | 'purchase';
  matingDate: string;
  expectedDate: string;
  status: 'pregnant' | 'lambed' | 'aborted' | 'failed';
  ramId: string | null;
  ramTag: string | null;
  notes: string | null;
  canSetRam: boolean;
  lambing: { id: string; date: string; lambsBorn: number; lambsAlive: number } | null;
}

interface Birth {
  id: string;
  breedingId: string | null;
  date: string;
  lambsBorn: number;
  lambsAlive: number;
  complications: string | null;
  ramId: string | null;
  ramTag: string | null;
  lambs: LambDetail[];
}

interface AnimalBreeding {
  summary: {
    lambings: number;
    lambsBorn: number;
    lambsAlive: number;
    survivalPercent: number | null;
    avgWeight100Kg: number | null;
    lastLambingDate: string | null;
  };
  matings: Mating[];
  lambings: Birth[];
}

interface BreedingProps {
  animalId: string;
  speciesKey: string | null;
}

const STATUS_TONE: Record<Mating['status'], BadgeVariant> = {
  pregnant: 'info',
  lambed: 'success',
  aborted: 'danger',
  failed: 'neutral',
};

const ramSchema = z.object({ ramId: zRef() });

/** The pseudo-element stretches the tap area to 44 px without moving the text. */
const PASSPORT_LINK = 'relative min-w-0 font-medium break-words text-primary underline underline-offset-2 after:absolute after:inset-x-0 after:-inset-y-3';

export function Detail({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-medium break-words">{children}</dd>
    </div>
  );
}

const useBreeding = (animalId: string) => useDetail<AnimalBreeding>(`${ANIMALS_PATH}/${animalId}/breeding`);

/** The category lists name a young animal only with its sex, and a count needs plural forms. */
function useYoungWords(speciesKey: string | null) {
  const { t } = useTranslation('livestock');
  const keys = (group: string) => [`card.breeding.${group}.${speciesKey}`, `card.breeding.${group}.other`];
  return { plural: t(keys('young')), count: (count: number) => t(keys('youngCount'), { count }) };
}

function RamName({ ramId, ramTag, arrivedPregnant }: { ramId: string | null; ramTag: string | null; arrivedPregnant: boolean }) {
  const { t } = useTranslation('livestock');
  if (ramId) {
    return (
      <Link className={PASSPORT_LINK} to={`/livestock/animals/${ramId}`}>
        {ramTag ?? t('card.breeding.unknown')}
      </Link>
    );
  }
  return (
    <>
      {t('card.breeding.unknown')}
      {arrivedPregnant && <span className="block text-sm font-normal text-muted-foreground">{t('card.breeding.arrivedPregnant')}</span>}
    </>
  );
}

export function BreedingCard({ animalId, speciesKey }: BreedingProps) {
  const { t } = useTranslation('livestock');
  const young = useYoungWords(speciesKey);
  const { data, error, isLoading, refetch } = useBreeding(animalId);
  const last = data?.matings[0];

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{t('card.breeding.title')}</CardTitle>
        <Button variant="ghost" size="sm" asChild>
          <Link to="?tab=breeding">{t('card.breeding.more')}</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {error ? (
          <ErrorCard error={error} onRetry={() => void refetch()} />
        ) : isLoading || !data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <dl className="grid grid-cols-2 gap-4">
            <Detail label={categoryLabel('ram', speciesKey)}>
              {last ? <RamName ramId={last.ramId} ramTag={last.ramTag} arrivedPregnant={last.source === 'purchase'} /> : '—'}
            </Detail>
            <Detail label={t('vet:pregnancies.matingDate')}>{formatDate(last?.matingDate)}</Detail>
            <Detail label={t('card.breeding.births')} className="col-span-2">
              {data.summary.lambings > 0
                ? t('card.breeding.birthsLine', { times: t('card.breeding.times', { count: data.summary.lambings }), young: young.count(data.summary.lambsBorn) })
                : t('card.breeding.noBirths')}
              <span className="block text-sm font-normal text-muted-foreground">{t('card.breeding.farmOnlyShort')}</span>
            </Detail>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function InbreedingNotice({ eweId, ramId }: { eweId: string; ramId?: string | null }) {
  const { t } = useTranslation('livestock');
  const { data } = useDetail<InbreedingCheck>(ramId ? `${BREEDING_PATH}/inbreeding-check` : null, ramId ? { eweId, ramId } : undefined);
  if (!data?.related) return null;
  return (
    <Alert tone="warning" title={t('vet:pregnancies.inbreedingTitle')}>
      {t('card.breeding.inbreedingBody', { tags: data.common.map((c) => c.tag ?? '?').join(', ') })}
    </Alert>
  );
}

function LambRow({ lamb }: { lamb: LambDetail }) {
  const { t } = useTranslation('livestock');
  const name = lamb.tag ?? t('card.breeding.noTag');
  return (
    <li className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        {lamb.animalId ? (
          <Link className={PASSPORT_LINK} to={`/livestock/animals/${lamb.animalId}`}>
            {name}
          </Link>
        ) : (
          lamb.alive && <span className="font-medium break-words">{name}</span>
        )}
        {!lamb.alive && <Badge variant="danger">{t('vet:lambing.stillborn')}</Badge>}
      </span>
      <span className="text-sm text-muted-foreground">
        {t(`enums:sex.${lamb.sex}`)} · {formatQty(lamb.birthWeightKg, 'kg', 1)}
      </span>
    </li>
  );
}

export function AnimalBreedingTab({ animalId, speciesKey, tag }: BreedingProps & { tag: string }) {
  const { t } = useTranslation('livestock');
  const canChange = usePermission('livestock.update') || usePermission('health.update');
  const young = useYoungWords(speciesKey);
  const { data, error, isLoading, refetch } = useBreeding(animalId);
  const [settingRam, setSettingRam] = useState<Mating | null>(null);

  const setRam = useApiMutation<z.output<typeof ramSchema>>({
    mutationFn: (values) => api.patch(`${BREEDING_PATH}/${settingRam!.id}`, values),
    invalidate: [BREEDING_PATH, ANIMALS_PATH],
    silentError: true,
  });

  if (error) return <ErrorCard error={error} onRetry={() => void refetch()} />;
  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (data.matings.length === 0 && data.lambings.length === 0) {
    return <EmptyState icon={Baby} title={t('card.breeding.emptyTitle')} description={t('card.breeding.emptyBody')} />;
  }

  const { summary } = data;
  const ramWord = categoryLabel('ram', speciesKey);
  const bought = new Set(data.matings.filter((row) => row.source === 'purchase').map((row) => row.id));

  const matingResult = (row: Mating) => {
    if (row.lambing) {
      return t('card.breeding.result.born', { date: formatDate(row.lambing.date), young: young.count(row.lambing.lambsBorn), alive: formatNumber(row.lambing.lambsAlive, 0) });
    }
    if (row.status === 'pregnant') return t('card.breeding.result.pending');
    return row.status === 'lambed' ? '—' : t('card.breeding.result.none');
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          label={t('card.breeding.births')}
          value={formatNumber(summary.lambings, 0)}
          hint={summary.lastLambingDate ? t('card.breeding.lastBirth', { date: formatDate(summary.lastLambingDate) }) : undefined}
        />
        <StatCard label={t('card.breeding.bornTile', { word: young.plural })} value={formatNumber(summary.lambsBorn, 0)} />
        <StatCard label={t('card.breeding.aliveTile', { word: young.plural })} value={formatNumber(summary.lambsAlive, 0)} />
        <StatCard label={t('vet:kpis.survival')} value={formatPercent(summary.survivalPercent)} hint={t('vet:kpis.survivalHint')} />
        <StatCard label={t('vet:kpis.weight100')} value={formatQty(summary.avgWeight100Kg, 'kg', 1)} className="col-span-2 lg:col-span-1" />
      </div>

      <Alert tone="info">{t('card.breeding.farmOnly')}</Alert>

      <Card>
        <CardHeader>
          <CardTitle>{t('card.breeding.matings')}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.matings.length === 0 ? (
            <EmptyState icon={Baby} title={t('card.breeding.matingsEmpty')} className="py-6" />
          ) : (
            <ul className="divide-y divide-border">
              {data.matings.map((row) => (
                <li key={row.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium tabular-nums">{formatDate(row.matingDate)}</span>
                    <Badge variant={STATUS_TONE[row.status]}>{t(`card.breeding.status.${row.status}`)}</Badge>
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3">
                    <Detail label={ramWord}>
                      <RamName ramId={row.ramId} ramTag={row.ramTag} arrivedPregnant={row.source === 'purchase'} />
                    </Detail>
                    <Detail label={t('vet:pregnancies.expected')}>{formatDate(row.expectedDate)}</Detail>
                    <Detail label={t('vet:pregnancies.outcome')} className="col-span-2">
                      {matingResult(row)}
                    </Detail>
                  </dl>
                  {row.notes && <p className="mt-2 rounded-lg bg-muted p-3 text-sm break-words">{row.notes}</p>}
                  {row.canSetRam && canChange && (
                    <Button variant="outline" size="sm" className="mt-3 w-full sm:w-auto" onClick={() => setSettingRam(row)}>
                      <Pencil aria-hidden />
                      {t('card.breeding.setRam', { ram: ramWord })}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('card.breeding.births')}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.lambings.length === 0 ? (
            <EmptyState icon={Baby} title={t('card.breeding.birthsEmpty')} className="py-6" />
          ) : (
            <ul className="divide-y divide-border">
              {data.lambings.map((row) => (
                <li key={row.id} className="py-3 first:pt-0 last:pb-0">
                  <p className="font-medium tabular-nums">{formatDate(row.date)}</p>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3">
                    <Detail label={ramWord}>
                      <RamName ramId={row.ramId} ramTag={row.ramTag} arrivedPregnant={row.breedingId !== null && bought.has(row.breedingId)} />
                    </Detail>
                    <Detail label={t('vet:lambing.bornAlive')}>{`${formatNumber(row.lambsAlive, 0)} / ${formatNumber(row.lambsBorn, 0)}`}</Detail>
                    <Detail label={t('vet:lambing.complications')} className="col-span-2">
                      {row.complications ?? '—'}
                    </Detail>
                  </dl>
                  {row.lambs.length > 0 && (
                    <ul className="mt-2 divide-y divide-border rounded-lg bg-muted px-3">
                      {row.lambs.map((lamb, index) => (
                        <LambRow key={lamb.animalId ?? index} lamb={lamb} />
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <FormDialog
        open={settingRam !== null}
        onOpenChange={(open) => !open && setSettingRam(null)}
        title={t('card.breeding.setRamTitle', { tag, ram: ramWord })}
        schema={ramSchema}
        defaultValues={{ ramId: settingRam?.ramId ?? '' }}
        onSubmit={(values) => setRam.mutateAsync(values)}
        successMessage="common:toast.updated"
      >
        {(form) => (
          <>
            <ComboboxField form={form} name="ramId" label={ramWord} required loadOptions={animalOptions({ sex: 'male', forBreeding: 'true' })} selectedLabel={settingRam?.ramTag} />
            <InbreedingNotice eweId={animalId} ramId={form.watch('ramId')} />
          </>
        )}
      </FormDialog>
    </div>
  );
}
