import { BookmarkPlus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader, UrlTabs } from '@/components';
import { Button } from '@/components/ui';
import { usePermission } from '@/lib/auth';
import { ListingsTab } from './reservations/ListingsTab';
import { RequestsTab } from './reservations/RequestsTab';
import { ReservationsTab } from './reservations/ReservationsTab';
import { ReserveDialog } from './reservations/ReserveDialog';

/** Animals held for buyers, pre-orders from the public page, and what that page shows. */
export default function ReservationsPage() {
  const { t } = useTranslation('sales');
  const canReserve = usePermission('sales.create');
  const [reserving, setReserving] = useState(false);

  return (
    <>
      <PageHeader
        title={t('reservations.title')}
        description={t('reservations.description')}
        actions={
          canReserve && (
            <Button onClick={() => setReserving(true)}>
              <BookmarkPlus aria-hidden />
              {t('reservations.add')}
            </Button>
          )
        }
      />
      <UrlTabs
        tabs={[
          { value: 'reservations', label: t('reservations.tabs.reservations'), content: <ReservationsTab /> },
          { value: 'requests', label: t('reservations.tabs.requests'), content: <RequestsTab /> },
          { value: 'catalogue', label: t('reservations.tabs.catalogue'), content: <ListingsTab /> },
        ]}
      />
      <ReserveDialog open={reserving} onOpenChange={setReserving} />
    </>
  );
}
