import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components';
import { DocumentsPanel } from './DocumentsPanel';

export default function DocumentsPage() {
  const { t } = useTranslation('farm');
  return <DocumentsPanel defaultType="land" header={(add) => <PageHeader title={t('documents.title')} description={t('documents.description')} actions={add} />} />;
}
