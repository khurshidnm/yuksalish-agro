import { todayIso } from '@yap/shared';
import { ArrowLeft, CheckCircle2, Scale, Trash2, TriangleAlert } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, ComboboxField, DataTable, DateField, ErrorCard, FormDialog, TextField, useConfirm, useUrlParam } from '@/components';
import { Alert, Badge, Button, Card, Input, Label, Meter, NumberInput, Skeleton, apiOptions } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber, formatQty } from '@/lib/format';
import { zDate, zRef, zText } from '@/lib/forms';
import { errorMessage, useApiMutation, useDetail } from '@/lib/query';
import { cn } from '@/lib/utils';
import type { HerdLookup } from './shared';

const PATH = '/livestock/weighing-campaigns';

interface CampaignRow {
  id: string;
  name: string;
  date: string;
  status: 'open' | 'closed';
  herdId: string | null;
  herdName: string | null;
  weighed: number;
  total: number | null;
  averageKg: number | null;
}

interface Entry {
  id: string;
  animalId: string;
  tag: string;
  weightKg: number;
  previousKg: number | null;
  gainKg: number | null;
  adgG: number | null;
  otherHerd: boolean;
}

interface CampaignDetail extends CampaignRow {
  entries: Entry[];
}

interface EntryResult {
  tag: string;
  weightKg: number;
  previousKg: number | null;
  gainKg: number | null;
  updated: boolean;
  otherHerd: boolean;
}

const newCampaign = z.object({ herdId: zRef(), name: zText(120), date: zDate() });
type NewCampaign = z.output<typeof newCampaign>;

function WeighingScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation('livestock');
  const canManage = usePermission('livestock.update');
  const confirm = useConfirm();
  const { data, error, isLoading, refetch } = useDetail<CampaignDetail>(`${PATH}/${id}`);

  const [code, setCode] = useState('');
  const [weight, setWeight] = useState<number | null>(null);
  const [last, setLast] = useState<EntryResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const weightInput = useRef<HTMLInputElement>(null);

  const enter = useApiMutation<void, EntryResult>({
    mutationFn: () => api.post(`${PATH}/${id}/entries`, { code: code.trim(), weightKg: weight }),
    invalidate: [PATH, '/livestock/animals'],
    silentError: true,
    onSuccess: (result) => {
      setLast(result);
      setProblem(null);
      setCode('');
      setWeight(null);
      codeInput.current?.focus();
    },
    onError: (e) => setProblem(errorMessage(e)),
  });

  const removeEntry = useApiMutation<string>({
    mutationFn: (weightId) => api.delete(`/livestock/weights/${weightId}`),
    invalidate: [PATH, '/livestock/animals'],
    successMessage: 'common:toast.deleted',
  });

  const close = useApiMutation<void>({
    mutationFn: () => api.post(`${PATH}/${id}/close`),
    invalidate: [PATH],
    successMessage: 'livestock:weighing.closed',
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim()) return codeInput.current?.focus();
    if (!weight) return weightInput.current?.focus();
    enter.mutate();
  };

  if (error) return <ErrorCard error={error} onRetry={() => void refetch()} />;
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;

  const open = data.status === 'open' && canManage;
  const percent = data.total ? (data.weighed / data.total) * 100 : null;

  return (
    <div className="max-w-2xl space-y-4">
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft aria-hidden />
        {t('weighing.back')}
      </Button>

      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">{data.name}</h2>
            <p className="text-sm text-muted-foreground">
              {data.herdName} · {formatDate(data.date)}
            </p>
          </div>
          <Badge variant={data.status === 'open' ? 'success' : 'neutral'}>{t(`weighing.status.${data.status}`)}</Badge>
        </div>
        <Meter value={percent} label={t('weighing.progress')} tone="primary" />
        <div className="flex flex-wrap justify-between gap-2 text-sm">
          <span>{t('weighing.weighedOf', { weighed: data.weighed, total: data.total ?? '—' })}</span>
          <span>{t('weighing.average', { kg: formatNumber(data.averageKg, 1) })}</span>
        </div>
      </Card>

      {open && (
        <form onSubmit={submit} className="space-y-3 rounded-xl border border-primary bg-card p-4">
          <div>
            <Label htmlFor="weigh-code">{t('weighing.code')}</Label>
            {/* A scanner types the code and presses Enter, so it lands on the weight by itself. */}
            <Input
              id="weigh-code"
              ref={codeInput}
              className="h-14 text-xl font-semibold"
              autoComplete="off"
              autoFocus
              enterKeyHint="next"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (code.trim()) weightInput.current?.focus();
                }
              }}
            />
            <p className="mt-1 text-sm text-muted-foreground">{t('weighing.codeHint')}</p>
          </div>
          <div>
            <Label htmlFor="weigh-kg">{t('weighing.weight')}</Label>
            <NumberInput
              id="weigh-kg"
              ref={weightInput}
              className="h-14 text-xl font-semibold tabular-nums"
              value={weight}
              onChange={setWeight}
              suffix={t('enums:unit.kg')}
              maxDigits={2}
              enterKeyHint="done"
            />
          </div>
          <Button type="submit" size="lg" className="h-14 w-full text-lg" loading={enter.isPending}>
            <Scale aria-hidden />
            {t('weighing.record')}
          </Button>
          {problem && <Alert tone="danger">{problem}</Alert>}
          {last && !problem && (
            <p className="flex flex-wrap items-center gap-1.5 rounded-lg bg-success-soft p-3 text-success" role="status">
              <CheckCircle2 className="size-5" aria-hidden />
              <span className="font-semibold">{last.tag}</span>
              <span>{formatQty(last.weightKg, 'kg', 1)}</span>
              {last.gainKg !== null && <span className="whitespace-nowrap">({last.gainKg > 0 ? '+' : ''}{formatQty(last.gainKg, 'kg', 1)})</span>}
              {last.updated && <span>· {t('weighing.corrected')}</span>}
              {last.otherHerd && <span>· {t('weighing.otherHerd')}</span>}
            </p>
          )}
        </form>
      )}

      {data.entries.length > 0 && (
        <Card className="divide-y divide-border">
          {data.entries.slice(0, 30).map((entry) => (
            <div key={entry.id} className="flex items-center gap-3 px-4 py-3">
              <span className="font-semibold tabular-nums">{entry.tag}</span>
              {entry.otherHerd && <TriangleAlert className="size-4 text-warning" aria-label={t('weighing.otherHerd')} />}
              <span className="ms-auto whitespace-nowrap tabular-nums">{formatQty(entry.weightKg, 'kg', 1)}</span>
              <span className={cn('w-20 text-right text-sm whitespace-nowrap tabular-nums', entry.gainKg !== null && entry.gainKg < 0 ? 'text-destructive' : 'text-muted-foreground')}>
                {entry.gainKg === null ? '—' : `${entry.gainKg > 0 ? '+' : ''}${formatQty(entry.gainKg, 'kg', 1)}`}
              </span>
              {open && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('weighing.removeEntry', { tag: entry.tag })}
                  onClick={async () => {
                    const ok = await confirm({ title: t('weighing.removeEntry', { tag: entry.tag }), destructive: true });
                    if (ok) removeEntry.mutate(entry.id);
                  }}
                >
                  <Trash2 aria-hidden />
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}

      {open && (
        <Button
          variant="outline"
          className="w-full"
          onClick={async () => {
            const ok = await confirm({ title: t('weighing.closeTitle'), description: t('weighing.closeBody') });
            if (ok) close.mutate();
          }}
        >
          {t('weighing.close')}
        </Button>
      )}
    </div>
  );
}

export function WeighingPanel() {
  const { t } = useTranslation('livestock');
  const canManage = usePermission('livestock.update');
  const [campaign, setCampaign] = useUrlParam('campaign');
  const [herdParam] = useUrlParam('herd');
  // The herd card's "start weighing" opens the form at once.
  const [startParam, setStartParam] = useUrlParam('start');
  const [creating, setCreatingState] = useState(() => canManage && startParam === '1');
  const setCreating = (open: boolean) => {
    setCreatingState(open);
    if (!open && startParam) setStartParam('');
  };

  const create = useApiMutation<NewCampaign, { id: string }>({
    mutationFn: (values) => api.post(PATH, values),
    invalidate: [PATH],
    silentError: true,
    onSuccess: (row) => setCampaign(row.id),
  });

  if (campaign) return <WeighingScreen id={campaign} onBack={() => setCampaign('')} />;

  const columns: Column<CampaignRow>[] = [
    { key: 'name', header: t('fields.name'), cell: (row) => row.name, sortable: true, mobile: 'title' },
    { key: 'date', header: t('fields.date'), cell: (row) => formatDate(row.date), sortable: true, mobile: 'subtitle' },
    { key: 'herd', header: t('fields.herd'), cell: (row) => row.herdName ?? '—' },
    { key: 'progress', header: t('weighing.progress'), align: 'right', cell: (row) => `${formatNumber(row.weighed)} / ${formatNumber(row.total)}` },
    { key: 'average', header: t('weighing.averageShort'), align: 'right', cell: (row) => formatQty(row.averageKg, 'kg', 1) },
    { key: 'status', header: t('fields.status'), cell: (row) => <Badge variant={row.status === 'open' ? 'success' : 'neutral'}>{t(`weighing.status.${row.status}`)}</Badge> },
  ];

  return (
    <div className="space-y-3">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setCreating(true)}>
            <Scale aria-hidden />
            {t('weighing.start')}
          </Button>
        </div>
      )}
      <DataTable<CampaignRow>
        path={PATH}
        urlPrefix="w"
        columns={columns}
        defaultSort="-date"
        searchable={false}
        onRowClick={(row) => setCampaign(row.id)}
        empty={{ icon: Scale, title: t('weighing.emptyTitle'), description: t('weighing.emptyBody') }}
      />
      <FormDialog
        open={creating}
        onOpenChange={setCreating}
        title={t('weighing.start')}
        schema={newCampaign}
        defaultValues={{ herdId: herdParam, name: t('weighing.defaultName'), date: todayIso() }}
        onSubmit={(values) => create.mutateAsync(values)}
        submitLabel={t('weighing.begin')}
      >
        {(form) => (
          <>
            <ComboboxField
              form={form}
              name="herdId"
              label={t('fields.herd')}
              required
              loadOptions={apiOptions<HerdLookup>('/livestock/herds/lookup', (h) => ({ value: h.id, label: h.name, hint: t('head', { count: h.headCount }) }))}
            />
            <TextField form={form} name="name" label={t('fields.name')} required />
            <DateField form={form} name="date" label={t('fields.date')} required max={todayIso()} />
          </>
        )}
      </FormDialog>
    </div>
  );
}
