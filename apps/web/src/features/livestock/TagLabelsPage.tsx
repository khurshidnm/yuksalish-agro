import { useQuery } from '@tanstack/react-query';
import { QrCode } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { EmptyState, ErrorCard, PageHeader, useUrlParam } from '@/components';
import { LabelSheet, type LabelSize, LabelToolbar, type PrintLabel } from '@/components/scan/LabelSheet';
import { Combobox, Skeleton, apiOptions } from '@/components/ui';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { pathKey } from '@/lib/query';
import type { HerdLookup } from './shared';

const PATH = '/livestock/animals/tag-labels';

/** POST /livestock/animals/tag-labels: the tag, the herd and what the QR holds. Nothing else leaves the server. */
export interface TagLabel {
  id: string;
  tag: string;
  herdName: string | null;
  code: string;
}

export function tagPrintLabels(rows: TagLabel[]): PrintLabel[] {
  return rows.map((row) => ({ key: row.id, code: row.code, title: row.tag, subtitle: row.herdName }));
}

/** The ids the animal list handed over. They live in the router's state, so a reload falls back to the herd. */
function chosenIds(state: unknown): string[] {
  const ids = (state as { ids?: unknown } | null)?.ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/** A sheet of QR tags: for the animals ticked in the list, or for a whole herd. */
export default function TagLabelsPage() {
  const { t } = useTranslation('scan');
  const ids = chosenIds(useLocation().state);
  const [herd, setHerd] = useUrlParam('herd');
  const [size, setSize] = useState<LabelSize>('small');

  const body = ids.length > 0 ? { ids } : herd ? { herdId: herd } : null;
  const { data, error, isLoading, refetch } = useQuery<TagLabel[]>({
    queryKey: [...pathKey(PATH), body],
    queryFn: () => api.post<TagLabel[]>(PATH, body),
    enabled: body !== null,
  });

  const labels = tagPrintLabels(data ?? []);

  return (
    <>
      <PageHeader
        className="print:hidden"
        title={t('tags.title')}
        description={ids.length > 0 ? t('tags.chosen', { n: formatNumber(ids.length) }) : t('tags.description')}
        back={{ to: '/livestock/animals', label: t('tags.back') }}
      />
      <LabelToolbar count={labels.length} size={size} onSize={setSize}>
        {ids.length === 0 && (
          <Combobox
            className="w-full sm:w-64"
            placeholder={t('tags.herd')}
            value={herd || null}
            onChange={(value) => setHerd(value ?? '')}
            loadOptions={apiOptions<HerdLookup>('/livestock/herds/lookup', (h) => ({ value: h.id, label: h.name, hint: t('livestock:head', { count: h.headCount }) }))}
          />
        )}
      </LabelToolbar>
      {body === null ? (
        <EmptyState icon={QrCode} title={t('tags.pickTitle')} description={t('tags.pickBody')} />
      ) : error ? (
        <ErrorCard error={error} onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <Skeleton className="h-64 w-full" />
      ) : labels.length === 0 ? (
        <EmptyState icon={QrCode} title={t('tags.emptyTitle')} description={t('tags.emptyBody')} />
      ) : (
        <LabelSheet labels={labels} size={size} />
      )}
    </>
  );
}
