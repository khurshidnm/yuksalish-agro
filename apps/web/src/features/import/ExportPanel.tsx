import { Download } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, DateInput, Label } from '@/components/ui';
import { api } from '@/lib/api';
import { useApiMutation } from '@/lib/query';
import type { ExportInfo } from './types';

type Format = 'xlsx' | 'csv';

function ExportCard({ entity }: { entity: string }) {
  const { t, i18n } = useTranslation('import');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const download = useApiMutation<Format>({
    mutationFn: (format) =>
      api.download(`/import/export/${entity}`, undefined, {
        format,
        lang: i18n.language,
        from: from || undefined,
        to: to || undefined,
      }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(`exports.entity.${entity}`)}</CardTitle>
        <CardDescription>{t(`exports.entityHint.${entity}`)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {entity === 'transactions' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="export-from">{t('exports.from')}</Label>
              <DateInput id="export-from" value={from} onChange={(event) => setFrom(event.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="export-to">{t('exports.to')}</Label>
              <DateInput id="export-to" value={to} onChange={(event) => setTo(event.target.value)} />
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {(['xlsx', 'csv'] as const).map((format) => (
            <Button
              key={format}
              variant="outline"
              loading={download.isPending && download.variables === format}
              onClick={() => download.mutate(format)}
            >
              <Download aria-hidden />
              {t(format === 'xlsx' ? 'exports.excel' : 'exports.csv')}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function ExportPanel({ entities }: { entities: ExportInfo[] }) {
  const { t } = useTranslation('import');
  return (
    <div className="space-y-4">
      <Alert tone="info" title={t('exports.title')}>
        {t('exports.description')}
      </Alert>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {entities
          .filter((entity) => entity.allowed)
          .map((entity) => (
            <ExportCard key={entity.key} entity={entity.key} />
          ))}
      </div>
    </div>
  );
}
