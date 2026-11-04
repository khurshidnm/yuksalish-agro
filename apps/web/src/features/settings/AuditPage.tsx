import { EVENT_SOURCES, SEVERITIES } from '@yap/shared';
import { ArrowRight, BookOpenText, History } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTable, PageHeader, UrlTabs, useUrlParam } from '@/components';
import { Badge, type BadgeVariant, DateInput, Select, Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { useDetail } from '@/lib/query';
import { displayValue } from './shared';

type Row = Record<string, unknown> | null;

interface AuditEntry {
  id: string;
  at: string;
  entity: string;
  entityId: string | null;
  action: 'insert' | 'update' | 'delete';
  before: Row;
  after: Row;
  ip: string | null;
  device: string | null;
  userId: string | null;
  userName: string | null;
}

interface JournalEntry {
  id: string;
  occurredAt: string;
  source: string;
  type: string;
  severity: string;
  entityType: string | null;
  entityId: string | null;
  data: Record<string, unknown>;
  userName: string | null;
}

const ACTION_VARIANT: Record<AuditEntry['action'], BadgeVariant> = { insert: 'success', update: 'info', delete: 'danger' };
const SEVERITY_VARIANT: Record<string, BadgeVariant> = { info: 'neutral', attention: 'warning', urgent: 'danger' };

/** Fields that differ. `updated_at` moves on every write, so it says nothing. */
function changedFields(before: Row, after: Row): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  keys.delete('updated_at');
  return [...keys].filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])).sort();
}

/** What left and joined a list. A whole-array before and after hides the one item that changed. */
function listChanges(before: unknown[], after: unknown[]) {
  const keys = (list: unknown[]) => new Set(list.map((item) => JSON.stringify(item)));
  const [had, has] = [keys(before), keys(after)];
  return {
    removed: before.filter((item) => !has.has(JSON.stringify(item))),
    added: after.filter((item) => !had.has(JSON.stringify(item))),
  };
}

