import {
  SCALE_MAX_ROWS,
  type ScaleColumns,
  type ScalePlanRow,
  parseScaleFile,
  planScaleImport,
  readScaleRows,
  scaleWeightUnit,
} from '@yap/shared/formulas/scale-file';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, FileUp, TriangleAlert } from 'lucide-react';
import { type ChangeEvent, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorCard } from '@/components';
import { Alert, Badge, Button, Checkbox, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Label, Select, Skeleton, Switch } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { decodeFileText, looksBinary } from '@/lib/file-text';
import { formatNumber, formatQty } from '@/lib/format';
import { errorMessage, pathKey, useApiMutation } from '@/lib/query';
import { type BulkResult, type CodeMatches, bulkEntries, chosenRows, codesToMatch, matcherOf } from './scale-import';

const CAMPAIGNS = '/livestock/weighing-campaigns';
const MATCH = '/livestock/animals/match-codes';
/** A day's weighing is a few kilobytes. Anything this large is not a scale file. */
const MAX_BYTES = 2 * 1024 * 1024;

type FileProblem = 'tooBig' | 'notText' | 'unreadable' | 'empty';

/** Why a line will not be recorded, in the person's words. */
function ReasonText({ row }: { row: ScalePlanRow }) {
  const { t } = useTranslation('scan');
  if (row.status === 'unreadable') return <>{t(`scale.problem.${row.problem ?? 'no_code'}`)}</>;
  if (row.status === 'several') return <>{t('scale.status.several', { tags: row.candidates.map((animal) => animal.tag).join(', ') })}</>;
  if (row.status === 'implausible') return <>{t('scale.status.implausible', { max: formatNumber(row.maxKg) })}</>;
  if (row.status === 'duplicate') return <>{t('scale.status.duplicate', { line: row.replacedByLine })}</>;
  if (row.status === 'not_on_farm') return <>{t('scale.status.not_on_farm', { tag: row.animal?.tag })}</>;
  return <>{t(`scale.status.${row.status}`)}</>;
}

export interface ScalePlanViewProps {
  plan: ScalePlanRow[];
  /** Line numbers of ready lines the person unticked. */
  excluded: ReadonlySet<number>;
  onToggle?: (line: number, include: boolean) => void;
}

/**
 * The preview: what will be recorded, with a tick on every line, and under it every line that will
 * not be, each with its reason. Nothing is sent that is not shown here.
 */
