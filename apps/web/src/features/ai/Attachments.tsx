import { useTranslation } from 'react-i18next';
import { ChartCard } from '@/components/ChartCard';
import { TBody, THead, Table, Td, Th, Tr } from '@/components/ui';
import { formatDate, formatNumber } from '@/lib/format';
import { cellText, fieldLabel } from './text';
import type { Attachment } from './types';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function TableAttachment({ attachment }: { attachment: Extract<Attachment, { type: 'table' }> }) {
  const { t } = useTranslation('ai');
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="font-medium">{attachment.title}</figcaption>
      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <THead>
            <Tr>
              {attachment.columns.map((column) => (
                <Th key={column}>{fieldLabel(t, column)}</Th>
              ))}
            </Tr>
          </THead>
          <TBody>
            {attachment.rows.map((row, i) => (
              <Tr key={i}>
                {attachment.columns.map((column) => (
                  <Td key={column} className={typeof row[column] === 'number' ? 'text-right whitespace-nowrap tabular-nums' : 'whitespace-nowrap'}>
                    {cellText(row[column])}
                  </Td>
                ))}
              </Tr>
            ))}
          </TBody>
        </Table>
      </div>
      {attachment.total > attachment.rows.length && (
        <p className="text-sm text-muted-foreground">
          {t('chat.tableMore', { shown: attachment.rows.length, total: attachment.total })}
        </p>
      )}
    </figure>
  );
}

function ChartAttachment({ attachment }: { attachment: Extract<Attachment, { type: 'chart' }> }) {
  const { t } = useTranslation('ai');
  const formatX = (value: string) => (ISO_DATE.test(value) ? formatDate(value) : value);
  return (
    <ChartCard
      title={attachment.title}
      kind={attachment.chart}
      data={attachment.rows}
      xKey={attachment.xKey}
      series={attachment.yKeys.map((key) => ({ key, label: fieldLabel(t, key) }))}
      formatX={formatX}
      formatValue={(value) => formatNumber(value)}
      height={220}
    />
  );
}

/** Tables and charts below an answer. Their rows come from real tool results on the server. */
export function Attachments({ attachments }: { attachments: Attachment[] }) {
  return (
    <div className="flex flex-col gap-3">
      {attachments.map((attachment, i) =>
        attachment.type === 'table' ? (
          <TableAttachment key={i} attachment={attachment} />
        ) : (
          <ChartAttachment key={i} attachment={attachment} />
        ),
      )}
    </div>
  );
}
