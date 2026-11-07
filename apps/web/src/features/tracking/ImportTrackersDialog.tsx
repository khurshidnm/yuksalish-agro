/**
 * Register trackers and fit them to sheep from the seller's list. The list is pasted, checked on the
 * server first (nothing changes), and imported only when every line is right: all or nothing.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { todayIso } from '@yap/shared';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { DateField, SelectField, TextareaField } from '@/components';
import { Alert, Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { zDate, zEnum } from '@/lib/forms';
import { errorMessage, queryClient, pathKey } from '@/lib/query';
import { LIVE, TRACKER_KINDS, TRACKERS, type ImportResult, type TrackerKind } from './types';

const MAX_ROWS = 1000;

const schema = z.object({
  text: z.string().trim().min(1),
  kind: zEnum(TRACKER_KINDS as [TrackerKind, ...TrackerKind[]]),
  fittedOn: zDate(),
});
type Values = z.infer<typeof schema>;

export interface ParsedRow {
  externalId: string;
  kind: TrackerKind;
  animal: string | null;
}

/**
 * One tracker per line: `DevEUI`, `DevEUI, ear tag` or `DevEUI, kind, ear tag`, separated by
 * commas, semicolons or tabs, as a spreadsheet copies them. A header line is skipped.
 */
export function parseTrackerList(text: string, defaultKind: TrackerKind): ParsedRow[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split(/[,;\t]/).map((cell) => cell.trim()))
    .filter((cells) => cells[0])
    .filter((cells, index) => !(index === 0 && /eui|serial|id/i.test(cells[0]!) && !/^[0-9a-f:\- ]{16,23}$/i.test(cells[0]!)))
    .map((cells) => {
      const kind = cells.length >= 3 && (TRACKER_KINDS as string[]).includes(cells[1]!.toLowerCase()) ? (cells[1]!.toLowerCase() as TrackerKind) : defaultKind;
      const animal = (cells.length >= 3 ? cells[2] : cells[1]) || null;
      return { externalId: cells[0]!, kind, animal };
    });
}

export function ImportTrackersDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('tracking');
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { text: '', kind: 'collar', fittedOn: todayIso() } });
  const [checked, setChecked] = useState<{ key: string; result: ImportResult } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    form.reset({ text: '', kind: 'collar', fittedOn: todayIso() });
    setChecked(null);
    setError(null);
    // Only opening resets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const values = form.watch();
  const rows = useMemo(() => parseTrackerList(values.text ?? '', values.kind ?? 'collar'), [values.text, values.kind]);
  const key = JSON.stringify([rows, values.fittedOn]);
  const ready = checked?.key === key && checked.result.summary.errors === 0;

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    if (rows.length > MAX_ROWS) {
      setError(t('import.tooMany', { max: MAX_ROWS }));
      return;
    }
    try {
      const result = await api.post<ImportResult>(`${TRACKERS}/import`, { dryRun: !ready, fittedOn: v.fittedOn, rows });
      if (!result.applied) {
        setChecked({ key, result });
        return;
      }
      await Promise.all([TRACKERS, LIVE].map((path) => queryClient.invalidateQueries({ queryKey: pathKey(path) })));
      toast.success(t('import.done', { registered: result.summary.register, fitted: result.summary.fit }));
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  const problems = checked?.key === key ? checked.result.rows.filter((r) => r.error) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <form onSubmit={(e) => void submit(e)} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{t('import.title')}</DialogTitle>
            <DialogDescription>{t('import.description')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <TextareaField form={form} name="text" label={t('import.list')} hint={t('import.listHint')} rows={8} placeholder={t('import.placeholder')} required />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField form={form} name="kind" label={t('import.defaultKind')} options={TRACKER_KINDS.map((k) => ({ value: k, label: t(`kind.${k}`) }))} />
              <DateField form={form} name="fittedOn" label={t('fields.fittedOn')} />
            </div>
            <p className="text-sm text-muted-foreground">{t('import.lines', { count: rows.length })}</p>

            {checked?.key === key && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="info">{t('import.summary.register', { count: checked.result.summary.register })}</Badge>
                  <Badge variant="success">{t('import.summary.fit', { count: checked.result.summary.fit })}</Badge>
                  {checked.result.summary.move > 0 && <Badge variant="warning">{t('import.summary.move', { count: checked.result.summary.move })}</Badge>}
                  {checked.result.summary.unchanged > 0 && <Badge>{t('import.summary.unchanged', { count: checked.result.summary.unchanged })}</Badge>}
                  {checked.result.summary.errors > 0 && <Badge variant="danger">{t('import.summary.errors', { count: checked.result.summary.errors })}</Badge>}
                </div>
                {problems.length > 0 ? (
                  <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-3 text-sm">
                    {problems.slice(0, 50).map((r) => (
                      <li key={r.index} className="break-words">
                        <span className="font-medium">{t('import.line', { line: r.index + 1 })}</span> {r.externalId}
                        {r.animalTag ? ` · ${r.animalTag}` : ''}: <span className="text-danger">{t(`errors.${r.error}`, { defaultValue: r.error ?? '' })}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Alert tone="success">{t('import.allGood')}</Alert>
                )}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} disabled={rows.length === 0}>
              {ready ? t('import.apply', { count: rows.length }) : t('import.check')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
