import { SEVERITIES } from '@yap/shared';
import { Activity, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTable, useUrlParam } from '@/components';
import { Badge, type BadgeVariant, DateInput, Label, Select } from '@/components/ui';
import { formatDateTime, formatNumber, formatPercent } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';

interface DeviceEvent {
  id: string;
  occurredAt: string;
  source: 'camera' | 'sensor';
  type: string;
  severity: string;
  deviceId: string | null;
  deviceName: string | null;
  /** The frame through our own API, which is what the page's CSP lets it show. */
  snapshotLink: string | null;
  data: { snapshotUrl?: string; sample?: boolean } & Record<string, unknown>;
}

const SEVERITY_VARIANT: Record<string, BadgeVariant> = { info: 'neutral', attention: 'warning', urgent: 'danger' };

/** A sensor's reading, for the payloads the app knows. Anything else is a dash rather than a guess. */
function reading(data: DeviceEvent['data']): string {
  const parts: string[] = [];
  if (typeof data.celsius === 'number') parts.push(`${formatNumber(data.celsius, 1)} °C`);
  if (typeof data.humidity === 'number') parts.push(formatPercent(data.humidity, 0));
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/** Only http(s) links reach the page: the API validates this, and this guards older rows. */
const safeSnapshot = (url: unknown): string | null => (typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null);

/** The server cannot reach a gateway on the farm's own network, but a phone on that network can. */
function Snapshot({ link, source }: { link: string; source: string | null }) {
  const { t } = useTranslation('cameras');
  const [failed, setFailed] = useState(false);

  if (failed) {
    if (!source) return '—';
    return (
      <a href={source} target="_blank" rel="noreferrer noopener" className="focus-ring inline-flex min-h-11 items-center gap-1 rounded text-sm text-primary underline-offset-4 hover:underline">
        <ExternalLink className="size-4" aria-hidden />
        {t('events.openSnapshot')}
      </a>
    );
  }
  return (
    <a href={link} target="_blank" rel="noreferrer noopener" className="focus-ring inline-block rounded" aria-label={t('events.openSnapshot')}>
      <img src={link} alt="" loading="lazy" onError={() => setFailed(true)} className="h-16 w-24 rounded object-cover md:h-11 md:w-16" />
    </a>
  );
}

export function EventsTab() {
  const { t } = useTranslation('cameras');
  const [severity, setSeverity] = useUrlParam('severity');
  const [source, setSource] = useUrlParam('source');
  const [from, setFrom] = useUrlParam('from');
  const [to, setTo] = useUrlParam('to');

  const columns: Column<DeviceEvent>[] = [
    {
      key: 'type',
      header: t('events.event'),
      mobile: 'title',
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {t(`eventTypes.${row.type.split('.').pop()}`, { defaultValue: row.type })}
          {row.data.sample === true && <Badge variant="outline">{t('events.sample')}</Badge>}
        </span>
      ),
    },
    { key: 'deviceName', header: t('events.device'), cell: (row) => row.deviceName ?? '—', mobile: 'subtitle' },
    { key: 'value', header: t('events.value'), cell: (row) => <span className="whitespace-nowrap tabular-nums">{reading(row.data)}</span>, align: 'right' },
    { key: 'severity', header: t('events.severity'), cell: (row) => <Badge variant={SEVERITY_VARIANT[row.severity]}>{t(`enums:severity.${row.severity}`)}</Badge> },
    { key: 'occurredAt', header: t('events.time'), cell: (row) => formatDateTime(row.occurredAt) },
    {
      key: 'snapshot',
      header: t('events.snapshot'),
      cell: (row) => (row.snapshotLink ? <Snapshot link={row.snapshotLink} source={safeSnapshot(row.data.snapshotUrl)} /> : '—'),
    },
  ];

  return (
    <DataTable<DeviceEvent>
      path="/devices/events"
      params={{ severity: severity || undefined, source: source || undefined, from: from || undefined, to: to || undefined }}
      columns={columns}
      searchable={false}
      urlPrefix="e"
      filters={
        <>
          <Select aria-label={t('events.severity')} value={severity} onChange={(e) => setSeverity(e.target.value)} options={enumOptions('severity', SEVERITIES)} placeholder={t('events.allSeverities')} className="md:w-44" />
          <Select
            aria-label={t('events.source')}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            options={enumOptions('eventSource', ['camera', 'sensor'])}
            placeholder={t('events.allSources')}
            className="md:w-44"
          />
          {/* A bare dd/mm/yyyy box does not say whether it starts or ends the range. */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="events-from">{t('events.from')}</Label>
            <DateInput id="events-from" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="md:w-40" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="events-to">{t('events.to')}</Label>
            <DateInput id="events-to" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="md:w-40" />
          </div>
        </>
      }
      empty={{ icon: Activity, title: t('events.emptyTitle'), description: t('events.emptyBody') }}
    />
  );
}
