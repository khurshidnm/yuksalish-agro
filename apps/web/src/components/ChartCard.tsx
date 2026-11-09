import { BarChart3, Table2 } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip as ChartTooltipBase,
  XAxis,
  YAxis,
} from 'recharts';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { formatAxisValue, formatEndValue, plottedValues, valueAxis } from './chartScale';
import { EmptyState } from './EmptyState';
import { ErrorCard } from './ErrorCard';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton, TBody, THead, Table, Td, Th, Tr, Tooltip } from './ui';

/*
 * Conventions, following the data-viz method this app uses:
 * - Colour identifies a series. Slots run in a fixed, validated order; give a series an explicit `slot`
 *   when a filter can remove others, so the survivors keep their colour.
 * - Status colours are never series colours. Text never wears a series colour.
 * - Thin marks, recessive grid, one y axis. Two scales means two charts.
 * - Amber, teal and olive fall below 3:1 on the light surface, so the table view is always available.
 * - Dashes mean "not happened yet". A dashed series is a projection, never a style choice.
 * - Block bars keep their exact height: gaps are cut into the bar, the value is never rounded to a block.
 *   They are one series in lime, under 3:1 on white, so the axis, tooltip and table carry the numbers.
 */

const MAX_SERIES = 8;

/** The CSS colour of a categorical slot, 1 to 8. */
export function chartColor(slot: number): string {
  return `var(--chart-${((slot - 1) % MAX_SERIES) + 1})`;
}

export type ChartKind = 'bar' | 'block-bar' | 'stacked-bar' | 'line' | 'area';

export interface ChartSeries {
  key: string;
  label: string;
  /** Categorical colour slot, 1 to 8. Defaults to the series position. */
  slot?: number;
  /** A projection rather than a record. Lines and areas only. */
  dashed?: boolean;
}

export interface ChartCardProps<T> {
  title: ReactNode;
  description?: ReactNode;
  kind: ChartKind;
  data: T[];
  xKey: keyof T & string;
  series: ChartSeries[];
  /** Full value for tooltip and table: (v) => formatMoney(v). */
  formatValue?: (value: number) => string;
  /** Short value for the axis. Defaults to compact numbers with the decimals the tick step needs. */
  formatAxis?: (value: number) => string;
  /** Value axis range. Defaults to keeping 0 on the axis; use ['auto', 'auto'] for readings like pH. */
  yDomain?: [number | 'auto', number | 'auto'];
  /** Shades a stretch of the x axis, by x value: the months a forecast goes negative. */
  highlight?: { from: string; to: string; tone?: 'neutral' | 'danger' };
  /** Axis label for the x value, e.g. formatMonthShort. */
  formatX?: (value: string) => string;
  /** Tooltip and table label. Defaults to formatX; use it for the full form, e.g. formatMonth. */
  formatLabel?: (value: string) => string;
  height?: number;
  /** Controls in the card header, such as a period select. */
  action?: ReactNode;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyText?: ReactNode;
  className?: string;
}

/** Steps of a block bar, and the gap cut between them. */
const BLOCKS = 8;
const BLOCK_GAP = 3;

interface BlockBarProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  background?: { y?: number | null; height?: number | null };
}

/**
 * A column of blocks over its empty slots. The filled part stops at the true value, part-way through
 * a block if need be, so the shape stays honest; the tooltip and table give the number.
 */
function BlockBar({ x = 0, y = 0, width = 0, height = 0, fill, background }: BlockBarProps) {
  const bottom = y + height;
  const top = background?.y ?? y;
  const full = background?.height ?? height;
  const floor = top + full;
  const step = full / BLOCKS;
  const size = Math.max(step - BLOCK_GAP, 1);
  return (
    <g>
      {Array.from({ length: BLOCKS }, (_, i) => {
        const blockBottom = floor - i * step;
        const filled = Math.min(size, Math.max(0, blockBottom - y));
        return (
          <g key={i}>
            <rect x={x} y={blockBottom - size} width={width} height={size} rx={3} fill="var(--mark-track)" />
            {filled > 0 && bottom >= blockBottom - size && <rect x={x} y={blockBottom - filled} width={width} height={filled} rx={3} fill={fill} />}
          </g>
        );
      })}
    </g>
  );
}