function DiffRow({ field, before, after, showBefore, showAfter }: { field: string; before: unknown; after: unknown; showBefore: boolean; showAfter: boolean }) {
  const list = showBefore && showAfter && Array.isArray(before) && Array.isArray(after) ? listChanges(before, after) : null;
  return (
    <div className="border-b border-border py-2.5 last:border-b-0">
      <p className="mb-1 font-mono text-xs text-muted-foreground">{field}</p>
      {list && list.removed.length + list.added.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5 text-sm break-all">
          {list.removed.map((item, i) => (
            <li key={`removed-${i}`} className="rounded bg-danger-soft px-1.5 py-0.5 text-danger">
              − {displayValue(item)}
            </li>
          ))}
          {list.added.map((item, i) => (
            <li key={`added-${i}`} className="rounded bg-success-soft px-1.5 py-0.5 text-success">
              + {displayValue(item)}
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-sm break-all">
          {showBefore && <span className={showAfter ? 'rounded bg-danger-soft px-1.5 py-0.5 text-danger' : ''}>{displayValue(before)}</span>}
          {showBefore && showAfter && <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
          {showAfter && <span className={showBefore ? 'rounded bg-success-soft px-1.5 py-0.5 text-success' : ''}>{displayValue(after)}</span>}
        </div>
      )}
    </div>
  );
}

function AuditDetail({ entry, onClose }: { entry: AuditEntry | null; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const fields = entry ? changedFields(entry.before, entry.after) : [];
  return (
    <Sheet open={entry !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-[34rem] overflow-y-auto">
        {entry && (
          <div className="flex flex-col gap-4 p-4 pt-12">
            <div>
              <SheetTitle className="text-lg font-semibold">
                {t(`audit.actions.${entry.action}`)}: {t(`entities.${entry.entity}`, { defaultValue: entry.entity })}
              </SheetTitle>
              <SheetDescription className="text-sm text-muted-foreground">
                {formatDateTime(entry.at)} · {entry.userName ?? t('audit.system')}
              </SheetDescription>
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t('audit.recordId')}</dt>
              <dd className="font-mono text-xs break-all">{entry.entityId ?? '—'}</dd>
              {entry.ip && (
                <>
                  <dt className="text-muted-foreground">IP</dt>
                  <dd>{entry.ip}</dd>
                </>
              )}
              {entry.device && (
                <>
                  <dt className="text-muted-foreground">{t('audit.device')}</dt>
                  <dd className="break-all">{entry.device}</dd>
                </>
              )}
            </dl>
            <div>
              <h3 className="mb-1 text-sm font-semibold">{entry.action === 'update' ? t('audit.changes') : t('audit.values')}</h3>
              {fields.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('audit.noVisibleChanges')}</p>
              ) : (
                fields.map((field) => (
                  <DiffRow
                    key={field}
                    field={field}
                    before={entry.before?.[field]}
                    after={entry.after?.[field]}
                    showBefore={entry.action !== 'insert'}
                    showAfter={entry.action !== 'delete'}
                  />
                ))
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DateRange({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void }) {
  const { t } = useTranslation('settings');
  return (
    <>
      <DateInput aria-label={t('audit.from')} value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="md:w-40" />
      <DateInput aria-label={t('audit.to')} value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="md:w-40" />
    </>
  );
}

function ChangesTab() {
  const { t } = useTranslation('settings');
  const [entity, setEntity] = useUrlParam('entity');
  const [action, setAction] = useUrlParam('action');
  const [from, setFrom] = useUrlParam('from');
  const [to, setTo] = useUrlParam('to');
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const entities = useDetail<string[]>('/settings/audit/entities');

  const columns: Column<AuditEntry>[] = [
    { key: 'at', header: t('audit.time'), cell: (row) => formatDateTime(row.at), mobile: 'subtitle' },
    { key: 'entity', header: t('audit.entity'), cell: (row) => t(`entities.${row.entity}`, { defaultValue: row.entity }), mobile: 'title' },
    { key: 'action', header: t('audit.action'), cell: (row) => <Badge variant={ACTION_VARIANT[row.action]}>{t(`audit.actions.${row.action}`)}</Badge> },
    { key: 'userName', header: t('audit.user'), cell: (row) => row.userName ?? t('audit.system') },
    {
      key: 'changes',
      header: t('audit.changedFields'),
      mobile: 'hidden',
      cell: (row) => (row.action === 'update' ? changedFields(row.before, row.after).join(', ') || '—' : '—'),
    },
  ];

  return (
    <>
      <DataTable<AuditEntry>
        path="/settings/audit"
        params={{ entity: entity || undefined, action: action || undefined, from: from || undefined, to: to || undefined }}
        columns={columns}
        searchable={false}
        urlPrefix="a"
        onRowClick={setOpen}
        filters={
          <>
            <Select
              aria-label={t('audit.entity')}
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
              options={(entities.data ?? []).map((value) => ({ value, label: t(`entities.${value}`, { defaultValue: value }) }))}
              placeholder={t('audit.allEntities')}
              className="md:w-52"
            />
            <Select
              aria-label={t('audit.action')}
              value={action}
              onChange={(e) => setAction(e.target.value)}
              options={(['insert', 'update', 'delete'] as const).map((value) => ({ value, label: t(`audit.actions.${value}`) }))}
              placeholder={t('audit.allActions')}
              className="md:w-44"
            />
            <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
          </>
        }
        empty={{ icon: History, title: t('audit.emptyTitle'), description: t('audit.emptyBody') }}
      />
      <AuditDetail entry={open} onClose={() => setOpen(null)} />
    </>
  );
}

function JournalDetail({ entry, onClose }: { entry: JournalEntry | null; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const pairs = Object.entries(entry?.data ?? {});
  return (
    <Sheet open={entry !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-[30rem] overflow-y-auto">
        {entry && (
          <div className="flex flex-col gap-4 p-4 pt-12">
            <div>
              <SheetTitle className="font-mono text-base font-semibold break-all">{entry.type}</SheetTitle>
              <SheetDescription className="text-sm text-muted-foreground">
                {formatDateTime(entry.occurredAt)} · {entry.userName ?? t(`enums:eventSource.${entry.source}`)}
              </SheetDescription>
            </div>
            {pairs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('audit.noDetails')}</p>
            ) : (
              <dl className="flex flex-col">
                {pairs.map(([key, value]) => (
                  <div key={key} className="border-b border-border py-2 last:border-b-0">
                    <dt className="font-mono text-xs text-muted-foreground">{key}</dt>
                    <dd className="text-sm break-all">{displayValue(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function JournalTab() {
  const { t } = useTranslation('settings');
  const [source, setSource] = useUrlParam('source');
  const [severity, setSeverity] = useUrlParam('severity');
  const [from, setFrom] = useUrlParam('jfrom');
  const [to, setTo] = useUrlParam('jto');
  const [open, setOpen] = useState<JournalEntry | null>(null);

  const columns: Column<JournalEntry>[] = [
    { key: 'occurredAt', header: t('audit.time'), cell: (row) => formatDateTime(row.occurredAt), mobile: 'subtitle' },
    { key: 'type', header: t('audit.eventType'), cell: (row) => <code className="font-mono text-sm break-all">{row.type}</code>, mobile: 'title' },
    { key: 'severity', header: t('audit.severity'), cell: (row) => <Badge variant={SEVERITY_VARIANT[row.severity]}>{t(`enums:severity.${row.severity}`)}</Badge> },
    { key: 'source', header: t('audit.source'), cell: (row) => t(`enums:eventSource.${row.source}`), mobile: 'hidden' },
    { key: 'userName', header: t('audit.user'), cell: (row) => row.userName ?? '—' },
  ];

  return (
    <>
      <DataTable<JournalEntry>
        path="/settings/journal"
        params={{ source: source || undefined, severity: severity || undefined, from: from || undefined, to: to || undefined }}
        columns={columns}
        searchable={false}
        urlPrefix="j"
        onRowClick={setOpen}
        filters={
          <>
            <Select aria-label={t('audit.source')} value={source} onChange={(e) => setSource(e.target.value)} options={enumOptions('eventSource', EVENT_SOURCES)} placeholder={t('audit.allSources')} className="md:w-44" />
            <Select aria-label={t('audit.severity')} value={severity} onChange={(e) => setSeverity(e.target.value)} options={enumOptions('severity', SEVERITIES)} placeholder={t('audit.allSeverities')} className="md:w-44" />
            <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
          </>
        }
        empty={{ icon: BookOpenText, title: t('audit.journalEmptyTitle') }}
      />
      <JournalDetail entry={open} onClose={() => setOpen(null)} />
    </>
  );
}

export default function AuditPage() {
  const { t } = useTranslation('settings');
  return (
    <>
      <PageHeader title={t('audit.title')} description={t('audit.description')} />
      <UrlTabs
        tabs={[
          { value: 'changes', label: t('audit.tabChanges'), content: <ChangesTab /> },
          { value: 'journal', label: t('audit.tabJournal'), content: <JournalTab /> },
        ]}
      />
    </>
  );
}
