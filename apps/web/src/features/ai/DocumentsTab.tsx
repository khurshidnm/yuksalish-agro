import { FileScan, Upload } from 'lucide-react';
import { type ChangeEvent, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, TBody, THead, Table, Td, Th, Tr } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate, formatNumber, formatPercent, formatQty } from '@/lib/format';
import { useApiMutation } from '@/lib/query';
import { aiErrorMessage } from './text';
import type { DocumentReading } from './types';

const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{value ?? '—'}</dd>
    </div>
  );
}

function Proposal({ reading }: { reading: DocumentReading }) {
  const { t } = useTranslation('ai');
  const { proposal } = reading;
  const date = (value: string | null) => (value ? formatDate(value) : null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{reading.sources.file.name}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Alert tone="warning" title={t('documents.confirmTitle')}>
          {t('documents.confirmBody')}
        </Alert>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
          <Field label={t('documents.type')} value={t(`documents.types.${proposal.documentType}`, { defaultValue: proposal.documentType })} />
          <Field label={t('documents.number')} value={proposal.number} />
          <Field label={t('documents.date')} value={date(proposal.date)} />
          <Field label={t('documents.counterparty')} value={proposal.counterpartyName} />
          <Field label={t('documents.tin')} value={proposal.counterpartyTin} />
          <Field label={t('documents.total')} value={proposal.total === null ? null : `${formatNumber(proposal.total)} ${proposal.currency ?? ''}`} />
          {proposal.documentType === 'vet_certificate' && (
            <>
              <Field label={t('documents.animals')} value={proposal.animals === null ? null : formatNumber(proposal.animals)} />
              <Field label={t('documents.validUntil')} value={date(proposal.validUntil)} />
              <Field label={t('documents.issuer')} value={proposal.issuer} />
            </>
          )}
          <Field label={t('insights.confidence')} value={formatPercent(reading.confidence * 100, 0)} />
        </dl>
        {proposal.lines.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('documents.lineName')}</Th>
                  <Th>{t('documents.lineQty')}</Th>
                  <Th className="text-right">{t('documents.lineAmount')}</Th>
                </Tr>
              </THead>
              <TBody>
                {proposal.lines.map((line, i) => (
                  <Tr key={i}>
                    <Td>{line.name}</Td>
                    <Td>{line.qty === null ? '—' : `${formatQty(line.qty)} ${line.unit ?? ''}`}</Td>
                    <Td className="text-right tabular-nums">{line.amount === null ? '—' : formatNumber(line.amount)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Reads a photo or PDF into a proposal to check by eye. Nothing is saved from here (spec 15.1.8). */
export function DocumentsTab() {
  const { t } = useTranslation('ai');
  const input = useRef<HTMLInputElement>(null);

  const read = useApiMutation<File, DocumentReading>({
    mutationFn: async (file) => {
      const stored = await api.upload(file);
      return api.post<DocumentReading>('/ai/extract-document', { fileId: stored.id });
    },
    silentError: true,
  });

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) read.mutate(file);
    event.target.value = '';
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <EmptyState
        icon={FileScan}
        title={t('documents.title')}
        description={t('documents.description')}
        action={
          <Button loading={read.isPending} onClick={() => input.current?.click()}>
            <Upload aria-hidden />
            {t('documents.choose')}
          </Button>
        }
      />
      <input ref={input} type="file" accept={ACCEPT} className="hidden" onChange={onChange} />
      {read.error != null && <Alert tone="danger">{aiErrorMessage(t, read.error)}</Alert>}
      {read.data && <Proposal reading={read.data} />}
    </div>
  );
}