interface TooltipEntry {
  dataKey?: string | number;
  value?: number | string;
  color?: string;
}

function ChartTooltipContent({
  active,
  label,
  payload,
  series,
  formatValue,
  formatX,
}: {
  active?: boolean;
  label?: string | number;
  payload?: readonly TooltipEntry[];
  series: ChartSeries[];
  formatValue: (value: number) => string;
  formatX: (value: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="max-w-64 rounded-lg border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-pop">
      <p className="mb-1 font-medium">{formatX(String(label ?? ''))}</p>
      <ul className="flex flex-col gap-1">
        {payload.map((entry) => {
          const s = series.find((item) => item.key === entry.dataKey);
          return (
            <li key={String(entry.dataKey)} className="flex items-center justify-between gap-4">
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <span className="size-2.5 shrink-0 rounded-sm" style={{ background: entry.color }} aria-hidden />
                <span className="truncate">{s?.label ?? entry.dataKey}</span>
              </span>
              <span className="font-medium tabular-nums">{entry.value === null || entry.value === undefined ? '—' : formatValue(Number(entry.value))}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ChartLegend({ series }: { series: { label: string; color: string }[] }) {
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
      {series.map((s) => (
        <li key={s.label} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * End labels are dropped when two lines finish too close together to read. Closeness is measured on the
 * axis, which usually runs from zero: 68 and 69 thousand are far apart within 62 to 69, but on a 0 to 80
 * thousand axis their labels print on top of each other.
 */
function canLabelEnds<T>(data: T[], series: ChartSeries[], axisSpan: number | null): boolean {
  if (series.length > 4 || data.length === 0) return false;
  const row = data[data.length - 1] as Record<string, unknown>;
  const lastValues = series.map((s) => Number(row[s.key])).filter(Number.isFinite);
  if (lastValues.length !== series.length) return false;
  const all = data.flatMap((d) => series.map((s) => Number((d as Record<string, unknown>)[s.key]))).filter(Number.isFinite);
  const span = Math.max(Math.max(...all) - Math.min(...all), axisSpan ?? 0);
  if (span === 0) return series.length === 1;
  const sorted = [...lastValues].sort((a, b) => a - b);
  return sorted.every((v, i) => i === 0 || v - sorted[i - 1] > span * 0.08);
}

interface EndLabelProps {
  x?: number | string;
  y?: number | string;
  index?: number;
  value?: unknown;
}

function endLabel(lastIndex: number, format: (value: number) => string) {
  return function EndLabel({ x, y, index, value }: EndLabelProps) {
    if (index !== lastIndex || x === undefined || y === undefined || value === undefined || value === null) return <g />;
    return (
      <text x={Number(x) + 8} y={Number(y)} dy={4} fontSize={12} fontWeight={600} fill="var(--foreground)">
        {format(Number(value))}
      </text>
    );
  };
}

function endDot(lastIndex: number, color: string) {
  return function EndDot({ cx, cy, index }: { cx?: number; cy?: number; index?: number }) {
    if (index !== lastIndex || cx === undefined || cy === undefined) return <g key={index} />;
    return <circle key={index} cx={cx} cy={cy} r={4} fill={color} stroke="var(--card)" strokeWidth={2} />;
  };
}

/**
 * A themed chart in a card, with legend, hover tooltip and a table view.
 * `<ChartCard title="…" kind="bar" data={rows} xKey="month"
 *    series={[{ key: 'income', label: t('income') }, { key: 'expense', label: t('expense') }]}
 *    formatValue={(v) => formatMoney(v)} />`
 * Import from '@/components/ChartCard' directly, so pages without charts do not load Recharts.
 */
export function ChartCard<T>({
  title,
  description,
  kind,
  data,
  xKey,
  series,
  formatValue = (v) => formatNumber(v),
  formatAxis,
  formatX = (v) => v,
  formatLabel = formatX,
  yDomain,
  highlight,
  height = 280,
  action,
  loading,
  error,
  onRetry,
  emptyText,
  className,
}: ChartCardProps<T>) {
  const { t } = useTranslation();
  const [showTable, setShowTable] = useState(false);

  const resolved = useMemo(() => series.map((s, i) => ({ ...s, color: chartColor(s.slot ?? i + 1) })), [series]);
  const lastIndex = data.length - 1;
  const rows = data as Record<string, unknown>[];

  // Round value ticks worked out here, so the default labels carry exactly the decimals the step needs.
  // Without a yDomain, zero stays on the axis. A formatAxis of fixed decimals gets no 2.5 steps.
  const [lowBound, highBound] = yDomain ?? [0, 0];
  const adaptiveLabels = !formatAxis;
  const scale = useMemo(
    () => valueAxis(plottedValues(rows, series.map((s) => s.key), kind === 'stacked-bar'), [lowBound, highBound], adaptiveLabels),
    [rows, series, kind, lowBound, highBound, adaptiveLabels],
  );
  const labelEnds = (kind === 'line' || kind === 'area') && canLabelEnds(data, series, scale ? scale.domain[1] - scale.domain[0] : null);
  const margin = { top: 8, right: labelEnds ? 64 : 8, bottom: 0, left: 0 };
  const axisFormat = formatAxis ?? ((value: number) => formatAxisValue(value, scale?.step ?? null));
  const endFormat = formatAxis ?? ((value: number) => formatEndValue(value, scale?.step ?? null));

  const axes = (
    <>
      {kind !== 'block-bar' && <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={1} />}
      {/* Every nth label, the same n throughout, so months never skip unevenly. */}
      <XAxis
        dataKey={String(xKey)}
        tickFormatter={(v) => formatX(String(v))}
        tick={{ fill: 'var(--chart-text)', fontSize: 12 }}
        tickLine={false}
        axisLine={{ stroke: 'var(--chart-baseline)' }}
        interval="equidistantPreserveStart"
        minTickGap={16}
      />
      <YAxis
        domain={scale?.domain ?? yDomain}
        ticks={scale?.ticks}
        niceTicks={scale ? 'none' : undefined}
        tickFormatter={axisFormat}
        tick={{ fill: 'var(--chart-text)', fontSize: 12 }}
        tickLine={false}
        axisLine={false}
        width={76}
      />
    </>
  );

  const tooltip = (cursor: object) => (
    <ChartTooltipBase
      cursor={cursor}
      content={(props) => (
        <ChartTooltipContent
          active={props.active}
          label={props.label as string | number | undefined}
          payload={props.payload as readonly TooltipEntry[] | undefined}
          series={series}
          formatValue={formatValue}
          formatX={formatLabel}
        />
      )}
    />
  );

  const period = highlight && (
    <ReferenceArea
      x1={highlight.from}
      x2={highlight.to}
      ifOverflow="extendDomain"
      fill={highlight.tone === 'danger' ? 'var(--destructive)' : 'var(--mark)'}
      fillOpacity={0.1}
      strokeOpacity={0}
    />
  );

  const barCursor = { fill: 'var(--muted)', fillOpacity: 0.6 };
  const lineCursor = { stroke: 'var(--chart-baseline)', strokeWidth: 1 };

  const chart = () => {
    if (kind === 'line') {
      return (
        <LineChart data={rows} margin={margin}>
          {axes}
          {period}
          {tooltip(lineCursor)}
          {resolved.map((s) => (
            <Line
              key={s.key}
              dataKey={s.key}
              stroke={s.color}
              strokeWidth={2}
              strokeDasharray={s.dashed ? '6 5' : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={endDot(lastIndex, s.color)}
              activeDot={{ r: 5, stroke: 'var(--card)', strokeWidth: 2 }}
              label={labelEnds ? endLabel(lastIndex, endFormat) : undefined}
              isAnimationActive={false}
              connectNulls={false}
            />
          ))}
        </LineChart>
      );
    }
    if (kind === 'area') {
      return (
        <AreaChart data={rows} margin={margin}>
          {axes}
          {period}
          {tooltip(lineCursor)}
          {resolved.map((s) => (
            <Area
              key={s.key}
              dataKey={s.key}
              stroke={s.color}
              strokeWidth={2}
              strokeDasharray={s.dashed ? '6 5' : undefined}
              fill={s.color}
              fillOpacity={0.1}
              dot={endDot(lastIndex, s.color)}
              activeDot={{ r: 5, stroke: 'var(--card)', strokeWidth: 2 }}
              label={labelEnds ? endLabel(lastIndex, endFormat) : undefined}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      );
    }
    if (kind === 'block-bar') {
      return (
        <BarChart data={rows} margin={margin} barCategoryGap="18%">
          {axes}
          {tooltip(barCursor)}
          {resolved.map((s) => (
            <Bar key={s.key} dataKey={s.key} fill="var(--accent)" maxBarSize={32} background={{ fill: 'transparent' }} shape={BlockBar} isAnimationActive={false} />
          ))}
        </BarChart>
      );
    }
    const stacked = kind === 'stacked-bar';
    return (
      <BarChart data={rows} margin={margin} barGap={2} barCategoryGap="24%">
        {axes}
        {tooltip(barCursor)}
        {resolved.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            stackId={stacked ? 'stack' : undefined}
            fill={s.color}
            maxBarSize={24}
            radius={!stacked || i === resolved.length - 1 ? [4, 4, 0, 0] : 0}
            stroke={stacked ? 'var(--card)' : undefined}
            strokeWidth={stacked ? 2 : undefined}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    );
  };

  const isEmpty = !loading && !error && data.length === 0;

  return (
    <Card className={cn('min-w-0', className)}>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 basis-40">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {action}
          <Tooltip content={showTable ? t('common:chart.showChart') : t('common:chart.showTable')}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="bg-muted hover:bg-secondary"
              aria-label={showTable ? t('common:chart.showChart') : t('common:chart.showTable')}
              aria-pressed={showTable}
              onClick={() => setShowTable((v) => !v)}
            >
              {showTable ? <BarChart3 aria-hidden /> : <Table2 aria-hidden />}
            </Button>
          </Tooltip>
        </div>
      </CardHeader>
      <CardContent>
        {loading && <Skeleton style={{ height }} className="w-full" />}
        {!loading && Boolean(error) && <ErrorCard error={error} onRetry={onRetry} className="border-0 py-6 shadow-none" />}
        {isEmpty && <EmptyState title={emptyText ?? t('common:chart.noData')} className="py-8" />}
        {!loading && !error && !isEmpty && showTable && (
          <div className="overflow-y-auto" style={{ maxHeight: height }}>
            <Table>
              <THead>
                <Tr>
                  <Th>{t('common:chart.period')}</Th>
                  {series.map((s) => (
                    <Th key={s.key} className="text-right">
                      {s.label}
                    </Th>
                  ))}
                </Tr>
              </THead>
              <TBody>
                {rows.map((row, i) => (
                  <Tr key={i}>
                    <Td>{formatLabel(String(row[xKey]))}</Td>
                    {series.map((s) => (
                      <Td key={s.key} className="text-right tabular-nums">
                        {row[s.key] === null || row[s.key] === undefined ? '—' : formatValue(Number(row[s.key]))}
                      </Td>
                    ))}
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        )}
        {!loading && !error && !isEmpty && !showTable && (
          <>
            {series.length > 1 && <ChartLegend series={resolved} />}
            <div role="img" aria-label={typeof title === 'string' ? title : undefined} style={{ height }}>
              <ResponsiveContainer width="100%" height="100%">
                {chart()}
              </ResponsiveContainer>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
