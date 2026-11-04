import { CheckCheck, HeartPulse, Stethoscope } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { z } from 'zod';
import { EmptyState, ErrorCard, FormDialog, TextField, useUrlParam } from '@/components';
import { Badge, Button, Card, Select, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { zOptionalText } from '@/lib/forms';
import { useApiMutation, useList } from '@/lib/query';
import { RecordDialog, type RecordPreset } from './RecordDialog';
import { ANIMALS_PATH, HEALTH_PATH } from './options';
import type { SickAnimal, SickReport } from './types';

const PATH = `${HEALTH_PATH}/sick-reports`;

const resolveSchema = z.object({ result: zOptionalText(300) });

/** An open report closes by its id; a sick animal with no report closes by the animal. */
interface Resolving {
  tag: string;
  path: string;
}

export function SickTab() {
  const { t } = useTranslation('vet');
  const canTreat = usePermission('health.update');

  const [status, setStatus] = useUrlParam('sStatus', 'open');
  const [resolving, setResolving] = useState<Resolving | null>(null);
  const [treating, setTreating] = useState<RecordPreset | null>(null);

  const reports = useList<SickReport>(PATH, { status, pageSize: 50 });
  const sickAnimals = useList<SickAnimal>(ANIMALS_PATH, { status: 'sick', pageSize: 100 }, { enabled: status === 'open' });
  const resolve = useApiMutation<z.output<typeof resolveSchema>>({
    mutationFn: (values) => api.post(resolving!.path, values),
    invalidate: [HEALTH_PATH, ANIMALS_PATH],
    silentError: true,
  });

  const rows = reports.data?.data ?? [];
  // The status can also be set on the animal card, and those animals still need the vet.
  const reported = new Set(rows.map((report) => report.animalId));
  const unreported = status === 'open' ? (sickAnimals.data?.data ?? []).filter((animal) => !reported.has(animal.id)) : [];

  return (
    <div className="space-y-3">
      <Select
        aria-label={t('sick.statusFilter')}
        value={status}
        onChange={(e) => setStatus(e.target.value)}
        options={[
          { value: 'open', label: t('sick.open') },
          { value: 'resolved', label: t('sick.resolved') },
        ]}
        className="md:w-48"
      />

      {reports.error && <ErrorCard error={reports.error} onRetry={() => void reports.refetch()} />}
      {reports.isLoading && <Skeleton className="h-32 w-full" />}
      {!reports.isLoading && !reports.error && rows.length === 0 && unreported.length === 0 && (
        <EmptyState icon={HeartPulse} title={status === 'open' ? t('sick.emptyTitle') : t('sick.emptyResolvedTitle')} description={status === 'open' ? t('sick.emptyBody') : undefined} />
      )}

      <ul className="grid gap-3 lg:grid-cols-2">
        {rows.map((report) => (
          <li key={report.id}>
            <Card className="space-y-2 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link className="text-lg font-semibold text-primary hover:underline" to={`/livestock/animals/${report.animalId}`}>
                  {report.tag}
                </Link>
                <Badge variant={report.reportStatus === 'open' ? 'danger' : 'success'}>{t(`enums:animalStatus.${report.animalStatus}`)}</Badge>
              </div>
              <p>{report.notes}</p>
              <p className="text-sm text-muted-foreground">
                {[formatDate(report.date), report.reportedBy, report.herdName].filter(Boolean).join(' · ')}
              </p>
              {report.result && (
                <p className="text-sm">
                  <span className="font-medium">{t('journal.result')}:</span> {report.result}
                </p>
              )}
              {report.photoUrls.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {report.photoUrls.map((url, index) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer">
                      <img src={url} alt={t('sick.photoOf', { tag: report.tag, number: index + 1 })} className="size-20 rounded-lg object-cover" loading="lazy" />
                    </a>
                  ))}
                </div>
              )}
              {report.reportStatus === 'open' && canTreat && (
                <div className="flex flex-col gap-2 pt-1 sm:flex-row">
                  <Button variant="outline" className="flex-1" onClick={() => setTreating({ type: 'treatment', animalId: report.animalId, animalTag: report.tag })}>
                    <Stethoscope aria-hidden />
                    {t('sick.treat')}
                  </Button>
                  <Button className="flex-1" onClick={() => setResolving({ tag: report.tag, path: `${PATH}/${report.id}/resolve` })}>
                    <CheckCheck aria-hidden />
                    {t('sick.recovered')}
                  </Button>
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>

      {unreported.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">{t('sick.unreportedTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('sick.unreportedHint')}</p>
          <ul className="grid gap-3 lg:grid-cols-2">
            {unreported.map((animal) => (
              <li key={animal.id}>
                <Card className="space-y-2 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link className="text-lg font-semibold text-primary hover:underline" to={`/livestock/animals/${animal.id}`}>
                      {animal.tag}
                    </Link>
                    <Badge variant="danger">{t(`enums:animalStatus.${animal.status}`)}</Badge>
                  </div>
                  {animal.herdName && <p className="text-sm text-muted-foreground">{animal.herdName}</p>}
                  {canTreat && (
                    <div className="flex flex-col gap-2 pt-1 sm:flex-row">
                      <Button variant="outline" className="flex-1" onClick={() => setTreating({ type: 'treatment', animalId: animal.id, animalTag: animal.tag })}>
                        <Stethoscope aria-hidden />
                        {t('sick.treat')}
                      </Button>
                      <Button className="flex-1" onClick={() => setResolving({ tag: animal.tag, path: `${HEALTH_PATH}/animals/${animal.id}/recover` })}>
                        <CheckCheck aria-hidden />
                        {t('sick.recovered')}
                      </Button>
                    </div>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}

      <RecordDialog open={treating !== null} onOpenChange={(open) => !open && setTreating(null)} preset={treating} />

      <FormDialog
        open={resolving !== null}
        onOpenChange={(open) => !open && setResolving(null)}
        title={t('sick.resolveTitle', { tag: resolving?.tag })}
        description={t('sick.resolveHint')}
        schema={resolveSchema}
        defaultValues={{ result: '' }}
        onSubmit={(values) => resolve.mutateAsync(values)}
        successMessage="common:toast.updated"
      >
        {(form) => <TextField form={form} name="result" label={t('journal.result')} />}
      </FormDialog>
    </div>
  );
}
