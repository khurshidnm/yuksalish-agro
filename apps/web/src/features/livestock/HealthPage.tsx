import { HeartPulse } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader, UrlTabs, useUrlParam } from '@/components';
import { Button } from '@/components/ui';
import { usePermission } from '@/lib/auth';
import { DocumentsTab } from './vet/DocumentsTab';
import { JournalTab } from './vet/JournalTab';
import { QuarantineTab } from './vet/QuarantineTab';
import { ReportSickDialog } from './vet/ReportSickDialog';
import { SickTab } from './vet/SickTab';
import { TodayPanel } from './vet/TodayPanel';
import { VaccinationsTab } from './vet/VaccinationsTab';
import { WithdrawalTab } from './vet/WithdrawalTab';

export default function HealthPage() {
  const { t } = useTranslation('vet');
  const canReport = usePermission('health.create');
  const [reporting, setReporting] = useState(false);
  const [tab] = useUrlParam('tab');
  const tabs = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  // A tile above links to a tab. On a phone the tabs sit below the fold, so the tap seemed to do
  // nothing: bring them up. A tab bar already in view is left where it is.
  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      return;
    }
    const box = tabs.current?.getBoundingClientRect();
    if (box && box.top > window.innerHeight * 0.6) tabs.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [tab]);

  return (
    <>
      <PageHeader
        title={t('health.title')}
        description={t('health.description')}
        actions={
          canReport && (
            <Button variant="destructive" onClick={() => setReporting(true)}>
              <HeartPulse aria-hidden />
              {t('sick.report')}
            </Button>
          )
        }
      />
      <TodayPanel />
      <div ref={tabs} className="scroll-mt-4">
        <UrlTabs
          tabs={[
            { value: 'sick', label: t('health.tabs.sick'), content: <SickTab /> },
            { value: 'vaccinations', label: t('health.tabs.vaccinations'), content: <VaccinationsTab /> },
            { value: 'journal', label: t('health.tabs.journal'), content: <JournalTab /> },
            { value: 'quarantine', label: t('health.tabs.quarantine'), content: <QuarantineTab /> },
            { value: 'withdrawal', label: t('health.tabs.withdrawal'), content: <WithdrawalTab /> },
            { value: 'documents', label: t('health.tabs.documents'), content: <DocumentsTab /> },
          ]}
        />
      </div>
      <ReportSickDialog open={reporting} onOpenChange={setReporting} />
    </>
  );
}
