import { Download, Lock } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { useApiMutation } from '@/lib/query';
import { UploadButton } from './UploadButton';
import type { ImportCatalog, ImportJob, TemplateInfo } from './types';

function TemplateCard({ template, onUploaded }: { template: TemplateInfo; onUploaded: (job: ImportJob) => void }) {
  const { t, i18n } = useTranslation('import');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const prefix = `templates.${template.key}`;

  const download = useApiMutation<void>({
    mutationFn: () => api.download(`/import/templates/${template.key}`, undefined, { lang: i18n.language }),
  });

  return (
    <Card className={template.allowed ? undefined : 'opacity-70'}>
      <CardHeader>
        <CardTitle>{t(`${prefix}.title`)}</CardTitle>
        <CardDescription>{t(`${prefix}.description`)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{t('page.columns')}: </span>
          {template.columns.map((column) => t(`${prefix}.columns.${column.key}.label`)).join(', ')}
        </p>
        {template.allowed ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" loading={download.isPending} onClick={() => download.mutate()}>
              <Download aria-hidden />
              {t('page.download')}
            </Button>
            <UploadButton template={template.key} label={t('page.upload')} onUploaded={onUploaded} onError={setUploadError} />
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Lock className="size-4 shrink-0" aria-hidden />
            {t('page.locked')}
          </p>
        )}
        {uploadError && <Alert tone="danger">{uploadError}</Alert>}
      </CardContent>
    </Card>
  );
}

export function TemplatesPanel({ catalog, onUploaded }: { catalog: ImportCatalog; onUploaded: (job: ImportJob) => void }) {
  const { t } = useTranslation('import');
  return (
    <div className="space-y-4">
      <Alert tone="info" title={t('page.howTo.title')}>
        <ol className="list-inside list-decimal space-y-1">
          <li>{t('page.howTo.step1')}</li>
          <li>{t('page.howTo.step2')}</li>
          <li>{t('page.howTo.step3')}</li>
        </ol>
        <p className="mt-2">{t('page.howTo.order')}</p>
      </Alert>
      <p className="text-sm text-muted-foreground">{t('page.maxRows', { max: catalog.maxRows })}</p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {catalog.templates.map((template) => (
          <TemplateCard key={template.key} template={template} onUploaded={onUploaded} />
        ))}
      </div>
    </div>
  );
}
