import { BookmarkPlus } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ErrorCard } from '@/components';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Label, NumberInput, Separator, Skeleton, Switch } from '@/components/ui';
import { api } from '@/lib/api';
import { useModuleEnabled, usePermission } from '@/lib/auth';
import { currencyLabel, formatDate } from '@/lib/format';
import { useApiMutation, useList } from '@/lib/query';
import { ReserveDialog } from './ReserveDialog';
import { type Listing, LISTINGS, type Reservation, RESERVATIONS, SALE_HOLD_PATHS } from './types';

export interface AnimalSaleCardProps {
  animalId: string;
  tag: string;
  /** Still on the farm: only then can it be held or offered. */
  onFarm: boolean;
}

/** On the animal's own card: who it is held for, and whether the public page shows it. */
export function AnimalSaleCard(props: AnimalSaleCardProps) {
  const seesSales = usePermission('sales.view');
  if (!seesSales) return null;
  return <WhenSalesOn {...props} />;
}

/** A farm that switched sales off has no holds and no public page. */
function WhenSalesOn(props: AnimalSaleCardProps) {
  const moduleOn = useModuleEnabled()('sales');
  if (!moduleOn) return null;
  return <SaleCard {...props} />;
}

function SaleCard({ animalId, tag, onFarm }: AnimalSaleCardProps) {
  const { t } = useTranslation('sales');
  const canReserve = usePermission('sales.create');
  const canList = usePermission('sales.update');
  const seesMoney = usePermission('finance.view');
  const switchId = useId();
  const priceId = useId();

  const held = useList<Reservation>(RESERVATIONS, { animalId, status: 'open', pageSize: 1 });
  const shown = useList<Listing>(LISTINGS, { animalId, pageSize: 1 });
  const reservation = held.data?.data[0] ?? null;
  const listing = shown.data?.data[0] ?? null;

  const [reserving, setReserving] = useState(false);
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => setPrice(listing?.price ?? null), [listing?.price]);

  const list = useApiMutation<{ price?: number | null }>({
    mutationFn: (body) => api.put(`${LISTINGS}/${animalId}`, body),
    invalidate: SALE_HOLD_PATHS,
    onSuccess: (_listing, body) => toast.success(t('price' in body ? 'common:toast.saved' : 'catalogue.listed')),
  });
  const unlist = useApiMutation({
    mutationFn: () => api.delete(`${LISTINGS}/${animalId}`),
    invalidate: SALE_HOLD_PATHS,
    successMessage: 'sales:catalogue.unlisted',
  });

  const error = held.error ?? shown.error;
  const loading = held.isLoading || shown.isLoading;
  // An animal that has left and is neither held nor shown has nothing to say here.
  if (!onFarm && !loading && !error && !reservation && !listing) return null;

  const buyer = reservation ? (reservation.counterpartyName ?? reservation.customerName) : null;
  const busy = list.isPending || unlist.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('catalogue.cardTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <ErrorCard
            error={error}
            onRetry={() => {
              void held.refetch();
              void shown.refetch();
            }}
          />
        ) : loading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              {reservation ? (
                <Link to="/sales/reservations" className="focus-ring inline-flex min-h-11 items-center rounded text-sm font-medium underline underline-offset-2">
                  {buyer
                    ? t('catalogue.reservedFor', { name: buyer, date: formatDate(reservation.reservedUntil) })
                    : t('catalogue.reservedUntil', { date: formatDate(reservation.reservedUntil) })}
                </Link>
              ) : (
                <p className="text-sm text-muted-foreground">{t('catalogue.notReserved')}</p>
              )}
              {!reservation && onFarm && canReserve && (
                <Button variant="outline" onClick={() => setReserving(true)}>
                  <BookmarkPlus aria-hidden />
                  {t('livestock:saleReadiness.reserve')}
                </Button>
              )}
            </div>
            {reservation?.withdrawalUntil && <Alert tone="warning">{t('reservations.withdrawalNote', { date: formatDate(reservation.withdrawalUntil) })}</Alert>}

            {(onFarm || listing) && (
              <>
                <Separator />
                <div className="flex flex-col gap-1.5">
                  <div className="flex min-h-11 items-center justify-between gap-3">
                    <Label htmlFor={switchId}>{t('catalogue.show')}</Label>
                    <Switch
                      id={switchId}
                      checked={listing !== null}
                      disabled={!canList || busy}
                      onCheckedChange={(on) => (on ? list.mutate({}) : unlist.mutate())}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">{t('catalogue.showHint')}</p>
                </div>
                {listing && seesMoney && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={priceId}>{t('catalogue.price')}</Label>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                      <div className="min-w-0 flex-1">
                        <NumberInput id={priceId} money value={price} onChange={setPrice} suffix={currencyLabel()} disabled={!canList} />
                      </div>
                      {canList && (
                        <Button variant="outline" loading={list.isPending} disabled={price === listing.price || (price !== null && price <= 0)} onClick={() => list.mutate({ price })}>
                          {t('catalogue.savePrice')}
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{t('catalogue.priceHint')}</p>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </CardContent>
      <ReserveDialog open={reserving} onOpenChange={setReserving} animal={{ id: animalId, tag }} />
    </Card>
  );
}
