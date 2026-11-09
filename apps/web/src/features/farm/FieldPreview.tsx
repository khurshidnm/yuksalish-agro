import { keepPreviousData } from '@tanstack/react-query';
import { ExternalLink, Map as MapIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ErrorCard } from '@/components';
import { Badge, Button, Card, Skeleton } from '@/components/ui';
import { useDetail } from '@/lib/query';
import { FieldPhoto } from './FieldPhoto';
import type { FieldCard } from './types';
import { CROP_STATUS_VARIANT, fieldTitle, formatHa, useLocalName } from './utils';

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-medium break-words">{value}</dd>
    </div>
  );
}

/** The side panel of the fields list on wide screens: the field from above, and its key facts. */
export function FieldPreview({ id }: { id: string }) {
  const { t } = useTranslation('farm');
  const localName = useLocalName();
  const query = useDetail<FieldCard>(`/farm/fields/${id}`, undefined, { placeholderData: keepPreviousData });
  const field = query.data;

  if (query.error) return <ErrorCard error={query.error} onRetry={() => void query.refetch()} />;
  if (!field) return <Skeleton className="h-96 w-full rounded-xl" />;

  const crop = field.currentCrop;
  return (
    <Card data-testid="field-preview" className="sticky top-20 overflow-hidden">
      <FieldPhoto geometry={field.boundary} width={704} credit />
      <div className="flex flex-col gap-3 p-4">
        <div>
          <h2 className="text-lg leading-tight font-semibold tracking-tight text-heading">{fieldTitle(field)}</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge>{t(`enums:landUse.${field.landUse}`)}</Badge>
            {crop && <Badge variant={CROP_STATUS_VARIANT[crop.status]}>{t(`enums:cropPlanStatus.${crop.status}`)}</Badge>}
          </div>
        </div>
        <p className="text-[1.75rem] leading-tight font-semibold tracking-tight">{formatHa(field.areaHa)}</p>
        <dl className="divide-y divide-border">
          <Figure label={t('fields.currentCrop')} value={crop ? localName(crop.cropName) : '—'} />
          <Figure label={t('fields.soilType')} value={field.soilType ?? '—'} />
          <Figure label={t('fields.salinityLevel')} value={field.salinityLevel ? t(`salinity.${field.salinityLevel}`, { defaultValue: field.salinityLevel }) : '—'} />
          <Figure label={t('fields.irrigationSource')} value={field.irrigationSource ?? '—'} />
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" asChild>
            <Link to={`/farm/fields/${field.id}`}>
              <ExternalLink aria-hidden />
              {t('map.openCard')}
            </Link>
          </Button>
          {field.boundary && (
            <Button variant="outline" size="sm" asChild>
              <Link to={`/farm/map?focus=${field.id}`}>
                <MapIcon aria-hidden />
                {t('fields.showOnMap')}
              </Link>
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
