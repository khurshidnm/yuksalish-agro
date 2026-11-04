import { useTranslation } from 'react-i18next';
import { PageHeader, UrlTabs } from '@/components';
import { DevicesTab } from './DevicesTab';
import { EventsTab } from './EventsTab';
import { LiveTab } from './LiveTab';
import { PlanTab } from './PlanTab';

export default function CamerasPage() {
  const { t } = useTranslation('cameras');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <UrlTabs
        tabs={[
          { value: 'live', label: t('tabs.live'), content: <LiveTab /> },
          { value: 'events', label: t('tabs.events'), content: <EventsTab /> },
          { value: 'devices', label: t('tabs.devices'), content: <DevicesTab /> },
          { value: 'plan', label: t('tabs.plan'), content: <PlanTab /> },
        ]}
      />
    </>
  );
}
