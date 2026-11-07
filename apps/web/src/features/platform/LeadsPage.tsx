import { LEAD_STATUSES } from '@yap/shared';
import { CircleCheck, Handshake, Inbox, type LucideIcon, MessageCircle, PhoneCall, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, DataTable, FormDialog, PageHeader, SelectField, StatCard, TextareaField, useConfirm, useUrlParam } from '@/components';
import { Badge, type BadgeVariant, Button, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import { zOptionalText } from '@/lib/forms';
import { LANGUAGES, enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';

const LEADS = '/leads';
const STATS = '/leads/stats';

type LeadStatus = (typeof LEAD_STATUSES)[number];

interface LeadRepeat {
  at: string;
  fullName: string;
  farmName?: string;
  region?: string;
  farmType?: string;
  farmSize?: string;
  message?: string;
}

interface Lead {
  id: string;
  fullName: string;
  phone: string;
  farmName: string | null;
  region: string | null;
  farmType: string | null;
  farmSize: string | null;
  message: string | null;
  language: string;
  source: string | null;
  status: LeadStatus;
  notes: string | null;
  submissions: number;
  repeats: LeadRepeat[];
  contactedAt: string | null;
  createdAt: string;
}

type Stats = Record<LeadStatus | 'total', number>;

const STATUS_TONE: Record<LeadStatus, BadgeVariant> = {
  new: 'warning',
  contacted: 'info',
  qualified: 'info',
  won: 'success',
  lost: 'neutral',
};

const TILES: { status: LeadStatus; icon: LucideIcon }[] = [
  { status: 'new', icon: Sparkles },
  { status: 'contacted', icon: PhoneCall },
  { status: 'qualified', icon: Handshake },
  { status: 'won', icon: CircleCheck },
];

const schema = z.object({ status: z.enum(LEAD_STATUSES), notes: zOptionalText(4000) });

function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-dashed border-border py-1.5 last:border-0">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-medium break-words">{value}</dd>
    </div>
  );
}

