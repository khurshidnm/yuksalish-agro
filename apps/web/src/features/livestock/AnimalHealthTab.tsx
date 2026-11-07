import { todayIso } from '@yap/shared';
import { ClipboardList, Plus, Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { EmptyState, ErrorCard, MoneyText } from '@/components';
import { Alert, Badge, type BadgeVariant, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@/components/ui';
import { usePermission } from '@/lib/auth';
import { formatDate, formatQty } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { Detail } from './AnimalBreedingTab';
import { RecordDialog } from './vet/RecordDialog';
import { ANIMALS_PATH } from './vet/options';

interface NextDue {
  date: string;
  type: string;
  itemName: string | null;
}

interface AnimalHealthRecord {
  id: string;
  type: string;
  date: string;
  scope: 'animal' | 'herd';
  herdName: string | null;
  diagnosis: string | null;
  itemName: string | null;
  itemUnit: string | null;
  dose: number | null;
  doseUnit: string | null;
  courseDays: number | null;
  /** Null without pii.view. */
  vetName: string | null;
  result: string | null;
  withdrawalUntil: string | null;
  nextDueDate: string | null;
  reportStatus: string | null;
  endedOn: string | null;
  notes: string | null;
  /** Null for a herd record, and for anyone who cannot see money. */
  totalCost: number | null;
}

interface AnimalHealth {
  nextDue: NextDue[];
  records: AnimalHealthRecord[];
}

const TYPE_TONE: Record<string, BadgeVariant> = {
  vaccination: 'success',
  treatment: 'danger',
  prophylaxis: 'info',
  deworming: 'info',
  examination: 'neutral',
  quarantine: 'warning',
};

const useAnimalHealth = (animalId: string) => useDetail<AnimalHealth>(`${ANIMALS_PATH}/${animalId}/health`);

/** Soonest first. A quarantine's date is its end, which its own line already says. */
function upcoming(rows: NextDue[]): NextDue[] {
  return rows.filter((row) => row.type !== 'quarantine').sort((a, b) => a.date.localeCompare(b.date));
}

function DueLine({ row }: { row: NextDue }) {
  const { t } = useTranslation('livestock');
  return (
    <>
      <span className="flex flex-wrap items-center gap-2">
        <span className="tabular-nums">{formatDate(row.date)}</span>
        {row.date < todayIso() && <Badge variant="danger">{t('card.health.overdue')}</Badge>}
      </span>
      <span className="block text-sm font-normal text-muted-foreground">{[t(`enums:healthRecordType.${row.type}`), row.itemName].filter(Boolean).join(' · ')}</span>
    </>
  );
}

export function HealthCard({ animalId }: { animalId: string }) {
  const { t } = useTranslation('livestock');
  const { data, error, isLoading, refetch } = useAnimalHealth(animalId);

  const vaccination = data?.records.find((row) => row.type === 'vaccination');
  const sick = data?.records.find((row) => row.reportStatus === 'open');
  const quarantine = data?.records.find((row) => row.type === 'quarantine' && row.endedOn === null);
  const next = data ? upcoming(data.nextDue)[0] : undefined;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{t('card.health.title')}</CardTitle>
        <Button variant="ghost" size="sm" asChild>
          <Link to="?tab=health">{t('card.health.more')}</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {error ? (
          <ErrorCard error={error} onRetry={() => void refetch()} />
        ) : isLoading || !data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="space-y-3">
            {sick && (
              <Alert tone="danger" title={t('card.health.sickOpen')}>
                {[formatDate(sick.date), sick.notes].filter(Boolean).join(' · ')}
              </Alert>
            )}
            {quarantine && (
              <Alert tone="warning" title={t('card.health.quarantineOpen')}>
                {quarantine.nextDueDate && t('card.health.quarantineUntil', { date: formatDate(quarantine.nextDueDate) })}
              </Alert>
            )}
            <dl className="grid grid-cols-2 gap-4">
              <Detail label={t('card.health.lastVaccination')}>
                {formatDate(vaccination?.date)}
                {vaccination?.itemName && <span className="block text-sm font-normal text-muted-foreground">{vaccination.itemName}</span>}
              </Detail>
              <Detail label={t('vet:journal.nextDue')}>{next ? <DueLine row={next} /> : '—'}</Detail>
            </dl>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecordCard({ row }: { row: AnimalHealthRecord }) {
  const { t } = useTranslation('livestock');
  const isQuarantine = row.type === 'quarantine';
  return (
    <Card>
      <CardContent className="space-y-3 pt-4 md:pt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant={TYPE_TONE[row.type]}>{t(`enums:healthRecordType.${row.type}`)}</Badge>
            {row.reportStatus === 'open' && <Badge variant="danger">{t('card.health.sickOpen')}</Badge>}
            {row.reportStatus === 'resolved' && <Badge>{t('card.health.sickClosed')}</Badge>}
            {isQuarantine && row.endedOn === null && <Badge variant="warning">{t('card.health.quarantineOpen')}</Badge>}
          </span>
          <span className="font-medium tabular-nums">{formatDate(row.date)}</span>
        </div>

        {row.scope === 'herd' && (
          <p className="flex items-start gap-2 rounded-lg bg-info-soft p-3 text-sm text-info">
            <Users className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">
              <span className="font-semibold">{t('card.health.wholeHerd')}</span>
              {row.herdName && `: ${row.herdName}`}
            </span>
          </p>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          {row.diagnosis && (
            <Detail label={isQuarantine ? t('vet:quarantine.reason') : t('vet:journal.diagnosis')} className="col-span-2">
              {row.diagnosis}
            </Detail>
          )}
          <Detail label={t('vet:journal.drug')}>{row.itemName ?? '—'}</Detail>
          <Detail label={t('vet:journal.dose')}>{formatQty(row.dose, row.doseUnit || row.itemUnit)}</Detail>
          {row.courseDays !== null && <Detail label={t('vet:journal.courseDays')}>{t('vet:common.dayCount', { count: row.courseDays })}</Detail>}
          <Detail label={t('vet:journal.vet')}>{row.vetName ?? '—'}</Detail>
          <Detail label={t('vet:journal.result')}>{row.result ?? '—'}</Detail>
          <Detail label={t('vet:journal.withdrawalUntil')}>{formatDate(row.withdrawalUntil)}</Detail>
          <Detail label={isQuarantine ? t('vet:quarantine.until') : t('vet:journal.nextDue')}>{formatDate(row.nextDueDate)}</Detail>
          {row.endedOn && <Detail label={t('card.health.endedOn')}>{formatDate(row.endedOn)}</Detail>}
          {row.totalCost !== null && (
            <Detail label={t('vet:journal.cost')}>
              <MoneyText value={row.totalCost} />
            </Detail>
          )}
        </dl>

        {row.notes && <p className="rounded-lg bg-muted p-3 text-sm break-words">{row.notes}</p>}
      </CardContent>
    </Card>
  );
}

export function AnimalHealthTab({ animalId, tag, onFarm }: { animalId: string; tag: string; onFarm: boolean }) {
  const { t } = useTranslation('livestock');
  const canAdd = usePermission('health.update') && onFarm;
  const [adding, setAdding] = useState(false);
  const { data, error, isLoading, refetch } = useAnimalHealth(animalId);

  if (error) return <ErrorCard error={error} onRetry={() => void refetch()} />;
  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const addButton = canAdd && (
    <Button className="w-full sm:w-auto" onClick={() => setAdding(true)}>
      <Plus aria-hidden />
      {t('vet:journal.add')}
    </Button>
  );
  const due = upcoming(data.nextDue);

  return (
    <div className="space-y-4">
      {data.records.length === 0 ? (
        <EmptyState icon={ClipboardList} title={t('card.health.emptyTitle')} description={t('card.health.emptyBody')} action={addButton} />
      ) : (
        <>
          {addButton && <div className="flex justify-end">{addButton}</div>}
          {due.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>{t('card.health.upcoming')}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-border">
                  {due.map((row, index) => (
                    <li key={index} className="py-2 font-medium first:pt-0 last:pb-0">
                      <DueLine row={row} />
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          <ul className="space-y-3">
            {data.records.map((row) => (
              <li key={row.id}>
                <RecordCard row={row} />
              </li>
            ))}
          </ul>
        </>
      )}
      <RecordDialog open={adding} onOpenChange={setAdding} preset={{ animalId, animalTag: tag }} />
    </div>
  );
}
