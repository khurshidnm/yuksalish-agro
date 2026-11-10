import { useTranslation } from 'react-i18next';
import { PageHeader, UrlTabs } from '@/components';
import { CalendarTab } from './vet/CalendarTab';
import { ConditionTab } from './vet/ConditionTab';
import { CullingTab } from './vet/CullingTab';
import { DeskTab } from './vet/DeskTab';
import { KpisTab } from './vet/KpisTab';
import { LambingTab } from './vet/LambingTab';
import { PedigreeTab } from './vet/PedigreeTab';
import { PregnanciesTab } from './vet/PregnanciesTab';
import { RamsTab } from './vet/RamsTab';
import { ScanTab } from './vet/ScanTab';

export default function BreedingPage() {
  const { t } = useTranslation('vet');
  return (
    <>
      <PageHeader title={t('breeding.title')} description={t('breeding.description')} />
      <UrlTabs
        tabs={[
          { value: 'pregnancies', label: t('breeding.tabs.pregnancies'), content: <PregnanciesTab /> },
          { value: 'scan', label: t('breeding.tabs.scan'), content: <ScanTab /> },
          { value: 'calendar', label: t('breeding.tabs.calendar'), content: <CalendarTab /> },
          { value: 'lambing', label: t('breeding.tabs.lambing'), content: <LambingTab /> },
          { value: 'desk', label: t('breeding.tabs.desk'), content: <DeskTab /> },
          { value: 'kpis', label: t('breeding.tabs.kpis'), content: <KpisTab /> },
          { value: 'condition', label: t('breeding.tabs.condition'), content: <ConditionTab /> },
          { value: 'culling', label: t('breeding.tabs.culling'), content: <CullingTab /> },
          { value: 'rams', label: t('breeding.tabs.rams'), content: <RamsTab /> },
          { value: 'pedigree', label: t('breeding.tabs.pedigree'), content: <PedigreeTab /> },
        ]}
      />
    </>
  );
}
