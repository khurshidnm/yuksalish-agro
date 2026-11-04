import { useTranslation } from 'react-i18next';
import { PageHeader, UrlTabs } from '@/components';
import { CalendarTab } from './vet/CalendarTab';
import { KpisTab } from './vet/KpisTab';
import { LambingTab } from './vet/LambingTab';
import { PedigreeTab } from './vet/PedigreeTab';
import { PregnanciesTab } from './vet/PregnanciesTab';
import { RamsTab } from './vet/RamsTab';

export default function BreedingPage() {
  const { t } = useTranslation('vet');
  return (
    <>
      <PageHeader title={t('breeding.title')} description={t('breeding.description')} />
      <UrlTabs
        tabs={[
          { value: 'pregnancies', label: t('breeding.tabs.pregnancies'), content: <PregnanciesTab /> },
          { value: 'calendar', label: t('breeding.tabs.calendar'), content: <CalendarTab /> },
          { value: 'lambing', label: t('breeding.tabs.lambing'), content: <LambingTab /> },
          { value: 'kpis', label: t('breeding.tabs.kpis'), content: <KpisTab /> },
          { value: 'rams', label: t('breeding.tabs.rams'), content: <RamsTab /> },
          { value: 'pedigree', label: t('breeding.tabs.pedigree'), content: <PedigreeTab /> },
        ]}
      />
    </>
  );
}
