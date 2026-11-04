import { Sprout } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from './EmptyState';
import { PageHeader } from './PageHeader';
import { Card } from './ui';

/** Placeholder for a section that a module has not built yet. */
export function StubPage({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t(titleKey)} />
      <Card>
        <EmptyState icon={Sprout} title={t('common:stub.title')} description={t('common:stub.body')} />
      </Card>
    </>
  );
}
