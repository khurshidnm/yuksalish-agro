import { addDays, todayIso } from '@yap/shared';
import { Clock, FileText, Tractor } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, DataTableView, DateField, ErrorCard, FormDialog, FormGrid, MoneyText, StatCard, useUrlParam } from '@/components';
import { Alert, Button, Card, CardContent, DateInput, Label } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatMonth, formatNumber } from '@/lib/format';
import { zDate } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';
import type { AssetCard, AssetCosts, DepreciationEntry } from './types';

const actSchema = z.object({ from: zDate(), to: zDate() });

interface RentalAct {
  unit: string;
  price: number;
  total: number;
  lines: { fieldNumber: string | null; quantity: number; amount: number; status: string }[];
}

function RentalActButton({ asset }: { asset: AssetCard }) {
  const { t } = useTranslation('assets');
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<RentalAct | null>(null);
  const create = useApiMutation<z.output<typeof actSchema>, RentalAct>({
    mutationFn: (values) => api.postOnce<RentalAct>(`/assets/${asset.id}/rental-act`, values),
    invalidate: [`/assets/${asset.id}`, '/finance'],
    silentError: true,
    onSuccess: setResult,
  });
  return (
    <>
      <Button variant="outline" size="lg" onClick={() => setOpen(true)}>
        <FileText aria-hidden />
        {t('rental.createAct')}
      </Button>
      {result && (
        <Alert tone="success" title={t('rental.created')}>
          <ul>
            {result.lines.map((line, index) => (
              <li key={index}>
                {line.fieldNumber ? `№${line.fieldNumber}` : t('rental.noField')}: {formatNumber(line.quantity)} {t(`rentalUnit.${result.unit}`)} — <MoneyText value={line.amount} />
              </li>
            ))}
          </ul>
          <p className="mt-1 font-medium">
            {t('rental.total')}: <MoneyText value={result.total} />
          </p>
        </Alert>
      )}
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={t('rental.createAct')}
        description={t('rental.hint')}
        schema={actSchema}
        defaultValues={{ from: addDays(todayIso(), -30), to: todayIso() }}
        onSubmit={(values) => create.mutateAsync(values)}
        size="sm"
      >
        {(form) => (
          <FormGrid>
            <DateField form={form} name="from" label={t('costs.from')} required />
            <DateField form={form} name="to" label={t('costs.to')} required />
          </FormGrid>
        )}
      </FormDialog>
    </>
  );
}

export function AssetCostsTab({ asset }: { asset: AssetCard }) {
  const { t } = useTranslation('assets');
  const canInvoice = usePermission('finance.create');
  const [from, setFrom] = useUrlParam('from');
  const [to, setTo] = useUrlParam('to');

  const { data, isLoading, error, refetch } = useDetail<AssetCosts>(`/assets/${asset.id}/costs`, { from: from || undefined, to: to || undefined });
  const { data: entries } = useDetail<DepreciationEntry[]>(`/assets/${asset.id}/depreciation`);

  if (error) return <ErrorCard error={error} onRetry={() => void refetch()} />;

  const rows: [string, number | undefined][] = [
    [t('costs.fuel'), data?.fuel],
    [t('costs.labor'), data?.labor],
    [t('costs.repairs'), data?.repairs],
    [t('costs.depreciation'), data?.depreciation],
  ];

  const depreciationColumns: Column<DepreciationEntry>[] = [
    { key: 'month', header: t('costs.month'), mobile: 'title', cell: (row) => formatMonth(row.month) },
    { key: 'amount', header: t('costs.amount'), align: 'right', cell: (row) => <MoneyText value={row.amount} /> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="space-y-1.5">
          <Label htmlFor="cost-from">{t('costs.from')}</Label>
          <DateInput id="cost-from" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cost-to">{t('costs.to')}</Label>
          <DateInput id="cost-to" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard icon={Clock} label={t('costs.perHour')} value={<MoneyText value={data?.costPerHour ?? null} />} hint={t('costs.overHours', { hours: formatNumber(data?.hours ?? 0) })} loading={isLoading} />
        <StatCard icon={Tractor} label={t('costs.perHectare')} value={<MoneyText value={data?.costPerHectare ?? null} />} hint={t('costs.overHectares', { hectares: formatNumber(data?.hectares ?? 0) })} loading={isLoading} />
        <StatCard label={t('costs.total')} value={<MoneyText value={data?.total ?? null} compact />} loading={isLoading} />
      </div>

      <Card>
        <CardContent className="pt-4">
          <h3 className="mb-2 text-sm font-medium">{t('costs.breakdown')}</h3>
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 border-b border-border py-2 text-sm last:border-0">
              <span className="text-muted-foreground">{label}</span>
              <MoneyText value={value ?? null} />
            </div>
          ))}
        </CardContent>
      </Card>

      {asset.rented && canInvoice && <RentalActButton asset={asset} />}

      {!asset.rented && (
        <div>
          <h3 className="mb-2 text-sm font-medium">{t('costs.depreciationHistory')}</h3>
          <DataTableView<DepreciationEntry>
            rows={entries ?? []}
            columns={depreciationColumns}
            empty={{ title: t('costs.noDepreciation'), description: t('costs.noDepreciationBody') }}
          />
        </div>
      )}
    </div>
  );
}
