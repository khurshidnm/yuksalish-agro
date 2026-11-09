import { ChartCard } from '@/components/ChartCard';
import { formatDate, formatQty } from '@/lib/format';

export interface WeightChartProps {
  title: string;
  seriesLabel: string;
  data: { date: string; weightKg: number }[];
}

/** Separate file so Recharts loads only when the weights tab is opened. */
export default function WeightChart({ title, seriesLabel, data }: WeightChartProps) {
  return (
    <ChartCard
      title={title}
      kind="line"
      data={data}
      xKey="date"
      series={[{ key: 'weightKg', label: seriesLabel }]}
      formatValue={(v) => formatQty(v, 'kg', 1)}
      // From zero, a 72.9 → 75.3 kg gain is a flat line: the axis follows the weights.
      yDomain={['auto', 'auto']}
      formatX={(d) => formatDate(String(d))}
      formatLabel={(d) => formatDate(String(d))}
    />
  );
}
