import { CheckCheck, ClipboardList, FileDown, Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Badge,
  Button,
  Combobox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorCard,
  Label,
  NumberInput,
  Skeleton,
  useConfirm,
} from '@/components';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatMoney, formatQty } from '@/lib/format';
import i18n from '@/lib/i18n';
import { errorMessage, useApiMutation, useDetail } from '@/lib/query';
import { type CountEntries, actualOf, bookOf, countPayload, differenceOf, enterCount } from './count-entry';
import { STOCK_PATHS, itemOptions } from './shared';
import type { CountDetail } from './types';

function Difference({ value, unit }: { value: number; unit: string }) {
  if (value === 0) return null;
  return (
    <Badge variant={value < 0 ? 'danger' : 'info'}>
      {value > 0 ? '+' : '−'}
      {formatQty(Math.abs(value), unit)}
    </Badge>
  );
}

/** The count sheet: book quantity beside what was actually counted, with the difference as you type. */
export function CountDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation('inventory');
  const canEdit = usePermission('inventory.create');
  const canApprove = usePermission('inventory.update');
  const canSeeMoney = usePermission('finance.view');
  const confirm = useConfirm();
  const path = `/inventory/counts/${id}`;
  const detail = useDetail<CountDetail>(path);
  const count = detail.data;
  const isDraft = count?.status === 'draft';
  const editable = isDraft && canEdit;

  const [entered, setEntered] = useState<CountEntries>({});
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    setEntered({});
    setFailure(null);
  }, [id]);

  const lines = count?.lines ?? [];
  const blank = lines.some((line) => actualOf(entered, line) === null);
  const differences = lines.filter((line) => differenceOf(entered, line) !== 0).length;

  const payload = () => countPayload(entered, lines);

  const save = useApiMutation<void, unknown>({
    mutationFn: async () => {
      if (Object.keys(entered).length > 0) await api.patch(path, { lines: payload() });
    },
    invalidate: ['/inventory/counts'],
    successMessage: 'common:toast.updated',
    onSuccess: () => setEntered({}),
    onError: (error) => setFailure(errorMessage(error)),
    silentError: true,
  });

  const addItem = useApiMutation<string, unknown>({
    mutationFn: (itemId) => api.patch(path, { lines: [{ itemId, actualQty: 0 }] }),
    invalidate: ['/inventory/counts'],
  });

  const approve = useApiMutation<void, unknown>({
    mutationFn: async () => {
      if (Object.keys(entered).length > 0) await api.patch(path, { lines: payload() });
      await api.post(`${path}/approve`);
    },
    invalidate: STOCK_PATHS,
    successMessage: 'inventory:counts.approved',
    onSuccess: () => setEntered({}),
    onError: (error) => setFailure(errorMessage(error)),
    silentError: true,
  });

  const remove = useApiMutation<void, unknown>({
    mutationFn: () => api.delete(path),
    invalidate: ['/inventory/counts'],
    successMessage: 'common:toast.deleted',
    onSuccess: onClose,
  });

  const askApprove = async () => {
    setFailure(null);
    const ok = await confirm({
      title: t('counts.approveTitle'),
      description: t('counts.approveBody', { count: differences }),
      confirmLabel: t('common:actions.approve'),
    });
    if (ok) approve.mutate();
  };

  const askDelete = async () => {
    const ok = await confirm({ title: t('counts.deleteTitle'), description: t('counts.deleteBody'), destructive: true });
    if (ok) remove.mutate();
  };

  const download = () => void api.download(`${path}/pdf`, `${count?.docNo ?? 'count'}.pdf`, { lang: i18n.language });

  const totalDiff = lines.reduce((sum, line) => sum + (line.diffCost ?? 0), 0);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{count ? t('counts.sheetTitle', { docNo: count.docNo }) : t('counts.title')}</DialogTitle>
          <DialogDescription>{count ? `${count.warehouseName ?? '—'} · ${formatDate(count.date)}` : t('counts.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {detail.isLoading && (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}
          {detail.error && <ErrorCard error={detail.error} onRetry={() => void detail.refetch()} />}
          {failure && <Alert tone="danger">{failure}</Alert>}

          {count && !isDraft && (
            <Alert tone="success" title={t('counts.approvedBy', { name: count.approvedByName ?? '—' })}>
              {canSeeMoney && t('counts.totalDiff', { amount: formatMoney(totalDiff) })}
            </Alert>
          )}

          {count && lines.length === 0 && <EmptyState icon={ClipboardList} title={t('counts.noLinesTitle')} description={t('counts.noLinesBody')} />}

          <ul className="flex flex-col divide-y divide-border">
            {lines.map((line) => {
              const actual = actualOf(entered, line);
              const diff = isDraft ? differenceOf(entered, line) : line.diffQty;
              return (
                <li key={line.id} className="grid grid-cols-[minmax(0,1fr)_8.5rem] items-center gap-x-3 gap-y-1 py-3">
                  <div className="min-w-0">
                    <p className="font-medium break-words">{line.itemName}</p>
                    <p className="text-sm text-muted-foreground">{t('counts.book', { qty: formatQty(bookOf(entered, line), line.unit) })}</p>
                  </div>
                  {editable ? (
                    <NumberInput
                      aria-label={t('counts.actualFor', { item: line.itemName })}
                      value={actual ?? null}
                      onChange={(value) => setEntered((prev) => enterCount(prev, line, value))}
                      suffix={t(`enums:unit.${line.unit}`)}
                    />
                  ) : (
                    <p className="text-right font-medium">{formatQty(line.actualQty, line.unit)}</p>
                  )}
                  <div className="col-span-2 flex items-center justify-end gap-2 empty:hidden">
                    <Difference value={diff} unit={line.unit} />
                    {!isDraft && canSeeMoney && line.diffCost !== 0 && <span className="text-sm text-muted-foreground">{formatMoney(line.diffCost)}</span>}
                  </div>
                </li>
              );
            })}
          </ul>

          {editable && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="count-add-item">
                <Plus className="mr-1 inline size-4" aria-hidden />
                {t('counts.addItem')}
              </Label>
              <Combobox
                id="count-add-item"
                value={null}
                loadOptions={itemOptions()}
                placeholder={t('counts.addItemPlaceholder')}
                onChange={(value) => value && !lines.some((line) => line.itemId === value) && addItem.mutate(value)}
              />
            </div>
          )}
        </DialogBody>
        {count && (
          <DialogFooter>
            <Button variant="outline" onClick={download}>
              <FileDown aria-hidden />
              {t('document.pdf')}
            </Button>
            {editable && (
              <Button variant="ghost" onClick={() => void askDelete()} loading={remove.isPending}>
                <Trash2 aria-hidden />
                {t('common:actions.delete')}
              </Button>
            )}
            {editable && (
              <Button variant="secondary" disabled={blank || Object.keys(entered).length === 0} onClick={() => save.mutate()} loading={save.isPending}>
                <Save aria-hidden />
                {t('common:actions.save')}
              </Button>
            )}
            {isDraft && canApprove && (
              <Button disabled={blank || lines.length === 0} onClick={() => void askApprove()} loading={approve.isPending}>
                <CheckCheck aria-hidden />
                {t('common:actions.approve')}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
