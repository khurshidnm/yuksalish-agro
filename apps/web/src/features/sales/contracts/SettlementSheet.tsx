import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorCard, MoneyText, StatCard } from '@/components';
import { Separator, Sheet, SheetContent, SheetDescription, SheetTitle, Skeleton } from '@/components/ui';
import { formatDate, formatQty } from '@/lib/format';
import { useDetail } from '@/lib/query';
import { localName, PurchaseStatusBadge, SaleStatusBadge } from '../shared';
import type { Settlement } from '../types';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

function Line({ left, right, hint }: { left: ReactNode; right: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border py-2 text-sm last:border-b-0">
      <div className="min-w-0">
        <p>{left}</p>
        {hint && <p className="text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0 text-right">{right}</div>
    </div>
  );
}

export function SettlementSheet({ counterpartyId, onClose }: { counterpartyId: string; onClose: () => void }) {
  const { t } = useTranslation('sales');
  const { data, isLoading, error, refetch } = useDetail<Settlement>(`/sales/counterparties/${counterpartyId}/settlement`);

  return (
    <Sheet open onOpenChange={(next) => !next && onClose()}>
      <SheetContent className="w-full max-w-full overflow-y-auto sm:w-[40rem]">
        <div className="flex flex-col gap-4 p-4 pt-14 sm:p-6 sm:pt-6">
          <div className="pr-10">
            <SheetTitle className="text-lg font-semibold">{data?.counterparty.name ?? t('settlement.title')}</SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">{t('settlement.description')}</SheetDescription>
          </div>

          {isLoading && <Skeleton className="h-48 w-full" />}
          {error && <ErrorCard error={error} onRetry={() => void refetch()} />}

          {data && (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <StatCard label={t('settlement.receivable')} value={<MoneyText value={data.totals.receivable} />} hint={t('settlement.receivableHint')} />
                <StatCard label={t('settlement.payable')} value={<MoneyText value={data.totals.payable} />} hint={t('settlement.payableHint')} />
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{t('settlement.sold')}</dt>
                <dd className="text-right"><MoneyText value={data.totals.sold} /></dd>
                <dt className="text-muted-foreground">{t('settlement.received')}</dt>
                <dd className="text-right"><MoneyText value={data.totals.received} /></dd>
                <dt className="text-muted-foreground">{t('settlement.bought')}</dt>
                <dd className="text-right"><MoneyText value={data.totals.bought} /></dd>
                <dt className="text-muted-foreground">{t('settlement.paid')}</dt>
                <dd className="text-right"><MoneyText value={data.totals.paid} /></dd>
              </dl>

              <Separator />

              {data.sales.length > 0 && (
                <Section title={t('settlement.sales')}>
                  {data.sales.map((s) => (
                    <Line
                      key={s.id}
                      left={s.number}
                      hint={formatDate(s.date)}
                      right={
                        <>
                          <MoneyText value={s.totalAmount} currency={s.currency} />
                          <div className="mt-1"><SaleStatusBadge status={s.status} /></div>
                        </>
                      }
                    />
                  ))}
                </Section>
              )}

              {data.purchases.length > 0 && (
                <Section title={t('settlement.purchases')}>
                  {data.purchases.map((p) => (
                    <Line
                      key={p.id}
                      left={p.itemName}
                      hint={formatQty(p.qty, t(`enums:unit.${p.unit}`))}
                      right={
                        <>
                          <MoneyText value={p.paidAmount} />
                          <div className="mt-1"><PurchaseStatusBadge status={p.status} /></div>
                        </>
                      }
                    />
                  ))}
                </Section>
              )}

              {data.contracts.length > 0 && (
                <Section title={t('settlement.contracts')}>
                  {data.contracts.map((c) => (
                    <Line
                      key={c.id}
                      left={`№${c.number}${c.title ? `, ${c.title}` : ''}`}
                      hint={c.endDate ? t('contracts.until', { date: formatDate(c.endDate) }) : undefined}
                      right={<MoneyText value={c.amount} />}
                    />
                  ))}
                </Section>
              )}

              <Section title={t('settlement.transactions')}>
                {data.transactions.length === 0 && <p className="text-sm text-muted-foreground">{t('settlement.noTransactions')}</p>}
                {data.transactions.map((p) => (
                  <Line
                    key={p.id}
                    left={p.categoryName ? localName(p.categoryName) : t(`enums:transactionType.${p.type}`)}
                    hint={`${formatDate(p.date)} · ${t(`enums:paymentMethod.${p.paymentMethod}`)} · ${t(`enums:transactionStatus.${p.status}`)}`}
                    right={<MoneyText value={p.amountBase} />}
                  />
                ))}
              </Section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
