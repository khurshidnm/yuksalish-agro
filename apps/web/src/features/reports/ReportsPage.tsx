import { FINANCE_SUMMARY_VIEW, todayIso } from '@yap/shared';
import { CalendarClock, FileSpreadsheet, FileText, Pencil, Search, Send, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { type Column, DataTableView, EmptyState, ErrorCard, PageHeader, StatCard, UrlTabs, useConfirm, useUrlParam } from '@/components';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan, useSession } from '@/lib/auth';
import { formatDate, formatDateTime, formatMoney, formatMonth, formatNumber, formatPercent } from '@/lib/format';
import { useApiMutation, useDetail } from '@/lib/query';
import { recentMonths, savedToSearch } from './format';
import { MonthSelect } from './ReportFilters';
import { SaveReportDialog } from './SaveReportDialog';
import type { Catalog, CatalogReport, InvestorData, InvestorSnapshot, SavedReport } from './types';

const SAVED = '/reports/saved';
const MODULE_ORDER = ['finance', 'livestock', 'feed', 'inventory', 'crops', 'hr', 'assets', 'sales'];

function ReportCard({ report }: { report: CatalogReport }) {
  const { t } = useTranslation('reports');
  return (
    <li>
      <Link
        to={`/reports/${report.key}`}
        className="focus-ring block h-full min-h-11 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted"
      >
        <span className="flex items-start justify-between gap-2">
          <span className="min-w-0 font-medium">{report.title}</span>
          {report.money && (
            <Badge variant="neutral" className="shrink-0">
              {t('catalogPage.moneyBadge')}
            </Badge>
          )}
        </span>
        <span className="mt-1 block text-sm text-muted-foreground">{report.description}</span>
      </Link>
    </li>
  );
}

