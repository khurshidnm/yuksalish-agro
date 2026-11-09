import { CASH_HANDOVER_SOURCES, CURRENCIES, todayIso } from '@yap/shared';
import { ArrowDownLeft, ArrowUpRight, HandCoins, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  ComboboxField,
  DateField,
  EmptyState,
  ErrorCard,
  FormDialog,
  FormGrid,
  MoneyText,
  NumberField,
  PageHeader,
  SelectField,
  StatCard,
  TextareaField,
  TextField,
  useConfirm,
} from '@/components';
import {
  Badge,
  type BadgeVariant,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DateInput,
  Label,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Skeleton,
} from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission, useSession } from '@/lib/auth';
import { formatDate, formatMoney } from '@/lib/format';
import { zDate, zEnum, zOptionalNumber, zOptionalRef, zOptionalText, zPositive, zRef, zText } from '@/lib/forms';
import i18n, { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { FINANCE_PATHS, MONEY_QUERIES, accountLabel, useCenterName, useLocalName } from './lib';
import type { AccountOption, CapitalTiles, CashHandover, CashHolder, CashHolderSummary } from './types';

const HOLDERS = FINANCE_PATHS.cashHolders;
const HANDOVERS = FINANCE_PATHS.cashHandovers;

interface EmployeeLookup {
  id: string;
  name: string;
  position: string;
  userId: string | null;
}

const STATUS_VARIANT: Record<CashHandover['status'], BadgeVariant> = {
  sent: 'warning',
  accepted: 'success',
  disputed: 'danger',
  cancelled: 'neutral',
  reversed: 'neutral',
};

const required = (ctx: z.RefinementCtx, path: string) =>
  ctx.addIssue({ code: 'custom', path: [path], message: i18n.t('common:validation.required') });

const handoverSchema = z
  .object({
    employeeId: zRef(),
    source: zEnum(CASH_HANDOVER_SOURCES),
    fromAccountId: zOptionalRef(),
    amount: zPositive(),
    currency: zEnum(CURRENCIES),
    fxRate: zOptionalNumber(),
    date: zDate(),
    note: zOptionalText(500),
  })
  // Run even while the amount is still missing, so one press of Save names every empty field.
  .superRefine((v, ctx) => {
    if (v.source === 'account' && !v.fromAccountId) required(ctx, 'fromAccountId');
  }, { when: () => true });

const returnSchema = z
  .object({
    to: zEnum(['owner', 'account'] as const),
    toAccountId: zOptionalRef(),
    amount: zPositive(),
    date: zDate(),
    note: zOptionalText(500),
  })
  .superRefine((v, ctx) => {
    if (v.to === 'account' && !v.toAccountId) required(ctx, 'toAccountId');
  }, { when: () => true });

const reasonSchema = z.object({ reason: zText(500) });

/** "Your cash", the person's name, or a plain description when names are not for this reader. */
function useHolderName() {
  const { t } = useTranslation('finance');
  return (holder: { name: string | null; isMe: boolean }) =>
    holder.isMe ? t('cashHolders.yourCash') : (holder.name ?? t('cashHolders.someonesCash'));
}

// ─── Hand over ──────────────────────────────────────────────────────────────

function HandoverDialog({ open, onClose, employeeId }: { open: boolean; onClose: () => void; employeeId?: string }) {
  const { t } = useTranslation('finance');
  const session = useSession();
  const base = (session.tenant?.currency ?? 'UZS') as (typeof CURRENCIES)[number];
  const canOwn = usePermission('finance.capital');
  const canAccount = usePermission('finance.create');
  const accounts = useDetail<AccountOption[]>(open ? '/finance/accounts/lookup' : null).data ?? [];
  const me = session.user?.id;

  const sources = CASH_HANDOVER_SOURCES.filter((s) => (s === 'own_funds' ? canOwn : canAccount));
  const send = useApiMutation<z.output<typeof handoverSchema>>({
    mutationFn: (values) => {
      const own = values.source === 'own_funds';
      return api.postOnce(HANDOVERS, {
        ...values,
        currency: own ? values.currency : undefined,
        fxRate: own && values.currency !== base ? values.fxRate : null,
        fromAccountId: own ? null : values.fromAccountId,
      });
    },
    invalidate: MONEY_QUERIES,
    silentError: true,
  });

  // Only someone with a login can say the cash reached them, and handing cash to yourself is not a handover.
  const people = async (search: string) => {
    const { data } = await api.list<EmployeeLookup>('/hr/employees/lookup', { search, pageSize: 30 });
    return data.filter((p) => p.userId && p.userId !== me).map((p) => ({ value: p.id, label: p.name, hint: p.position }));
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t('cashHolders.form.title')}
      description={t('cashHolders.form.description')}
      schema={handoverSchema}
      defaultValues={{
        employeeId: employeeId ?? '',
        source: sources[0] ?? 'account',
        fromAccountId: null,
        amount: undefined as unknown as number,
        currency: base,
        fxRate: null,
        date: todayIso(),
        note: null,
      }}
      onSubmit={(values) => send.mutateAsync(values)}
      submitLabel={t('cashHolders.form.submit')}
      successMessage="finance:cashHolders.toast.sent"
    >
      {(form) => {
        const source = form.watch('source');
        const currency = form.watch('currency');
        const fromId = form.watch('fromAccountId');
        const from = accounts.find((a) => a.id === fromId);
        return (
          <>
            <ComboboxField form={form} name="employeeId" label={t('cashHolders.form.person')} required loadOptions={people} placeholder={t('cashHolders.form.choosePerson')} />
            {sources.length > 1 && (
              <SelectField
                form={form}
                name="source"
                label={t('cashHolders.form.source')}
                required
                options={sources.map((s) => ({ value: s, label: t(`enums:cashHandoverSource.${s}`) }))}
              />
            )}
            {source === 'account' && (
              <SelectField
                form={form}
                name="fromAccountId"
                label={t('cashHolders.form.fromAccount')}
                required
                options={accounts.filter((a) => !a.holder || a.holder.isMe).map((a) => ({ value: a.id, label: `${accountLabel(a)} (${a.currency})` }))}
                placeholder={t('journal.chooseAccount')}
              />
            )}
            <div className="grid grid-cols-[1fr_6rem] gap-2">
              <NumberField money form={form} name="amount" label={t('cashHolders.form.amount')} required />
              {source === 'own_funds' ? (
                <SelectField form={form} name="currency" label={t('journal.fields.currency')} options={enumOptions('currency', CURRENCIES)} />
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Label>{t('journal.fields.currency')}</Label>
                  <p className="flex min-h-11 items-center text-sm text-muted-foreground">{from?.currency ?? base}</p>
                </div>
              )}
            </div>
            {source === 'own_funds' && currency !== base && (
              <NumberField money form={form} name="fxRate" label={t('journal.fields.fxRate')} hint={t('journal.fxHint')} maxDigits={4} />
            )}
            <DateField form={form} name="date" label={t('cashHolders.form.date')} required />
            <TextField form={form} name="note" label={t('cashHolders.form.note')} />
          </>
        );
      }}
    </FormDialog>
  );
}

