import { SEVERITIES } from '@yap/shared';
import { Activity } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTable, useUrlParam } from '@/components';
import { Badge, type BadgeVariant, DateInput, Select } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';

interface DeviceEvent {
  id: string;
  occurredAt: string;
  source: 'camera' | 'sensor';
  type: string;
  severity: string;
  deviceId: string | null;
  deviceName: string | null;
  data: { snapshotUrl?: string; sample?: boolean } & Record<string, unknown>;
}

const SEVERITY_VARIANT: Record<string, BadgeVariant> = { info: 'neutral', attention: 'warning', urgent: 'danger' };

/** Only http(s) links reach the page: the API validates this, and this guards older rows. */
const safeSnapshot = (url: unknown): string | null => (typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null);

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
    { key: 'severity', header: t('events.severity'), cell: (row) => <Badge variant={SEVERITY_VARIANT[row.severity]}>{t(`enums:severity.${row.severity}`)}</Badge> },
    { key: 'occurredAt', header: t('events.time'), cell: (row) => formatDateTime(row.occurredAt) },
    {
      key: 'snapshot',
      header: t('events.snapshot'),
      mobile: 'hidden',
      cell: (row) => {
        const url = safeSnapshot(row.data.snapshotUrl);
        if (!url) return '—';
        return (
          <a href={url} target="_blank" rel="noreferrer noopener" className="focus-ring inline-block rounded" aria-label={t('events.openSnapshot')}>
            <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-10 w-16 rounded object-cover" />
          </a>
        );
      },
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
          <DateInput aria-label={t('events.from')} value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="md:w-40" />
          <DateInput aria-label={t('events.to')} value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="md:w-40" />
        </>
      }
      empty={{ icon: Activity, title: t('events.emptyTitle'), description: t('events.emptyBody') }}
    />
  );
}
