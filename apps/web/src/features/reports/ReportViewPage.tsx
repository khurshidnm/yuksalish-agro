import { keepPreviousData } from '@tanstack/react-query';
import { Download, FileSpreadsheet, FileText, FileType2, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { type Column, DataTableView, EmptyState, ErrorCard, PageHeader } from '@/components';
import { ChartCard } from '@/components/ChartCard';
import {
  Alert,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Pagination,
  Skeleton,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatCompact, formatDate, formatMoney, formatMonth, formatMonthShort, formatNumber } from '@/lib/format';
import { errorMessage, useDetail } from '@/lib/query';
import { CustomizeDialog, type CustomizeResult } from './CustomizeDialog';
import { NON_FILTER_PARAMS, formatCell, isNumeric, savedToSearch, sortRows } from './format';
import { ReportFilters, type SetParams } from './ReportFilters';
import { SaveReportDialog } from './SaveReportDialog';
import type { Catalog, ReportResult, ReportRow, ResultColumn, SavedConfig, SavedReport } from './types';

const PAGE_SIZE = 50;
/** Long category names stop being readable past this many bars, especially on a phone. */
const MAX_CATEGORY_BARS = 12;
const MAX_AXIS_LABEL = 14;

type Row = ReportRow & { __index: number; __total?: boolean };

function shorten(text: string): string {
  return text.length > MAX_AXIS_LABEL ? `${text.slice(0, MAX_AXIS_LABEL - 1)}…` : text;
}

/** A leading type column says little on a phone card, so its neighbour, the name, heads the card. */
function phoneTitle(columns: ResultColumn[]): ResultColumn {
  const named = columns[1];
  return columns[0].type === 'enum' && named && (named.type === 'text' || named.type === 'name') ? named : columns[0];
}

function ReportChart({ result }: { result: ReportResult }) {
  const { t } = useTranslation('reports');
  const chart = result.chart;
  const data = useMemo(() => {
    if (!chart) return [];
    const x = result.columns.find((c) => c.key === chart.x);
    const timeline = x?.type === 'date' || x?.type === 'month';
    return timeline ? result.rows : result.rows.slice(0, MAX_CATEGORY_BARS);
  }, [chart, result]);

  if (!chart || result.rows.length < 2) return null;
  const x = result.columns.find((c) => c.key === chart.x)!;
  const first = result.columns.find((c) => c.key === chart.series[0].key)!;
  const formatValue = (value: number) =>
    first.type === 'money' ? formatMoney(value, { plain: true }) : formatNumber(value, first.digits ?? 2);
  const axis = (value: string) => {
    if (x.type === 'month') return formatMonthShort(value, true);
    if (x.type === 'date') return formatDate(value);
    return shorten(value);
  };
  const label = (value: string) => {
    if (x.type === 'month') return formatMonth(value);
    if (x.type === 'date') return formatDate(value);
    return value;
  };

  return (
    <ChartCard
      title={t('viewer.chart')}
      kind={chart.kind}
      data={data}
      xKey={chart.x}
      series={chart.series}
      formatValue={formatValue}
      formatAxis={(value) => formatCompact(value)}
      formatX={axis}
      formatLabel={label}
    />
  );
}

function ReportTable({ result }: { result: ReportResult }) {
  const { t } = useTranslation('reports');
  const [sort, setSort] = useState<string>();
  const [page, setPage] = useState(1);
  const yes = t('common.yes');
  const no = t('common.no');

  // A new result means new filters: the old page number means nothing.
  useEffect(() => setPage(1), [result]);

  const titleColumn = phoneTitle(result.columns);
  const firstLabel = isNumeric(titleColumn) ? result.columns.find((c) => !isNumeric(c)) : titleColumn;

  const columns = useMemo(() => {
    const cell = (column: ResultColumn, row: Row) => {
      if (row.__total) {
        const text = column === firstLabel && row[column.key] === undefined ? t('viewer.totalRow') : formatTotal(column, row);
        return <span className="font-semibold">{text}</span>;
      }
      return formatCell(column, row[column.key], yes, no);
    };
    const formatTotal = (column: ResultColumn, row: Row) =>
      column.key in row ? formatCell(column, row[column.key], yes, no) : '';
    return result.columns.map((column): Column<Row> => ({
      key: column.key,
      header: column.label,
      sortable: true,
      align: isNumeric(column) ? 'right' : 'left',
      mobile: column === titleColumn ? 'title' : undefined,
      cell: (row) => cell(column, row),
    }));
  }, [result.columns, titleColumn, firstLabel, t, yes, no]);

  const ordered = useMemo(
    () => sortRows(result.rows, sort).map((row, index): Row => ({ ...row, __index: index })),
    [result.rows, sort],
  );
  const pageCount = Math.ceil(ordered.length / PAGE_SIZE);
  const shown = ordered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const onLastPage = page >= pageCount;
  const rows = result.totals && onLastPage ? [...shown, { ...result.totals, __index: -1, __total: true }] : shown;

  return (
    <DataTableView
      rows={rows}
      columns={columns}
      rowKey={(row) => String(row.__index)}
      sort={sort}
      onSortChange={setSort}
      footer={
        ordered.length > PAGE_SIZE ? (
          <Pagination page={page} pageSize={PAGE_SIZE} total={ordered.length} onPageChange={setPage} />
        ) : undefined
      }
    />
  );
}

export default function ReportViewPage() {
  const { key = '' } = useParams();
  const { t, i18n } = useTranslation('reports');
  const lang = i18n.language;
  const [search, setSearch] = useSearchParams();
  const [customizing, setCustomizing] = useState(false);
  const [saving, setSaving] = useState<CustomizeResult | null>(null);
  const [exporting, setExporting] = useState(false);

  const catalog = useDetail<Catalog>('/reports', { lang });
  const report = catalog.data?.reports.find((r) => r.key === key);

  // A link from a delivered message names the saved report. Unfold it into ordinary parameters.
  const savedId = search.get('saved');
  const saved = useDetail<SavedReport[]>(savedId ? '/reports/saved' : null);
  useEffect(() => {
    if (!savedId || (!saved.data && !saved.isError)) return;
    const match = saved.data?.find((row) => row.id === savedId);
    // A deleted report must not leave the page waiting: fall back to the plain report.
    setSearch(match ? savedToSearch(match.config) : new URLSearchParams(), { replace: true });
  }, [saved.data, saved.isError, savedId, setSearch]);

  const params = useMemo(() => {
    const entries = Object.fromEntries([...search].filter(([name]) => name !== 'saved' && name !== 'compareOn'));
    return { ...entries, lang };
  }, [search, lang]);

  const run = useDetail<ReportResult>(report && !savedId ? `/reports/${key}` : null, params, {
    placeholderData: keepPreviousData,
  });
  const result = run.data?.key === key ? run.data : undefined;

  const setParams: SetParams = (changes) => {
    setSearch(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [name, value] of Object.entries(changes)) {
          if (value === null) next.delete(name);
          else next.set(name, value);
        }
        return next;
      },
      { replace: true },
    );
  };

  const applyCustom = ({ columns, groupBy }: CustomizeResult) => {
    setParams({
      columns: columns?.join(',') ?? null,
      groupBy,
      ...(groupBy ? { compareFrom: null, compareTo: null, compareSeasonId: null, compareOn: null } : {}),
    });
  };

  const download = async (format: 'xlsx' | 'pdf' | 'csv') => {
    setExporting(true);
    try {
      await api.download(`/reports/${key}/export`, undefined, { ...params, format });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  const draftConfig = (choice: CustomizeResult): SavedConfig => ({
    columns: choice.columns ?? undefined,
    groupBy: choice.groupBy,
    filters: Object.fromEntries([...search].filter(([name]) => !NON_FILTER_PARAMS.includes(name) && name !== 'compareOn')),
  });

  const back = { to: '/reports', label: t('viewer.back') };

  if (catalog.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (catalog.isError) return <ErrorCard error={catalog.error} onRetry={() => void catalog.refetch()} />;
  if (!report) {
    return (
      <>
        <PageHeader title={t('page.title')} back={back} />
        <EmptyState title={t('viewer.notFound')} />
      </>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={report.title}
        description={report.description}
        back={back}
        actions={
          <>
            <Button variant="outline" onClick={() => setCustomizing(true)}>
              <SlidersHorizontal aria-hidden className="size-4" />
              {t('viewer.customize')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button loading={exporting}>
                  <Download aria-hidden className="size-4" />
                  {t('viewer.download')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => void download('xlsx')}>
                  <FileSpreadsheet aria-hidden className="size-4" />
                  {t('viewer.downloadXlsx')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void download('pdf')}>
                  <FileText aria-hidden className="size-4" />
                  {t('viewer.downloadPdf')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void download('csv')}>
                  <FileType2 aria-hidden className="size-4" />
                  {t('viewer.downloadCsv')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <ReportFilters report={report} catalog={catalog.data!} params={search} result={result} setParams={setParams} />

      {result && result.hidden.money > 0 && <Alert tone="info">{t('viewer.hiddenMoney')}</Alert>}
      {result && result.hidden.pii > 0 && <Alert tone="info">{t('viewer.hiddenPii')}</Alert>}
      {result?.notes.map((note) => (
        <Alert key={note} tone="info">
          {note}
        </Alert>
      ))}

      {run.isError ? (
        <ErrorCard error={run.error} onRetry={() => void run.refetch()} />
      ) : !result ? (
        <Skeleton className="h-64 w-full" />
      ) : result.rows.length === 0 ? (
        <EmptyState title={t('viewer.empty')} description={t('viewer.emptyHint')} />
      ) : (
        <>
          <ReportChart result={result} />
          {result.truncated && (
            <Alert tone="warning">{t('viewer.truncated', { shown: result.rows.length, total: result.rowCount })}</Alert>
          )}
          <ReportTable result={result} />
          <p className="text-sm text-muted-foreground">
            {t('viewer.rowCount', { count: result.rowCount })} · {t('viewer.took', { ms: result.durationMs })}
          </p>
        </>
      )}

      <CustomizeDialog
        open={customizing}
        onOpenChange={setCustomizing}
        report={report}
        columns={search.get('columns')?.split(',').filter(Boolean) ?? null}
        groupBy={search.get('groupBy')}
        onApply={applyCustom}
        onSave={(choice) => {
          applyCustom(choice);
          setCustomizing(false);
          setSaving(choice);
        }}
      />
      {saving && (
        <SaveReportDialog
          open
          onOpenChange={(open) => !open && setSaving(null)}
          draft={{ reportKey: key, name: report.title, config: draftConfig(saving) }}
        />
      )}
    </div>
  );
}