// ─── Take back ──────────────────────────────────────────────────────────────

function ReturnDialog({ holder, onClose }: { holder: CashHolder | null; onClose: () => void }) {
  const { t } = useTranslation('finance');
  const canOwn = usePermission('finance.capital');
  const holderName = useHolderName();
  const accounts = useDetail<AccountOption[]>(holder ? '/finance/accounts/lookup' : null).data ?? [];
  const back = useApiMutation<z.output<typeof returnSchema>>({
    mutationFn: (values) => api.postOnce(`${HOLDERS}/${holder?.id}/return`, { ...values, toAccountId: values.to === 'account' ? values.toAccountId : null }),
    invalidate: MONEY_QUERIES,
    silentError: true,
  });
  const targets = accounts.filter((a) => a.id !== holder?.accountId && a.currency === holder?.currency && (!a.holder || a.holder.isMe));

  return (
    <FormDialog
      open={holder !== null}
      onOpenChange={(next) => !next && onClose()}
      // The holder gives his own cash back; whoever handed it out takes it back.
      title={t(holder?.isMe ? 'cashHolders.return.titleMine' : 'cashHolders.return.title')}
      description={holder ? t('cashHolders.return.description', { name: holderName(holder), amount: formatMoney(holder.expectedCash, { currency: holder.currency }) }) : undefined}
      schema={returnSchema}
      defaultValues={{ to: canOwn ? 'owner' : 'account', toAccountId: null, amount: undefined as unknown as number, date: todayIso(), note: null }}
      onSubmit={(values) => back.mutateAsync(values)}
      submitLabel={t(holder?.isMe ? 'cashHolders.return.submitMine' : 'cashHolders.return.submit')}
      successMessage="finance:cashHolders.toast.returned"
    >
      {(form) => (
        <>
          {canOwn && (
            <SelectField
              form={form}
              name="to"
              label={t('cashHolders.return.to')}
              required
              options={[
                { value: 'owner', label: t('cashHolders.return.toOwner') },
                { value: 'account', label: t('cashHolders.return.toAccount') },
              ]}
            />
          )}
          {form.watch('to') === 'account' && (
            <SelectField
              form={form}
              name="toAccountId"
              label={t('cashHolders.return.account')}
              required
              options={targets.map((a) => ({ value: a.id, label: accountLabel(a) }))}
              placeholder={t('journal.chooseAccount')}
            />
          )}
          <FormGrid>
            <NumberField money form={form} name="amount" label={t('cashHolders.form.amount')} required />
            <DateField form={form} name="date" label={t('cashHolders.form.date')} required />
          </FormGrid>
          <TextField form={form} name="note" label={t('cashHolders.form.note')} />
        </>
      )}
    </FormDialog>
  );
}

