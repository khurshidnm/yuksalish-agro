import { DOCUMENT_TYPES } from '@yap/shared';
import { Ban, CheckCircle2, FileText, Paperclip, Pencil, Printer, TriangleAlert, Trash2, Undo2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { ErrorCard, FormDialog, FormGrid, MoneyText, SelectField, TextField, useConfirm } from '@/components';
import { Alert, Badge, Button, Separator, Sheet, SheetContent, SheetDescription, SheetTitle, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission, useSession } from '@/lib/auth';
import { formatDate, formatQty } from '@/lib/format';
import { zEnum, zOptionalRef, zOptionalText, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { FileField, localName, ReasonDialog, SaleStatusBadge } from '../shared';
import type { SaleDetail } from '../types';
import { printWaybill } from './printSale';

const PATH = '/sales/orders';
/** What a sale changes elsewhere, so those screens refetch after confirm or cancel. */
const AFFECTED = [PATH, '/sales/analysis', '/inventory', '/livestock', '/finance'];

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

const documentSchema = z.object({
  type: zEnum(DOCUMENT_TYPES),
  title: zText(200),
  number: zOptionalText(60),
  fileId: zOptionalRef(),
});

function AttachDialog({ saleId, open, onOpenChange }: { saleId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('sales');
  const attach = useApiMutation<z.output<typeof documentSchema>>({
    mutationFn: (values) => api.post(`${PATH}/${saleId}/documents`, values),
    invalidate: [PATH],
    silentError: true,
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('orders.attach')}
      schema={documentSchema}
      defaultValues={{ type: 'invoice', title: '', number: '', fileId: null }}
      onSubmit={(values) => attach.mutateAsync(values)}
      successMessage="common:toast.created"
    >
      {(form) => (
        <>
          <FormGrid>
            <SelectField form={form} name="type" label={t('orders.fields.documentType')} required options={enumOptions('documentType', DOCUMENT_TYPES)} />
            <TextField form={form} name="number" label={t('orders.fields.documentNumber')} />
          </FormGrid>
          <TextField form={form} name="title" label={t('orders.fields.documentTitle')} required />
          <FileField form={form} name="fileId" label={t('orders.fields.documentFile')} />
        </>
      )}
    </FormDialog>
  );
}

interface SaleSheetProps {
  id: string;
  onClose: () => void;
  onEdit: (sale: SaleDetail) => void;
}

export function SaleSheet({ id, onClose, onEdit }: SaleSheetProps) {
  const { t } = useTranslation('sales');
  const session = useSession();
  const confirm = useConfirm();
  const canApprove = usePermission('sales.approve');
  const canUpdate = usePermission('sales.update');
  const canDelete = usePermission('sales.delete');
  const canSeeMoney = usePermission('finance.view');
  const { data: sale, isLoading, error, refetch } = useDetail<SaleDetail>(`${PATH}/${id}`);

  const [dialog, setDialog] = useState<'reject' | 'cancel' | 'attach' | null>(null);

  const confirmSale = useApiMutation<void, SaleDetail>({
    mutationFn: () => api.post(`${PATH}/${id}/confirm`),
    invalidate: AFFECTED,
    // A large sale only moves to pending here, so the message follows what really happened.
    onSuccess: (saved) => toast.success(t(saved.status === 'pending' ? 'orders.submitted' : 'orders.confirmed')),
  });
  const remove = useApiMutation({
    mutationFn: () => api.delete(`${PATH}/${id}`),
    invalidate: [PATH],
    successMessage: 'common:toast.deleted',
    onSuccess: onClose,
  });
  const reject = useApiMutation<string>({
    mutationFn: (reason) => api.post(`${PATH}/${id}/reject`, { reason }),
    invalidate: [PATH],
    silentError: true,
  });
  const cancel = useApiMutation<string>({
    mutationFn: (reason) => api.post(`${PATH}/${id}/cancel`, { reason }),
    invalidate: AFFECTED,
    silentError: true,
  });

  const isOwn = sale?.createdBy === session.user.id;
  const open = sale && (sale.status === 'draft' || sale.status === 'pending');
  const hasWithdrawal = sale?.lines.some((l) => l.withdrawalUntil);
  const totalCost = sale?.lines.reduce((sum, l) => sum + (l.costAmount ?? 0), 0) ?? 0;

  const onConfirm = async () => {
    const ok = await confirm({ title: t('orders.confirmTitle'), description: t('orders.confirmBody'), confirmLabel: t('orders.confirm') });
    if (ok) confirmSale.mutate();
  };

  const onDelete = async () => {
    const ok = await confirm({ title: t('orders.deleteTitle'), destructive: true });
    if (ok) remove.mutate();
  };

  return (
    <Sheet open onOpenChange={(next) => !next && onClose()}>
      <SheetContent className="w-full max-w-full overflow-y-auto sm:w-[40rem]">
        <div className="flex flex-col gap-4 p-4 pt-14 sm:p-6 sm:pt-6">
          <div className="pr-10">
            <SheetTitle className="text-lg font-semibold">{sale?.number ?? t('orders.loading')}</SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">{sale?.counterpartyName ?? ''}</SheetDescription>
          </div>

          {isLoading && <Skeleton className="h-48 w-full" />}
          {error && <ErrorCard error={error} onRetry={() => void refetch()} />}

          {sale && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <SaleStatusBadge status={sale.status} />
                <Badge variant="outline">{t(`enums:paymentMethod.${sale.paymentMethod}`)}</Badge>
              </div>

              {sale.status === 'pending' && <Alert tone="warning">{t('orders.pendingHint')}</Alert>}
              {sale.rejectedReason && (
                <Alert tone="warning" title={t('orders.rejectedTitle')}>
                  {sale.rejectedReason}
                </Alert>
              )}
              {sale.cancelReason && (
                <Alert tone="info" title={t('orders.cancelledTitle')}>
                  {sale.cancelReason}
                </Alert>
              )}
              {open && hasWithdrawal && <Alert tone="danger">{t('orders.withdrawalHint')}</Alert>}

              <dl>
                <Row label={t('orders.fields.date')}>{formatDate(sale.date)}</Row>
                {sale.deliveryDate && <Row label={t('orders.fields.deliveryDate')}>{formatDate(sale.deliveryDate)}</Row>}
                {sale.dueDate && <Row label={t('orders.fields.dueDate')}>{formatDate(sale.dueDate)}</Row>}
                {sale.notes && <Row label={t('orders.fields.notes')}>{sale.notes}</Row>}
              </dl>

              <Separator />

              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">{t('orders.fields.lines')}</p>
                {sale.lines.map((l) => (
                  <div key={l.id} className="rounded-lg border border-border p-3 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">{l.animalTag ?? l.itemName ?? l.description}</p>
                        <p className="text-muted-foreground">
                          {l.animalCategory ? t(`enums:animalCategory.${l.animalCategory}`) : l.warehouseName}
                          {l.categoryName ? ` · ${localName(l.categoryName)}` : ''}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-medium">
                          <MoneyText value={l.amount} currency={sale.currency} />
                        </p>
                        <p className="text-muted-foreground tabular-nums">
                          {formatQty(l.qty, t(`enums:unit.${l.unit}`))}
                          {canSeeMoney && (
                            <>
                              {' × '}
                              <MoneyText value={l.price} currency={sale.currency} />
                            </>
                          )}
                        </p>
                      </div>
                    </div>
                    {open && l.withdrawalUntil && (
                      <p className="mt-2 flex items-center gap-1.5 text-danger">
                        <TriangleAlert className="size-4 shrink-0" aria-hidden />
                        {t('orders.withdrawalUntil', { date: formatDate(l.withdrawalUntil) })}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              <dl>
                <Row label={t('orders.fields.total')}>
                  <MoneyText value={sale.totalAmount} currency={sale.currency} />
                </Row>
                {canSeeMoney && sale.status === 'confirmed' && (
                  <>
                    <Row label={t('orders.fields.cost')}>
                      <MoneyText value={totalCost} />
                    </Row>
                    <Row label={t('orders.fields.margin')}>
                      <MoneyText value={(sale.totalAmount ?? 0) - totalCost} signed />
                    </Row>
                  </>
                )}
              </dl>

              {sale.postings.length > 0 && (
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">{t('orders.postings')}</p>
                  {sale.postings.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-muted-foreground">
                        {formatDate(p.date)} · {t(`enums:transactionStatus.${p.status}`)}
                      </span>
                      <MoneyText value={p.amountBase} />
                    </div>
                  ))}
                </div>
              )}

              {sale.documents.length > 0 && (
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">{t('orders.documents')}</p>
                  {sale.documents.map((d) => (
                    <p key={d.id} className="flex items-center gap-1.5 text-sm">
                      <FileText className="size-4 text-muted-foreground" aria-hidden />
                      {t(`enums:documentType.${d.type}`)}: {d.title}
                      {d.number ? ` №${d.number}` : ''}
                    </p>
                  ))}
                </div>
              )}

              <Separator />

              <div className="flex flex-wrap gap-2">
                {open && (canUpdate || canApprove) && (sale.status === 'draft' || !isOwn) && (
                  <Button onClick={() => void onConfirm()} loading={confirmSale.isPending}>
                    <CheckCircle2 aria-hidden />
                    {t(sale.status === 'pending' ? 'orders.approve' : 'orders.confirm')}
                  </Button>
                )}
                {sale.status === 'pending' && canApprove && !isOwn && (
                  <Button variant="outline" onClick={() => setDialog('reject')}>
                    <Undo2 aria-hidden />
                    {t('orders.reject')}
                  </Button>
                )}
                {open && canUpdate && (
                  <Button variant="outline" onClick={() => onEdit(sale)}>
                    <Pencil aria-hidden />
                    {t('common:actions.edit')}
                  </Button>
                )}
                {sale.status !== 'cancelled' && (
                  <Button variant="outline" onClick={() => printWaybill(sale, session.farm?.name ?? '')}>
                    <Printer aria-hidden />
                    {t('orders.print')}
                  </Button>
                )}
                {canUpdate && sale.status !== 'cancelled' && (
                  <Button variant="outline" onClick={() => setDialog('attach')}>
                    <Paperclip aria-hidden />
                    {t('orders.attach')}
                  </Button>
                )}
                {sale.status === 'draft' && (canDelete || canUpdate) && (
                  <Button variant="ghost" onClick={() => void onDelete()}>
                    <Trash2 aria-hidden />
                    {t('common:actions.delete')}
                  </Button>
                )}
                {(sale.status === 'confirmed' ? canApprove : open && canUpdate) && (
                  <Button variant="destructive" onClick={() => setDialog('cancel')}>
                    <Ban aria-hidden />
                    {t('orders.cancel')}
                  </Button>
                )}
              </div>

              <AttachDialog saleId={id} open={dialog === 'attach'} onOpenChange={(next) => setDialog(next ? 'attach' : null)} />
              <ReasonDialog
                open={dialog === 'reject'}
                onOpenChange={(next) => setDialog(next ? 'reject' : null)}
                title={t('orders.rejectTitle')}
                submitLabel={t('orders.reject')}
                onSubmit={(reason) => reject.mutateAsync(reason)}
              />
              <ReasonDialog
                open={dialog === 'cancel'}
                onOpenChange={(next) => setDialog(next ? 'cancel' : null)}
                title={t('orders.cancelTitle')}
                description={sale.status === 'confirmed' ? t('orders.cancelConfirmedBody') : undefined}
                submitLabel={t('orders.cancel')}
                onSubmit={(reason) => cancel.mutateAsync(reason)}
              />
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
