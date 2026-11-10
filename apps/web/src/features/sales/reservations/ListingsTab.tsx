import { EyeOff, Megaphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTable, MoneyText } from '@/components';
import { Alert } from '@/components/ui';
import { StatusBadge } from '@/features/livestock/shared';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatQty } from '@/lib/format';
import { useApiMutation, useDetail } from '@/lib/query';
import { type Listing, LISTINGS, SALE_HOLD_PATHS } from './types';

interface CatalogueSetting {
  catalogue: { enabled: boolean; slug: string | null };
}

/** Says whether visitors can open the page at all: a listing on a page that is off reaches nobody. */
function PageState() {
  const { t } = useTranslation('settings');
  const query = useDetail<CatalogueSetting>('/settings/policy');
  const catalogue = query.data?.catalogue;
  if (!catalogue) return null;
  if (!catalogue.enabled || !catalogue.slug) {
    return (
      <Alert tone="warning">
        {t('salesTab.linkOff')}{' '}
        <Link to="/settings?tab=sales" className="font-medium underline underline-offset-2">
          {t('livestock:saleReadiness.openSettings')}
        </Link>
      </Alert>
    );
  }
  const address = `${window.location.origin}/catalogue/${catalogue.slug}`;
  return (
    <Alert tone="info">
      {t('salesTab.link')}{' '}
      <a href={address} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center font-medium break-all underline underline-offset-2">
        {address}
      </a>
    </Alert>
  );
}

/** The animals the farm chose to show on its public page. */
export function ListingsTab() {
  const { t } = useTranslation('sales');
  const canChange = usePermission('sales.update');
  const seesMoney = usePermission('finance.view');
  const seesSettings = usePermission('settings.view');

  const remove = useApiMutation<string>({
    mutationFn: (animalId) => api.delete(`${LISTINGS}/${animalId}`),
    invalidate: SALE_HOLD_PATHS,
    successMessage: 'sales:catalogue.unlisted',
  });

  const columns: Column<Listing>[] = [
    { key: 'animal', header: t('catalogue.fields.animal'), cell: (row) => row.animalTag, mobile: 'title' },
    { key: 'status', header: t('catalogue.fields.status'), cell: (row) => <StatusBadge status={row.animalStatus} />, mobile: 'subtitle' },
    { key: 'herd', header: t('catalogue.fields.herd'), cell: (row) => row.herdName ?? '—' },
    { key: 'weight', header: t('catalogue.fields.weight'), cell: (row) => formatQty(row.currentWeightKg, t('enums:unit.kg'), 1), align: 'right' },
    ...(seesMoney
      ? [
          {
            key: 'price',
            header: t('catalogue.fields.price'),
            cell: (row: Listing) => (row.price === null ? <span className="text-muted-foreground">{t('catalogue.noPrice')}</span> : <MoneyText value={row.price} />),
            align: 'right' as const,
          },
        ]
      : []),
    { key: 'createdAt', header: t('catalogue.fields.added'), cell: (row) => formatDate(row.createdAt), mobile: 'hidden' },
  ];

  return (
    <div className="flex flex-col gap-3">
      {seesSettings && <PageState />}
      <DataTable<Listing>
        path={LISTINGS}
        urlPrefix="cat"
        columns={columns}
        searchPlaceholder={t('livestock:saleReadiness.searchPlaceholder')}
        rowHref={(row) => `/livestock/animals/${row.animalId}`}
        empty={{ icon: Megaphone, title: t('catalogue.emptyTitle'), description: t('catalogue.emptyBody') }}
        rowActions={(row) => [{ label: t('catalogue.remove'), icon: EyeOff, hidden: !canChange, onClick: () => remove.mutate(row.animalId) }]}
      />
    </div>
  );
}