function CatalogTab({ catalog }: { catalog: Catalog }) {
  const { t } = useTranslation('reports');
  const [search, setSearch] = useUrlParam('q');
  const term = search.trim().toLowerCase();

  const groups = useMemo(() => {
    const found = term
      ? catalog.reports.filter((r) => `${r.title} ${r.description}`.toLowerCase().includes(term))
      : catalog.reports;
    return MODULE_ORDER.map((module) => ({ module, reports: found.filter((r) => r.module === module) })).filter(
      (group) => group.reports.length > 0,
    );
  }, [catalog.reports, term]);

  if (catalog.reports.length === 0) return <EmptyState icon={FileText} title={t('catalogPage.noAccess')} />;

  return (
    <div className="space-y-6">
      <div className="relative">
        <Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('catalogPage.search')}
          aria-label={t('catalogPage.search')}
          className="pl-9"
        />
      </div>
      {groups.length === 0 ? (
        <EmptyState icon={Search} title={t('catalogPage.empty')} description={t('catalogPage.emptyHint')} />
      ) : (
        groups.map(({ module, reports }) => (
          <section key={module} className="space-y-2">
            <h2 className="text-base font-semibold">
              {t(`modules.${module}`)} <span className="font-normal text-muted-foreground">· {reports.length}</span>
            </h2>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {reports.map((report) => (
                <ReportCard key={report.key} report={report} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function SavedTab({ catalog }: { catalog: Catalog }) {
  const { t } = useTranslation('reports');
  const navigate = useNavigate();
  const confirm = useConfirm();
  const session = useSession();
  const can = useCan();
  const list = useDetail<SavedReport[]>(SAVED);
  const [editing, setEditing] = useState<SavedReport | null>(null);

  const remove = useApiMutation({
    mutationFn: (id: string) => api.delete(`${SAVED}/${id}`),
    invalidate: [SAVED],
    successMessage: t('saved.deleted'),
  });
  const send = useApiMutation({
    mutationFn: (id: string) => api.post<{ recipients: number }>(`${SAVED}/${id}/send`),
    invalidate: [SAVED],
  });

  const titleOf = (key: string) => catalog.reports.find((r) => r.key === key)?.title ?? key;
  const open = (row: SavedReport) => navigate(`/reports/${row.reportKey}?${savedToSearch(row.config).toString()}`);

  const columns: Column<SavedReport>[] = [
    { key: 'name', header: t('saved.name'), cell: (row) => row.name, mobile: 'title' },
    { key: 'report', header: t('saved.report'), cell: (row) => titleOf(row.reportKey), mobile: 'subtitle' },
    {
      key: 'schedule',
      header: t('saved.schedule'),
      cell: (row) =>
        row.schedule ? (
          <Badge variant="info">
            <CalendarClock aria-hidden className="size-3.5" />
            {t(`schedule.${row.schedule}`)}
          </Badge>
        ) : (
          t('schedule.none')
        ),
    },
    { key: 'lastSent', header: t('saved.lastSent'), cell: (row) => formatDateTime(row.lastSentAt) },
  ];

  if (list.isError) return <ErrorCard error={list.error} onRetry={() => void list.refetch()} />;

  return (
    <>
      <DataTableView
        rows={list.data ?? []}
        columns={columns}
        loading={list.isLoading}
        onRowClick={open}
        empty={{ icon: FileSpreadsheet, title: t('saved.empty'), description: t('saved.emptyHint') }}
        rowActions={(row) => {
          const mine = row.createdBy === session.user.id || can('reports.update');
          return [
            { label: t('saved.open'), icon: FileText, onClick: () => open(row) },
            { label: t('saved.edit'), icon: Pencil, onClick: () => setEditing(row), hidden: !mine },
            {
              label: t('saved.send'),
              icon: Send,
              hidden: !mine,
              onClick: () =>
                void send.mutateAsync(row.id).then((result) => {
                  toast.success(t('saved.sent', { count: result.recipients }));
                }),
            },
            {
              label: t('saved.delete'),
              icon: Trash2,
              destructive: true,
              hidden: !mine,
              onClick: () =>
                void confirm({ title: t('saved.deleteConfirm'), destructive: true, confirmLabel: t('saved.delete') }).then(
                  (yes) => yes && remove.mutate(row.id),
                ),
            },
          ];
        }}
      />
      {editing && <SaveReportDialog open saved={editing} onOpenChange={(next) => !next && setEditing(null)} />}
    </>
  );
}

function FigureList({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 py-2">
              <dt className="min-w-0 text-sm text-muted-foreground">{label}</dt>
              <dd className="shrink-0 font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function InvestorTab() {
  const { t, i18n } = useTranslation('reports');
  const fallback = recentMonths(todayIso().slice(0, 7), 2)[1];
  const [month, setMonth] = useUrlParam('month', fallback);
  const data = useDetail<InvestorData>('/reports/investor', { month });
  const archive = useDetail<InvestorSnapshot[]>('/reports/investor/archive');
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    setDownloading(true);
    try {
      await api.download('/reports/investor/pdf', undefined, { month, lang: i18n.language });
    } finally {
      setDownloading(false);
    }
  };

  const label = (key: string) => t(`investor.${key}`);
  const money = (value: number | null) => formatMoney(value, { plain: true });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-48 space-y-1.5">
          <Label htmlFor="investor-month">{t('investorPage.month')}</Label>
          <MonthSelect id="investor-month" value={month} onChange={setMonth} />
        </div>
        <Button onClick={() => void download()} loading={downloading}>
          <FileText aria-hidden className="size-4" />
          {t('investorPage.downloadPdf')}
        </Button>
      </div>

      {data.isError ? (
        <ErrorCard error={data.error} onRetry={() => void data.refetch()} />
      ) : !data.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={label('income')} value={money(data.data.finance.income)} />
            <StatCard label={label('expense')} value={money(data.data.finance.expense)} />
            <StatCard label={label('cash')} value={money(data.data.finance.cash)} />
            <StatCard label={label('head')} value={formatNumber(data.data.livestock.head, 0)} />
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <FigureList
              title={label('finance')}
              rows={[
                [label('net'), money(data.data.finance.net)],
                [label('profitability'), formatPercent(data.data.finance.profitabilityPercent)],
                [label('budget'), formatPercent(data.data.finance.budgetPercent)],
                [label('receivable'), money(data.data.finance.receivable)],
                [label('payable'), money(data.data.finance.payable)],
                [label('loans'), money(data.data.finance.loans)],
                [label('costPerHead'), money(data.data.finance.costPerHead)],
              ]}
            />
            <FigureList
              title={label('livestock')}
              rows={[
                [label('pregnant'), formatNumber(data.data.livestock.pregnant, 0)],
                [label('born'), formatNumber(data.data.livestock.born, 0)],
                [label('sold'), formatNumber(data.data.livestock.sold, 0)],
                [label('dead'), formatNumber(data.data.livestock.dead, 0)],
                [label('mortality'), formatPercent(data.data.livestock.mortalityPercent)],
                [label('lambingExpected'), formatNumber(data.data.livestock.lambingExpected, 0)],
                [label('avgWeight'), formatNumber(data.data.livestock.avgWeightKg, 1)],
              ]}
            />
            <FigureList
              title={label('forecast')}
              rows={data.data.finance.forecast.map((row): [string, string] => [formatMonth(row.month), money(row.closing)])}
            />
            <FigureList
              title={label('crops')}
              rows={[
                [label('sown'), `${data.data.crops.sown} / ${data.data.crops.total}`],
                [label('harvestPlanned'), formatNumber(data.data.crops.harvestPlannedT, 1)],
                [label('harvestActual'), formatNumber(data.data.crops.harvestActualT, 1)],
              ]}
            />
            <FigureList
              title={label('feed')}
              rows={
                data.data.feed.length
                  ? data.data.feed.map((row): [string, string] => [row.name, formatNumber(row.days, 1)])
                  : [[label('noData'), '—']]
              }
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {t('investor.asOf', { date: formatDate(data.data.asOf) })} · {label('disclaimer')}
          </p>
        </>
      )}

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t('investorPage.archive')}</h2>
        {archive.data?.length ? (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {archive.data.map((row) => (
              <li key={row.month}>
                <a
                  href={row.url}
                  target="_blank"
                  rel="noreferrer"
                  className="focus-ring flex min-h-11 items-center justify-between gap-3 px-4 py-2 hover:bg-muted"
                >
                  <span>{formatMonth(row.month)}</span>
                  <span className="text-sm text-muted-foreground">{t('investorPage.open')}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('investorPage.archiveEmpty')}</p>
        )}
      </section>
    </div>
  );
}

export default function ReportsPage() {
  const { t, i18n } = useTranslation('reports');
  const can = useCan();
  const catalog = useDetail<Catalog>('/reports', { lang: i18n.language });
  const seesInvestor = can('finance.view') || can(FINANCE_SUMMARY_VIEW);

  return (
    <div className="space-y-4">
      <PageHeader title={t('page.title')} description={t('page.description')} />
      {catalog.isError ? (
        <ErrorCard error={catalog.error} onRetry={() => void catalog.refetch()} />
      ) : !catalog.data ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : (
        <UrlTabs
          tabs={[
            { value: 'catalog', label: t('tabs.catalog'), content: <CatalogTab catalog={catalog.data} /> },
            { value: 'saved', label: t('tabs.saved'), content: <SavedTab catalog={catalog.data} /> },
            { value: 'investor', label: t('tabs.investor'), content: <InvestorTab />, hidden: !seesInvestor },
          ]}
        />
      )}
    </div>
  );
}