export default function LeadsPage() {
  const { t } = useTranslation('platform');
  const confirm = useConfirm();
  const stats = useDetail<Stats>(STATS);
  const [status, setStatus] = useUrlParam('status');
  const [open, setOpen] = useState<Lead | null>(null);

  const update = useApiMutation<z.output<typeof schema>>({
    mutationFn: (values) => api.patch(`${LEADS}/${open!.id}`, values),
    invalidate: [LEADS, STATS],
    silentError: true,
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${LEADS}/${id}`),
    invalidate: [LEADS, STATS],
    successMessage: 'platform:leads.deleted',
  });

  const askToRemove = async (lead: Lead) => {
    const ok = await confirm({
      title: t('leads.deleteTitle'),
      description: t('leads.deleteBody', { name: lead.fullName }),
      confirmLabel: t('leads.delete'),
      destructive: true,
    });
    if (ok) {
      remove.mutate(lead.id);
      setOpen(null);
    }
  };

  const columns: Column<Lead>[] = [
    {
      key: 'fullName',
      header: t('leads.name'),
      cell: (row) => (
        <span>
          <span className="block font-medium">{row.fullName}</span>
          {row.farmName && <span className="block text-sm text-muted-foreground">{row.farmName}</span>}
        </span>
      ),
      mobile: 'title',
    },
    {
      key: 'phone',
      header: t('leads.phone'),
      cell: (row) => (
        <a href={`tel:${row.phone}`} className="focus-ring inline-flex min-h-11 items-center rounded font-medium whitespace-nowrap underline-offset-2 hover:underline md:min-h-0">
          {row.phone}
        </a>
      ),
      mobile: 'subtitle',
    },
    { key: 'region', header: t('leads.region'), cell: (row) => row.region ?? '—', mobile: 'hidden' },
    { key: 'farmSize', header: t('leads.size'), cell: (row) => row.farmSize ?? '—' },
    {
      key: 'farmType',
      header: t('leads.farmType'),
      cell: (row) => (row.farmType ? t(`enums:leadFarmType.${row.farmType}`) : '—'),
      mobile: 'hidden',
    },
    {
      key: 'status',
      header: t('leads.status'),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <Badge variant={STATUS_TONE[row.status]}>{t(`enums:leadStatus.${row.status}`)}</Badge>
          {row.submissions > 1 && <Badge variant="outline">{t('leads.repeat', { count: row.submissions })}</Badge>}
        </span>
      ),
    },
    { key: 'createdAt', header: t('leads.received'), cell: (row) => formatDateTime(row.createdAt) },
  ];

  return (
    <>
      <PageHeader title={t('leads.title')} description={t('leads.description')} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {TILES.map(({ status: tile, icon }, index) => (
          <StatCard
            key={tile}
            label={t(`enums:leadStatus.${tile}`)}
            value={formatNumber(stats.data?.[tile])}
            loading={stats.isLoading}
            icon={icon}
            featured={index === 0}
          />
        ))}
      </div>

      <DataTable<Lead>
        path={LEADS}
        params={{ status: status || undefined }}
        columns={columns}
        onRowClick={setOpen}
        searchPlaceholder={t('leads.searchPlaceholder')}
        filters={
          <Select
            aria-label={t('leads.status')}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={enumOptions('leadStatus', LEAD_STATUSES)}
            placeholder={t('leads.allStatuses')}
            className="md:w-56"
          />
        }
        empty={{ icon: Inbox, title: t('leads.emptyTitle'), description: t('leads.emptyBody') }}
        rowActions={(row) => [
          { label: t('leads.open'), icon: MessageCircle, onClick: () => setOpen(row) },
          { label: t('leads.delete'), icon: Trash2, destructive: true, onClick: () => void askToRemove(row) },
        ]}
      />

      <FormDialog
        open={open !== null}
        onOpenChange={(next) => !next && setOpen(null)}
        title={open?.fullName}
        description={open ? t('leads.receivedAt', { date: formatDateTime(open.createdAt) }) : undefined}
        schema={schema}
        defaultValues={{ status: open?.status ?? 'new', notes: open?.notes ?? '' }}
        successMessage="common:toast.updated"
        onSubmit={(values) => update.mutateAsync(values)}
      >
        {(form) =>
          open && (
            <>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="accent" size="sm">
                  <a href={`tel:${open.phone}`}>
                    <PhoneCall aria-hidden />
                    {open.phone}
                  </a>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <a href={`https://t.me/${open.phone}`} target="_blank" rel="noreferrer">
                    <MessageCircle aria-hidden />
                    {t('leads.telegram')}
                  </a>
                </Button>
              </div>

              <dl>
                <Fact label={t('leads.farmName')} value={open.farmName} />
                <Fact label={t('leads.region')} value={open.region} />
                <Fact label={t('leads.farmType')} value={open.farmType ? t(`enums:leadFarmType.${open.farmType}`) : null} />
                <Fact label={t('leads.size')} value={open.farmSize} />
                <Fact label={t('leads.language')} value={LANGUAGES.find((l) => l.code === open.language)?.label ?? open.language} />
                <Fact label={t('leads.contactedAt')} value={open.contactedAt ? formatDateTime(open.contactedAt) : null} />
              </dl>

              {open.message && (
                <div className="rounded-lg bg-muted p-3 text-sm whitespace-pre-wrap">
                  <p className="mb-1 font-medium text-muted-foreground">{t('leads.message')}</p>
                  {open.message}
                </div>
              )}

              {open.repeats.length > 0 && (
                <div className="rounded-lg border border-border p-3 text-sm">
                  <p className="font-medium text-muted-foreground">{t('leads.repeats')}</p>
                  <p className="mb-2 text-xs text-muted-foreground">{t('leads.repeatsHint')}</p>
                  <ul className="flex flex-col gap-2">
                    {open.repeats.map((repeat, index) => (
                      <li key={`${repeat.at}-${index}`} className="border-t border-dashed border-border pt-2">
                        <p className="font-medium break-words">
                          {[repeat.fullName, repeat.farmName, repeat.region, repeat.farmType && t(`enums:leadFarmType.${repeat.farmType}`), repeat.farmSize].filter(Boolean).join(' · ')}
                        </p>
                        <p className="text-xs text-muted-foreground">{formatDateTime(repeat.at)}</p>
                        {repeat.message && <p className="mt-1 break-words whitespace-pre-wrap">{repeat.message}</p>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <SelectField form={form} name="status" label={t('leads.status')} options={enumOptions('leadStatus', LEAD_STATUSES)} />
              <TextareaField form={form} name="notes" label={t('leads.notes')} hint={t('leads.notesHint')} rows={3} />
            </>
          )
        }
      </FormDialog>
    </>
  );
}