export function ScalePlanView({ plan, excluded, onToggle }: ScalePlanViewProps) {
  const { t } = useTranslation('scan');
  const ready = plan.filter((row) => row.status === 'ready');
  const left = plan.filter((row) => row.status !== 'ready');

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <h3 className="flex items-center gap-2 font-semibold">
          <CheckCircle2 className="size-5 text-success" aria-hidden />
          {t('scale.ready', { n: formatNumber(chosenRows(plan, excluded).length), of: formatNumber(ready.length) })}
        </h3>
        {ready.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('scale.none')}</p>
        ) : (
          <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-xl border border-border">
            {ready.map((row) => (
              <li key={row.line} className="flex min-h-12 items-center gap-3 px-3 py-2">
                <Checkbox
                  aria-label={t('scale.include', { tag: row.animal?.tag })}
                  checked={!excluded.has(row.line)}
                  onCheckedChange={(checked) => onToggle?.(row.line, checked === true)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold break-all tabular-nums">{row.animal?.tag}</span>
                  {(row.method === 'rfid' || row.otherHerd) && (
                    <span className="flex flex-wrap gap-1 pt-0.5">
                      {row.method === 'rfid' && <Badge variant="info">{t('scale.byRfid')}</Badge>}
                      {row.otherHerd && <Badge variant="warning">{t('scale.otherHerd')}</Badge>}
                    </span>
                  )}
                </span>
                <span className="whitespace-nowrap tabular-nums">{formatQty(row.weightKg, 'kg', 2)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {left.length > 0 && (
        <section className="space-y-2">
          <h3 className="flex items-center gap-2 font-semibold">
            <TriangleAlert className="size-5 text-warning" aria-hidden />
            {t('scale.left', { n: formatNumber(left.length) })}
          </h3>
          <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-xl border border-border">
            {left.map((row) => (
              <li key={row.line} className="px-3 py-2 text-sm" data-scale-status={row.status}>
                <p className="flex flex-wrap gap-x-2">
                  <span className="text-muted-foreground">{t('scale.line', { line: row.line })}</span>
                  <span className="font-semibold break-all">{row.code ?? '—'}</span>
                  <span className="break-all tabular-nums">{row.weightText || '—'}</span>
                </p>
                <p className="text-muted-foreground">
                  <ReasonText row={row} />
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** What the server did with the lines sent. A line it refused is named with the reason. */
export function ScaleResultView({ result }: { result: BulkResult }) {
  const { t } = useTranslation('scan');
  return (
    <div className="space-y-3">
      <Alert tone={result.applied > 0 ? 'success' : 'warning'}>{t('scale.done.applied', { n: formatNumber(result.applied) })}</Alert>
      {result.failed.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-semibold">{t('scale.done.failed', { n: formatNumber(result.failed.length) })}</h3>
          <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-xl border border-border">
            {result.failed.map((row, index) => (
              <li key={`${row.code}-${index}`} className="px-3 py-2 text-sm">
                <span className="font-semibold break-all">{row.code}</span>
                <span className="block text-muted-foreground">{errorMessage(new ApiError(409, row.error, row.error, { code: row.code }))}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export interface ScaleImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaign: { id: string; herdId: string | null; date: string };
}

/**
 * Weights from the file an electronic scale saves. The browser reads the file and nothing is sent
 * until the person has seen which animal every line means: lines the registry cannot place stay
 * out, and say why.
 */
export function ScaleImportDialog({ open, onOpenChange, campaign }: ScaleImportDialogProps) {
  const { t } = useTranslation('scan');
  const ids = useId();
  const picker = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [fileProblem, setFileProblem] = useState<FileProblem | null>(null);
  const [headerChoice, setHeaderChoice] = useState<boolean | undefined>(undefined);
  const [columnChoice, setColumnChoice] = useState<ScaleColumns | null>(null);
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set());
  const [result, setResult] = useState<BulkResult | null>(null);

  const reset = () => {
    setFile(null);
    setFileProblem(null);
    setHeaderChoice(undefined);
    setColumnChoice(null);
    setExcluded(new Set());
    setResult(null);
  };

  const parsed = useMemo(() => (file ? parseScaleFile(file.text, { header: headerChoice }) : null), [file, headerChoice]);
  const codeColumn = (columnChoice ?? parsed?.columns)?.code ?? null;
  const weightColumn = (columnChoice ?? parsed?.columns)?.weight ?? null;
  const columns: ScaleColumns = { code: codeColumn, weight: weightColumn };
  const rows = useMemo(() => (parsed ? readScaleRows(parsed, { code: codeColumn, weight: weightColumn }) : []), [parsed, codeColumn, weightColumn]);
  const tooMany = rows.length > SCALE_MAX_ROWS;
  const columnsChosen = codeColumn !== null && weightColumn !== null && codeColumn !== weightColumn;
  const codes = useMemo(() => (columnsChosen && !tooMany ? codesToMatch(rows) : []), [rows, columnsChosen, tooMany]);

  const matches = useQuery<CodeMatches[]>({
    queryKey: [...pathKey(MATCH), codes],
    queryFn: () => api.post<CodeMatches[]>(MATCH, { codes }),
    enabled: open && codes.length > 0,
    // The registry may change between two looks at the same file.
    staleTime: 0,
  });

  const { herdId, date } = campaign;
  const plan = useMemo(
    () => (columnsChosen && !tooMany && (codes.length === 0 || matches.data) ? planScaleImport(rows, matcherOf(matches.data ?? []), { herdId, date }) : null),
    [rows, columnsChosen, tooMany, codes.length, matches.data, herdId, date],
  );
  const entries = plan ? bulkEntries(plan, excluded) : [];

  const send = useApiMutation<void, BulkResult>({
    mutationFn: () => api.post<BulkResult>(`${CAMPAIGNS}/${campaign.id}/entries/bulk`, { entries }),
    invalidate: [CAMPAIGNS, '/livestock/animals'],
    onSuccess: setResult,
  });

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    // The same file can be picked again after it was corrected.
    event.target.value = '';
    if (!picked) return;
    reset();
    if (picked.size > MAX_BYTES) return setFileProblem('tooBig');
    try {
      const bytes = new Uint8Array(await picked.arrayBuffer());
      if (looksBinary(bytes)) return setFileProblem('notText');
      const text = decodeFileText(bytes);
      if (parseScaleFile(text).records.length === 0) return setFileProblem('empty');
      setFile({ name: picked.name, text });
    } catch {
      setFileProblem('unreadable');
    }
  };

  const columnOptions = Array.from({ length: parsed?.columnCount ?? 0 }, (_, index) => {
    const name = parsed?.header?.[index]?.trim() || t('scale.column', { n: index + 1 });
    const sample = parsed?.records[0]?.cells[index]?.trim();
    return { value: String(index), label: sample ? `${name} (${sample})` : name };
  });
  const pickColumn = (key: keyof ScaleColumns, value: string) => {
    setColumnChoice({ ...columns, [key]: value === '' ? null : Number(value) });
    setExcluded(new Set());
  };
  const unit = parsed ? scaleWeightUnit(parsed, weightColumn) : 'kg';
  const toggle = (line: number, include: boolean) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (include) next.delete(line);
      else next.add(line);
      return next;
    });
  const close = () => {
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('scale.title')}</DialogTitle>
          <DialogDescription>{t('scale.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {result ? (
            <ScaleResultView result={result} />
          ) : (
            <>
              <div className="space-y-2">
                <input ref={picker} type="file" accept=".csv,.txt,.tsv,.dat,text/csv,text/plain,text/tab-separated-values" className="sr-only" tabIndex={-1} aria-hidden onChange={(event) => void onFile(event)} />
                <Button variant={file ? 'outline' : 'primary'} className="w-full" onClick={() => picker.current?.click()}>
                  <FileUp aria-hidden />
                  {file ? t('scale.another') : t('scale.choose')}
                </Button>
                {file ? <p className="text-sm break-all text-muted-foreground">{file.name}</p> : <p className="text-sm text-muted-foreground">{t('scale.formats')}</p>}
                {fileProblem && <Alert tone="danger">{t(`scale.file.${fileProblem}`)}</Alert>}
              </div>

              {parsed && (
                <div className="space-y-3 rounded-xl border border-border p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={`${ids}-code`}>{t('scale.codeColumn')}</Label>
                      <Select id={`${ids}-code`} value={columns.code === null ? '' : String(columns.code)} onChange={(event) => pickColumn('code', event.target.value)} options={columnOptions} placeholder={t('scale.pick')} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`${ids}-weight`}>{t('scale.weightColumn')}</Label>
                      <Select id={`${ids}-weight`} value={columns.weight === null ? '' : String(columns.weight)} onChange={(event) => pickColumn('weight', event.target.value)} options={columnOptions} placeholder={t('scale.pick')} />
                    </div>
                  </div>
                  <div className="flex min-h-11 items-center justify-between gap-3">
                    <Label htmlFor={`${ids}-header`}>{t('scale.headerRow')}</Label>
                    <Switch
                      id={`${ids}-header`}
                      checked={parsed.header !== null}
                      onCheckedChange={(checked) => {
                        setHeaderChoice(checked);
                        setColumnChoice(null);
                        setExcluded(new Set());
                      }}
                    />
                  </div>
                </div>
              )}

              {parsed && !columnsChosen && <Alert tone="warning">{t('scale.pickColumns')}</Alert>}
              {parsed && tooMany && <Alert tone="danger">{t('scale.tooMany', { rows: formatNumber(rows.length), max: formatNumber(SCALE_MAX_ROWS) })}</Alert>}
              {parsed && unit !== 'kg' && <Alert tone="danger">{t(`scale.unit.${unit}`)}</Alert>}

              {parsed &&
                columnsChosen &&
                !tooMany &&
                (matches.error ? (
                  <ErrorCard error={matches.error} onRetry={() => void matches.refetch()} />
                ) : plan ? (
                  <ScalePlanView plan={plan} excluded={excluded} onToggle={toggle} />
                ) : (
                  <Skeleton className="h-40 w-full" />
                ))}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          {result ? (
            <Button onClick={close}>{t('scale.done.close')}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={close}>
                {t('common:actions.cancel')}
              </Button>
              <Button disabled={entries.length === 0} loading={send.isPending} onClick={() => send.mutate()}>
                {t('scale.send', { n: formatNumber(entries.length) })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
