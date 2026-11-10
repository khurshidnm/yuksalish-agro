/**
 * Where the flock spent its time (docs/tracking.md): the key to the shading on the map, and how
 * long the sheep stood on each field. The figures are counted each night from stored positions.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorCard } from '@/components';
import { Card, CardContent, Skeleton, TBody, Table, Td, Th, THead, Tr } from '@/components/ui';
import { formatDate, formatNumber, formatPercent } from '@/lib/format';
import { HEAT_OPACITY } from './TrackingMap';
import type { GrazingData, GrazingField } from './types';

const fieldLabel = (f: GrazingField) => [f.number, f.name].filter(Boolean).join(' · ');

function HeatLegend() {
  const { t } = useTranslation('tracking');
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" role="img" aria-label={`${t('grazing.legend')}: ${t('grazing.less')} – ${t('grazing.more')}`}>
      <span aria-hidden>{t('grazing.less')}</span>
      <span className="flex overflow-hidden rounded-sm border border-border bg-card" aria-hidden>
        {HEAT_OPACITY.map((opacity) => (
          <span key={opacity} className="block h-3 w-6 bg-chart-5" style={{ opacity }} />
        ))}
      </span>
      <span aria-hidden>{t('grazing.more')}</span>
    </div>
  );
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm tabular-nums">{children}</dd>
    </div>
  );
}

function FieldFigures({ fields }: { fields: GrazingField[] }) {
  const { t } = useTranslation('tracking');
  const share = (f: GrazingField) => formatPercent(f.share * 100, 1);
  return (
    <>
      <ul className="space-y-3 md:hidden">
        {fields.map((f) => (
          <li key={f.fieldId} className="space-y-2 border-b border-border pb-3 last:border-0 last:pb-0">
            <p className="font-semibold break-words">{fieldLabel(f)}</p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              <Figure label={t('grazing.fields.animalDays')}>{formatNumber(f.animalDays, 0)}</Figure>
              <Figure label={t('grazing.fields.hours')}>{formatNumber(f.animalHours, 1)}</Figure>
              <Figure label={t('grazing.fields.daysUsed')}>{formatNumber(f.daysUsed, 0)}</Figure>
              <Figure label={t('grazing.fields.share')}>{share(f)}</Figure>
              <Figure label={t('grazing.fields.perHa')}>{formatNumber(f.animalDaysPerHa, 1)}</Figure>
            </dl>
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
        <Table>
          <THead>
            <Tr>
              <Th>{t('grazing.fields.field')}</Th>
              <Th className="text-right">{t('grazing.fields.animalDays')}</Th>
              <Th className="text-right">{t('grazing.fields.hours')}</Th>
              <Th className="text-right">{t('grazing.fields.daysUsed')}</Th>
              <Th className="text-right">{t('grazing.fields.share')}</Th>
              <Th className="text-right">{t('grazing.fields.perHa')}</Th>
            </Tr>
          </THead>
          <TBody>
            {fields.map((f) => (
              <Tr key={f.fieldId}>
                <Td className="font-medium">{fieldLabel(f)}</Td>
                <Td className="text-right tabular-nums">{formatNumber(f.animalDays, 0)}</Td>
                <Td className="text-right tabular-nums">{formatNumber(f.animalHours, 1)}</Td>
                <Td className="text-right tabular-nums">{formatNumber(f.daysUsed, 0)}</Td>
                <Td className="text-right tabular-nums">{share(f)}</Td>
                <Td className="text-right tabular-nums">{formatNumber(f.animalDaysPerHa, 1)}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </div>
    </>
  );
}

export function GrazingPanel({ data, error, onRetry }: { data: GrazingData | undefined; error: unknown; onRetry: () => void }) {
  const { t } = useTranslation('tracking');
  if (!data) return error ? <ErrorCard error={error} onRetry={onRetry} /> : <Skeleton className="h-40 w-full" />;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{t('grazing.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('grazing.period', { from: formatDate(data.from), to: formatDate(data.to) })}</p>
        </div>
        {data.totalFixes === null || !data.cells ? (
          // No stored position in the period: said so, not drawn as an empty pasture.
          <p className="text-sm text-muted-foreground">{t('grazing.noData')}</p>
        ) : (
          <>
            <HeatLegend />
            <p className="text-sm text-muted-foreground">
              {t('grazing.presence')}
              {data.truncated && ` ${t('grazing.truncated')}`}
            </p>
            <h3 className="pt-1 text-sm font-semibold">{t('grazing.byField')}</h3>
            {data.fields?.length ? (
              <>
                <FieldFigures fields={data.fields} />
                <p className="text-xs text-muted-foreground">{t('grazing.animalDaysHint', { hours: formatNumber(data.minAnimalDayHours, 1) })}</p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('grazing.noFields')}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
