import { ArrowDown, ArrowUp, ChevronsUpDown, type LucideIcon, MoreVertical, Search, X } from 'lucide-react';
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { QueryParams } from '@/lib/api';
import { useList } from '@/lib/query';
import { cn } from '@/lib/utils';
import { EmptyState, type EmptyStateProps } from './EmptyState';
import { ErrorCard } from './ErrorCard';
import {
  Button,
  Card,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Pagination,
  Skeleton,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
} from './ui';

export interface Column<T> {
  /** Unique id, and the server sort field unless `sortable` names another one. */
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** true sorts by `key`; a string sorts by that field. */
  sortable?: boolean | string;
  align?: 'left' | 'right' | 'center';
  className?: string;
  /** On phones each row is a card: `title` heads it, `subtitle` sits under it, `hidden` is left out. */
  mobile?: 'title' | 'subtitle' | 'hidden';
}

export interface RowAction {
  label: ReactNode;
  icon?: LucideIcon;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  hidden?: boolean;
}

export interface DataTableViewProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey?: (row: T) => string;
  rowActions?: (row: T) => RowAction[];
  /** Navigate when the row is clicked; the title cell becomes a real link. */
  rowHref?: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  sort?: string;
  onSortChange?: (sort: string | undefined) => void;
  empty?: EmptyStateProps;
  footer?: ReactNode;
  className?: string;
}

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' };

function defaultRowKey(row: unknown): string {
  return String((row as { id?: string }).id);
}

const INTERACTIVE = 'a, button, input, select, textarea, label, [role="menuitem"]';

function SortHeader<T>({ column, sort, onSortChange }: { column: Column<T>; sort?: string; onSortChange?: (s: string | undefined) => void }) {
  const field = typeof column.sortable === 'string' ? column.sortable : column.key;
  const active = sort === field ? 'asc' : sort === `-${field}` ? 'desc' : null;
  const Icon = active === 'asc' ? ArrowUp : active === 'desc' ? ArrowDown : ChevronsUpDown;
  return (
    <button
      type="button"
      onClick={() => onSortChange?.(active === null ? field : active === 'asc' ? `-${field}` : undefined)}
      className={cn('focus-ring inline-flex items-center gap-1 rounded hover:text-foreground', column.align === 'right' && 'flex-row-reverse')}
    >
      {column.header}
      <Icon className={cn('size-3.5', !active && 'opacity-50')} aria-hidden />
    </button>
  );
}

