import { useTranslation } from 'react-i18next';
import { PageHeader, UrlTabs } from '@/components';
import { RequestsTab } from './purchases/RequestsTab';
import { SupplierPricesTab } from './purchases/SupplierPricesTab';

export default function PurchasesPage() {
  const { t } = useTranslation('sales');
  return (
    <>
      <PageHeader title={t('purchases.title')} description={t('purchases.description')} />
      <UrlTabs
        tabs={[
          { value: 'requests', label: t('tabs.requests'), content: <RequestsTab /> },
          { value: 'suppliers', label: t('tabs.suppliers'), content: <SupplierPricesTab /> },
        ]}
      />
    </>
  );
}
