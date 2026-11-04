import { useTranslation } from 'react-i18next';
import { PageHeader, UrlTabs } from '@/components';
import { AnalysisTab } from './analysis/AnalysisTab';
import { ContractsTab } from './contracts/ContractsTab';
import { GrantsTab } from './grants/GrantsTab';
import { OrdersTab } from './orders/OrdersTab';
import { PricesTab } from './prices/PricesTab';

export default function SalesPage() {
  const { t } = useTranslation('sales');
  return (
    <>
      <PageHeader title={t('page.title')} description={t('page.description')} />
      <UrlTabs
        tabs={[
          { value: 'orders', label: t('tabs.orders'), content: <OrdersTab /> },
          { value: 'prices', label: t('tabs.prices'), content: <PricesTab /> },
          { value: 'analysis', label: t('tabs.analysis'), content: <AnalysisTab /> },
          { value: 'contracts', label: t('tabs.contracts'), content: <ContractsTab /> },
          { value: 'grants', label: t('tabs.grants'), content: <GrantsTab /> },
        ]}
      />
    </>
  );
}