function ActionsMenu({ actions }: { actions: RowAction[] }) {
  const { t } = useTranslation();
  const visible = actions.filter((a) => !a.hidden);
  if (visible.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t('common:table.actions')}>
          <MoreVertical aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {visible.map((action, i) => (
          <DropdownMenuItem key={i} destructive={action.destructive} disabled={action.disabled} onSelect={action.onClick}>
            {action.icon && <action.icon aria-hidden />}
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The table without data fetching, for rows you already hold: reports, nested lists.
 * Above `md` it is a table; below it, each row is a card, so phones never scroll sideways.
 */
export function DataTableView<T>({
  rows,
  columns,
  rowKey = defaultRowKey,
  rowActions,
  rowHref,
  onRowClick,
  loading,
  error,
  onRetry,
  sort,
  onSortChange,
  empty,
  footer,
  className,
}: DataTableViewProps<T>) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const showEmpty = !loading && !error && rows.length === 0;
  const hasRows = !loading && !error && rows.length > 0;
  const clickable = Boolean(rowHref || onRowClick);

  const activate = (row: T, event: MouseEvent) => {
    if ((event.target as HTMLElement).closest(INTERACTIVE)) return;
    if (rowHref) navigate(rowHref(row));
    else onRowClick?.(row);
  };

  const titleColumn = columns.find((c) => c.mobile === 'title') ?? columns[0];
  const subtitleColumn = columns.find((c) => c.mobile === 'subtitle');
  const detailColumns = columns.filter((c) => c !== titleColumn && c !== subtitleColumn && c.mobile !== 'hidden');

  const linked = (row: T, column: Column<T>) => {
    const content = column.cell(row);
    if (column !== titleColumn || !rowHref) return content;
    return (
      <Link to={rowHref(row)} className="focus-ring rounded font-medium hover:underline">
        {content}
      </Link>
    );
  };

  if (error) return <ErrorCard error={error} onRetry={onRetry} className={className} />;

  return (
    <div className={className}>
      {showEmpty ? (
        <Card>
          <EmptyState title={empty?.title ?? t('common:table.empty')} description={empty?.description ?? t('common:table.emptyHint')} icon={empty?.icon} action={empty?.action} />
        </Card>
      ) : (
        <>
          {/* Wide screens */}
          <Card className="hidden overflow-hidden md:block">
            <Table>
              <THead>
                <Tr>
                  {columns.map((column) => {
                    const field = typeof column.sortable === 'string' ? column.sortable : column.key;
                    const ariaSort = sort === field ? 'ascending' : sort === `-${field}` ? 'descending' : undefined;
                    return (
                      <Th key={column.key} aria-sort={ariaSort} className={cn(ALIGN[column.align ?? 'left'], column.className)}>
                        {column.sortable ? <SortHeader column={column} sort={sort} onSortChange={onSortChange} /> : column.header}
                      </Th>
                    );
                  })}
                  {rowActions && (
                    <Th className="w-12">
                      <span className="sr-only">{t('common:table.actions')}</span>
                    </Th>
                  )}
                </Tr>
              </THead>
              <TBody>
                {loading &&
                  Array.from({ length: 6 }, (_, i) => (
                    <Tr key={i}>
                      {columns.map((column) => (
                        <Td key={column.key}>
                          <Skeleton className="h-5 w-full max-w-40" />
                        </Td>
                      ))}
                      {rowActions && <Td />}
                    </Tr>
                  ))}
                {hasRows &&
                  rows.map((row) => (
                    <Tr
                      key={rowKey(row)}
                      onClick={clickable ? (event) => activate(row, event) : undefined}
                      className={cn(clickable && 'cursor-pointer hover:bg-muted/60')}
                    >
                      {columns.map((column) => (
                        <Td key={column.key} className={cn(ALIGN[column.align ?? 'left'], column.className)}>
                          {linked(row, column)}
                        </Td>
                      ))}
                      {rowActions && (
                        <Td className="py-1 text-right">
                          <ActionsMenu actions={rowActions(row)} />
                        </Td>
                      )}
                    </Tr>
                  ))}
              </TBody>
            </Table>
          </Card>

          {/* Phones */}
          <ul className="flex flex-col gap-2 md:hidden">
            {loading &&
              Array.from({ length: 4 }, (_, i) => (
                <li key={i}>
                  <Card className="p-4">
                    <Skeleton className="h-5 w-1/2" />
                    <Skeleton className="mt-3 h-4 w-full" />
                    <Skeleton className="mt-2 h-4 w-2/3" />
                  </Card>
                </li>
              ))}
            {hasRows &&
              rows.map((row) => (
                <li key={rowKey(row)}>
                  <Card onClick={clickable ? (event) => activate(row, event) : undefined} className={cn('p-3.5', clickable && 'cursor-pointer active:bg-muted/60')}>
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold break-words">{linked(row, titleColumn)}</div>
                        {subtitleColumn && <div className="text-sm break-words text-muted-foreground">{subtitleColumn.cell(row)}</div>}
                      </div>
                      {rowActions && (
                        <div className="-mt-1.5 -mr-1.5">
                          <ActionsMenu actions={rowActions(row)} />
                        </div>
                      )}
                    </div>
                    {detailColumns.length > 0 && (
                      <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                        {detailColumns.map((column) => (
                          <div key={column.key} className="col-span-2 grid grid-cols-subgrid">
                            <dt className="text-muted-foreground">{column.header}</dt>
                            <dd className="min-w-0 text-right break-words">{column.cell(row)}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </Card>
                </li>
              ))}
          </ul>
        </>
      )}
      {footer}
    </div>
  );
}

export interface DataTableProps<T> extends Pick<DataTableViewProps<T>, 'columns' | 'rowKey' | 'rowActions' | 'rowHref' | 'onRowClick' | 'empty' | 'className'> {
  /** List endpoint, e.g. '/finance/counterparties'. */
  path: string;
  /** Extra query parameters: the page's filters. Changing them returns to page 1. */
  params?: QueryParams;
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Controls beside the search box. */
  filters?: ReactNode;
  defaultSort?: string;
  pageSize?: number;
  /** Prefix for URL parameters when one page has two tables. */
  urlPrefix?: string;
}

/**
 * Server-driven list: search, sort and page live in the URL, so a view can be reloaded or shared.
 * Handles loading, error with retry, and empty.
 */
export function DataTable<T>({
  path,
  params,
  columns,
  searchable = true,
  searchPlaceholder,
  filters,
  defaultSort,
  pageSize = 25,
  urlPrefix,
  empty,
  className,
  ...view
}: DataTableProps<T>) {
  const { t } = useTranslation();
  const [urlParams, setUrlParams] = useSearchParams();
  const key = (name: string) => (urlPrefix ? `${urlPrefix}_${name}` : name);

  const page = Math.max(1, Number(urlParams.get(key('page'))) || 1);
  const sort = urlParams.get(key('sort')) ?? defaultSort;
  const search = urlParams.get(key('q')) ?? '';
  const [searchText, setSearchText] = useState(search);

  const update = (changes: Record<string, string | undefined>) => {
    setUrlParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [name, value] of Object.entries(changes)) {
          if (value) next.set(key(name), value);
          else next.delete(key(name));
        }
        return next;
      },
      { replace: true },
    );
  };

  // Debounced, so typing does not fire a request per keystroke.
  useEffect(() => {
    if (searchText === search) return;
    const timer = window.setTimeout(() => update({ q: searchText || undefined, page: undefined }), 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  // Filters changed: the old page number may not exist any more.
  const paramsJson = JSON.stringify(params ?? {});
  const previousParams = useRef(paramsJson);
  useEffect(() => {
    if (previousParams.current === paramsJson) return;
    previousParams.current = paramsJson;
    if (page !== 1) update({ page: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsJson]);

  const query = useList<T>(path, { ...params, page, pageSize, search: search || undefined, sort });
  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;

  // Deleting the only row on the last page would otherwise leave an empty page.
  const lastPage = meta ? Math.max(1, Math.ceil(meta.total / meta.pageSize)) : 1;
  const pastTheEnd = Boolean(meta) && !query.isFetching && rows.length === 0 && page > lastPage;
  useEffect(() => {
    if (pastTheEnd) update({ page: lastPage > 1 ? String(lastPage) : undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastTheEnd, lastPage]);

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {(searchable || filters) && (
        <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
          {searchable && (
            <div className="relative md:w-72">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                type="search"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder={searchPlaceholder ?? t('common:table.searchPlaceholder')}
                aria-label={searchPlaceholder ?? t('common:table.searchPlaceholder')}
                className="pr-10 pl-9 [&::-webkit-search-cancel-button]:hidden"
              />
              {searchText && (
                <button
                  type="button"
                  aria-label={t('common:actions.clear')}
                  onClick={() => setSearchText('')}
                  className="focus-ring absolute top-1/2 right-1.5 flex size-8 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                >
                  <X className="size-4" aria-hidden />
                </button>
              )}
            </div>
          )}
          {filters && <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">{filters}</div>}
        </div>
      )}
      <div className={cn('transition-opacity', query.isFetching && !query.isLoading && 'opacity-70')}>
        <DataTableView
          {...view}
          columns={columns}
          rows={rows}
          loading={query.isLoading}
          error={query.isError ? query.error : undefined}
          onRetry={() => void query.refetch()}
          sort={sort}
          onSortChange={(next) => update({ sort: next, page: undefined })}
          empty={
            search
              ? { title: t('common:table.noResults'), description: t('common:table.noResultsHint', { query: search }), icon: Search }
              : empty
          }
        />
      </div>
      {meta && meta.total > 0 && !query.isError && (
        <Pagination page={meta.page} pageSize={meta.pageSize} total={meta.total} onPageChange={(next) => update({ page: next > 1 ? String(next) : undefined })} />
      )}
    </div>
  );
}