// ─── One person ─────────────────────────────────────────────────────────────

function Line({ label, value, currency, strong }: { label: string; value: number; currency: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 text-sm ${strong ? 'font-semibold' : ''}`}>
      <span className={strong ? undefined : 'text-muted-foreground'}>{label}</span>
      <MoneyText value={value} currency={currency} className={value < 0 ? 'text-danger' : undefined} />
    </div>
  );
}

function HolderSheet({ holder, onClose, onReturn }: { holder: CashHolder | null; onClose: () => void; onReturn: (holder: CashHolder) => void }) {
  const { t } = useTranslation('finance');
  const localName = useLocalName();
  const centerName = useCenterName();
  const holderName = useHolderName();
  const confirm = useConfirm();
  const canClose = usePermission('finance.update');
  const canReturn = usePermission('finance.create');
  const [period, setPeriod] = useState<{ from?: string; to?: string }>({});
  const summary = useDetail<CashHolderSummary>(holder ? `${HOLDERS}/${holder.id}` : null, period);
  const close = useApiMutation<string>({
    mutationFn: (id) => api.post(`${HOLDERS}/${id}/close`),
    invalidate: MONEY_QUERIES,
    successMessage: 'finance:cashHolders.toast.closed',
    onSuccess: onClose,
  });
  const s = summary.data;
  const currency = holder?.currency ?? 'UZS';
  // Entries carry a center's stored name only; the summary by center knows its type, which says when
  // the name is the farm-wide center's English "General".
  const centerTypeOf = new Map((s?.byCostCenter ?? []).flatMap((row) => (row.name && row.type ? [[row.name, row.type] as const] : [])));

  return (
    <Sheet
      open={holder !== null}
      onOpenChange={(open) => {
        if (!open) {
          setPeriod({});
          onClose();
        }
      }}
    >
      <SheetContent className="w-full max-w-lg overflow-y-auto p-5">
        <SheetTitle className="text-lg font-semibold">{holder ? holderName(holder) : ''}</SheetTitle>
        <SheetDescription className="text-sm text-muted-foreground">{t('cashHolders.detail.description')}</SheetDescription>
        <div className="my-4 grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="ch-from">{t('journal.from')}</Label>
            <DateInput id="ch-from" value={period.from ?? s?.from ?? ''} onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value || undefined }))} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="ch-to">{t('journal.to')}</Label>
            <DateInput id="ch-to" value={period.to ?? s?.to ?? ''} onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value || undefined }))} />
          </div>
        </div>

        {summary.error ? (
          <ErrorCard error={summary.error} onRetry={() => void summary.refetch()} />
        ) : !s ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="flex flex-col gap-5">
            <section className="flex flex-col gap-2">
              <Line label={t('cashHolders.detail.opening')} value={s.opening} currency={currency} />
              <Line label={t('cashHolders.detail.received')} value={s.received} currency={currency} />
              <Line label={t('cashHolders.detail.spent')} value={-s.spent} currency={currency} />
              {s.returned > 0 && <Line label={t('cashHolders.detail.returned')} value={-s.returned} currency={currency} />}
              <div className="border-t border-border pt-2">
                <Line label={t('cashHolders.detail.closing')} value={s.closing} currency={currency} strong />
              </div>
            </section>

            <section className="flex flex-col gap-2 rounded-lg bg-muted p-3">
              <Line label={t('cashHolders.detail.counted')} value={s.balance} currency={currency} />
              {s.pending.count > 0 && (
                <p className="text-sm text-muted-foreground">{t('cashHolders.detail.pending', { n: s.pending.count })}</p>
              )}
              <Line label={t('cashHolders.detail.expected')} value={s.expectedCash} currency={currency} strong />
            </section>

            {s.byCategory.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">{t('cashHolders.detail.byCategory')}</h3>
                {s.byCategory.map((row) => (
                  // Spending here is an expense, which always has a category, or a debt paid, which has none.
                  <Line
                    key={row.categoryId ?? 'none'}
                    label={row.name ? localName(row.name) : t('enums:transactionType.debt_payment')}
                    value={row.amount}
                    currency={currency}
                  />
                ))}
              </section>
            )}
            {s.byCostCenter.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">{t('cashHolders.detail.byCostCenter')}</h3>
                {s.byCostCenter.map((row) => (
                  <Line key={row.costCenterId ?? 'none'} label={centerName(row.name, row.type)} value={row.amount} currency={currency} />
                ))}
              </section>
            )}

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t('cashHolders.detail.entries')}</h3>
              {s.entries.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">{t('cashHolders.detail.noEntries')}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {s.entries.map((entry) => (
                    <li key={entry.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="block truncate">
                          {entry.categoryName ? localName(entry.categoryName) : t(`enums:transactionType.${entry.type}`)}
                        </span>
                        <span className="line-clamp-2 block text-xs break-words text-muted-foreground">
                          {[
                            formatDate(entry.date),
                            entry.costCenterName && centerName(entry.costCenterName, entry.costCenterType ?? centerTypeOf.get(entry.costCenterName)),
                            entry.description,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <MoneyText value={entry.incoming ? entry.amount : -entry.amount} currency={currency} signed />
                        {entry.status === 'pending' && <Badge variant="warning">{t('enums:transactionStatus.pending')}</Badge>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              {canReturn && holder && s.expectedCash > 0 && (
                <Button variant="outline" onClick={() => onReturn(holder)}>
                  <Undo2 aria-hidden />
                  {t(holder.isMe ? 'cashHolders.card.giveBack' : 'cashHolders.card.takeBack')}
                </Button>
              )}
              {canClose && holder && s.expectedCash === 0 && s.handoversWaiting === 0 && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    const ok = await confirm({ title: t('cashHolders.detail.closeTitle'), description: t('cashHolders.detail.closeBody'), destructive: true });
                    if (ok) close.mutate(holder.id);
                  }}
                >
                  {t('cashHolders.detail.close')}
                </Button>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function HolderCard({
  holder,
  onDetails,
  onHandOver,
  onReturn,
}: {
  holder: CashHolder;
  onDetails: () => void;
  onHandOver?: () => void;
  onReturn?: () => void;
}) {
  const { t } = useTranslation('finance');
  const holderName = useHolderName();
  const money = (value: number) => formatMoney(value, { currency: holder.currency });
  const canGiveBack = Boolean(onReturn) && holder.expectedCash > 0;
  const actions = 1 + (onHandOver ? 1 : 0) + (canGiveBack ? 1 : 0);
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle className="truncate">{holderName(holder)}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('cashHolders.card.inHand')}</p>
        </div>
        <HandCoins className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div>
          <p className="text-2xl font-semibold">
            <MoneyText value={holder.expectedCash} currency={holder.currency} className={holder.expectedCash < 0 ? 'text-danger' : undefined} />
          </p>
          {holder.expectedCash !== holder.balance && (
            <p className="text-sm text-muted-foreground">{t('cashHolders.card.counted', { amount: money(holder.balance) })}</p>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="text-muted-foreground">{t('cashHolders.card.received')}</dt>
            <dd className="font-medium tabular-nums">{money(holder.week.received)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('cashHolders.card.spent')}</dt>
            <dd className="font-medium tabular-nums">{money(holder.week.spent)}</dd>
          </div>
        </dl>
        {(holder.pendingApproval > 0 || holder.handoversWaiting > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {holder.pendingApproval > 0 && <Badge variant="warning">{t('cashHolders.card.pendingApproval', { n: holder.pendingApproval })}</Badge>}
            {holder.handoversWaiting > 0 && <Badge variant="info">{t('cashHolders.card.handoversWaiting', { n: holder.handoversWaiting })}</Badge>}
          </div>
        )}
        {/* One grid of equal buttons, so a third action does not wrap alone under the first two. */}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" className={actions % 2 === 1 ? 'col-span-2' : undefined} onClick={onDetails}>
            {t('cashHolders.card.details')}
          </Button>
          {onHandOver && (
            <Button variant="outline" onClick={onHandOver}>
              <ArrowDownLeft aria-hidden />
              {t('cashHolders.card.handOver')}
            </Button>
          )}
          {canGiveBack && (
            <Button variant="outline" onClick={onReturn}>
              <ArrowUpRight aria-hidden />
              {t(holder.isMe ? 'cashHolders.card.giveBack' : 'cashHolders.card.takeBack')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Handovers ──────────────────────────────────────────────────────────────

type Asking = { handover: CashHandover; mode: 'dispute' | 'reverse' };

const DONE: Record<Asking['mode'], string> = {
  dispute: 'finance:cashHolders.actions.disputed',
  reverse: 'finance:cashHolders.toast.reversed',
};

function ReasonForm({ asking, onClose }: { asking: Asking | null; onClose: () => void }) {
  const { t } = useTranslation('finance');
  const act = useApiMutation<string>({
    mutationFn: (reason) => api.post(`${HANDOVERS}/${asking?.handover.id}/${asking?.mode}`, { reason }),
    invalidate: [...MONEY_QUERIES, '/notifications'],
    silentError: true,
  });
  return (
    <FormDialog
      open={asking !== null}
      onOpenChange={(next) => !next && onClose()}
      title={asking ? t(`cashHolders.handovers.${asking.mode}Title`) : ''}
      description={asking ? `${formatMoney(asking.handover.amount, { currency: asking.handover.currency })}, ${formatDate(asking.handover.date)}` : undefined}
      schema={reasonSchema}
      defaultValues={{ reason: '' }}
      onSubmit={(values) => act.mutateAsync(values.reason)}
      submitLabel={asking ? t(`cashHolders.handovers.${asking.mode}`) : undefined}
      cancelLabel={t('common:actions.close')}
      successMessage={asking ? DONE[asking.mode] : undefined}
    >
      {(form) => <TextareaField form={form} name="reason" label={t('approval.reason')} required />}
    </FormDialog>
  );
}

function Handovers() {
  const { t } = useTranslation('finance');
  const canApprove = usePermission('finance.approve');
  const handovers = useDetail<CashHandover[]>(HANDOVERS);
  const [asking, setAsking] = useState<Asking | null>(null);
  const answer = useApiMutation<{ id: string; action: 'accept' | 'cancel' }, { transactionStatus?: string }>({
    mutationFn: ({ id, action }) => api.post(`${HANDOVERS}/${id}/${action}`),
    invalidate: [...MONEY_QUERIES, '/notifications'],
    onSuccess: (result, { action }) => {
      if (action === 'cancel') toast.success(t('cashHolders.toast.cancelled'));
      else toast.success(t(result.transactionStatus === 'pending' ? 'cashHolders.actions.acceptedPending' : 'cashHolders.actions.accepted'));
    },
  });

  if (handovers.error) return <ErrorCard error={handovers.error} onRetry={() => void handovers.refetch()} />;
  const rows = handovers.data ?? [];

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{t('cashHolders.handovers.title')}</h2>
      {handovers.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('cashHolders.handovers.empty')}</p>
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {rows.map((row) => {
            const waiting = row.status === 'sent';
            const who = row.toMe
              ? t('cashHolders.handovers.toYou', { name: row.sentByName ?? t('cashHolders.handovers.someone') })
              : t('cashHolders.handovers.to', { name: row.holderName ?? t('cashHolders.someonesCash') });
            return (
              <div key={row.id} className="flex flex-col gap-2 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">
                      <MoneyText value={row.amount} currency={row.currency} />
                    </p>
                    <p className="truncate text-sm text-muted-foreground">{who}</p>
                    <p className="line-clamp-2 text-xs break-words text-muted-foreground">
                      {[formatDate(row.date), t(`enums:cashHandoverSource.${row.source}`), row.note].filter(Boolean).join(' · ')}
                    </p>
                    {row.disputeReason && <p className="text-sm text-danger">{row.disputeReason}</p>}
                    {row.reversedReason && <p className="text-sm text-muted-foreground">{row.reversedReason}</p>}
                  </div>
                  <Badge variant={STATUS_VARIANT[row.status]}>{t(`enums:cashHandoverStatus.${row.status}`)}</Badge>
                </div>
                {(waiting && (row.toMe || row.byMe)) || (row.status === 'accepted' && canApprove && !row.toMe) ? (
                  <div className="flex flex-wrap gap-2">
                    {waiting && row.toMe && (
                      <>
                        <Button loading={answer.isPending && answer.variables?.id === row.id} onClick={() => answer.mutate({ id: row.id, action: 'accept' })}>
                          {t('cashHolders.actions.accept')}
                        </Button>
                        <Button variant="outline" onClick={() => setAsking({ handover: row, mode: 'dispute' })}>
                          {t('cashHolders.actions.dispute')}
                        </Button>
                      </>
                    )}
                    {waiting && row.byMe && (
                      <Button variant="ghost" onClick={() => answer.mutate({ id: row.id, action: 'cancel' })}>
                        {t('cashHolders.handovers.cancel')}
                      </Button>
                    )}
                    {row.status === 'accepted' && canApprove && !row.toMe && (
                      <Button variant="ghost" onClick={() => setAsking({ handover: row, mode: 'reverse' })}>
                        {t('cashHolders.handovers.reverse')}
                      </Button>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </Card>
      )}
      <ReasonForm asking={asking} onClose={() => setAsking(null)} />
    </section>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function CashHoldersPage() {
  const { t } = useTranslation('finance');
  const canCreate = usePermission('finance.create');
  const canCapital = usePermission('finance.capital');
  const canSend = canCreate || canCapital;
  const canReturn = canCreate;
  const holders = useDetail<CashHolder[]>(HOLDERS);
  const tiles = useDetail<CapitalTiles>(FINANCE_PATHS.capital);
  const [sending, setSending] = useState<{ employeeId?: string } | null>(null);
  const [details, setDetails] = useState<CashHolder | null>(null);
  const [returning, setReturning] = useState<CashHolder | null>(null);

  const rows = useMemo(() => holders.data ?? [], [holders.data]);
  const waiting = rows.reduce((sum, row) => sum + row.handoversWaiting, 0);

  return (
    <>
      <PageHeader
        title={t('cashHolders.title')}
        description={t('cashHolders.description')}
        actions={
          canSend && (
            <Button onClick={() => setSending({})}>
              <HandCoins aria-hidden />
              {t('cashHolders.handOver')}
            </Button>
          )
        }
      />
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatCard label={t('cashHolders.stats.withPeople')} value={formatMoney(tiles.data?.cashWithPeople ?? null)} loading={tiles.isLoading} />
          <StatCard
            label={t('cashHolders.stats.invested')}
            hint={t('cashHolders.stats.investedHint')}
            value={formatMoney(tiles.data?.invested ?? null)}
            loading={tiles.isLoading}
          />
          <StatCard
            label={t('cashHolders.stats.waiting')}
            value={t('cashHolders.stats.waitingCount', { count: waiting })}
            hint={t('cashHolders.stats.waitingHint')}
            loading={holders.isLoading}
          />
        </div>

        {holders.error ? (
          <ErrorCard error={holders.error} onRetry={() => void holders.refetch()} />
        ) : holders.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : rows.length === 0 ? (
          <Card>
            <EmptyState
              icon={HandCoins}
              title={t('cashHolders.emptyTitle')}
              description={t('cashHolders.emptyBody')}
              action={
                canSend ? (
                  <Button onClick={() => setSending({})}>
                    <HandCoins aria-hidden />
                    {t('cashHolders.handOver')}
                  </Button>
                ) : undefined
              }
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((holder) => (
              <HolderCard
                key={holder.id}
                holder={holder}
                onDetails={() => setDetails(holder)}
                onHandOver={canSend && !holder.isMe ? () => setSending({ employeeId: holder.employeeId }) : undefined}
                onReturn={canReturn ? () => setReturning(holder) : undefined}
              />
            ))}
          </div>
        )}

        <Handovers />
      </div>

      <HandoverDialog open={sending !== null} employeeId={sending?.employeeId} onClose={() => setSending(null)} />
      <ReturnDialog holder={returning} onClose={() => setReturning(null)} />
      <HolderSheet
        holder={details}
        onClose={() => setDetails(null)}
        onReturn={(holder) => {
          setDetails(null);
          setReturning(holder);
        }}
      />
    </>
  );
}
