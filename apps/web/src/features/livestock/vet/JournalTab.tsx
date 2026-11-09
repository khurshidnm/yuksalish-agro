import { HEALTH_RECORD_TYPES } from '@yap/shared';
import { ClipboardList, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTable, MoneyText, useConfirm, useUrlParam } from '@/components';
import { Badge, type BadgeVariant, Button, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatQty } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { RecordDialog } from './RecordDialog';
import { ANIMALS_PATH, HEALTH_PATH } from './options';
import type { HealthRecord } from './types';

const PATH = `${HEALTH_PATH}/records`;

const TYPE_TONE: Record<string, BadgeVariant> = {
  vaccination: 'success',
  treatment: 'danger',
  prophylaxis: 'info',
  deworming: 'info',
  examination: 'neutral',
  quarantine: 'warning',
};

export function JournalTab() {
  const { t } = useTranslation('vet');
  const confirm = useConfirm();
  const canWrite = usePermission('health.update');
  const canDelete = usePermission('health.delete');
  const canSeeMoney = usePermission('finance.view');

  const [type, setType] = useUrlParam('jType');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<HealthRecord | null>(null);

  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: [HEALTH_PATH, ANIMALS_PATH, '/inventory'],
    successMessage: 'common:toast.deleted',
  });

  const columns: Column<HealthRecord>[] = [
    {
      key: 'target',
      header: t('journal.target'),
      mobile: 'title',
      cell: (row) =>
        row.animalId ? (
          <Link className="relative font-medium text-primary after:absolute after:inset-x-0 after:-inset-y-3 hover:underline" to={`/livestock/animals/${row.animalId}`}>
            {row.animalTag}
          </Link>
        ) : (
          <span className="font-medium">
            {row.herdName} ({t('common.head', { count: row.headCount ?? 0 })})
          </span>
        ),
    },
    {
      key: 'type',
      header: t('journal.type'),
      sortable: true,
      cell: (row) => (
        <span className="flex flex-col items-start gap-1">
          {/* A shepherd's report is not an examination: nobody has looked at the animal yet. */}
          {row.reportStatus !== null ? (
            <Badge variant="danger">{t('journal.sickReport')}</Badge>
          ) : (
            <Badge variant={TYPE_TONE[row.type]}>{t(`enums:healthRecordType.${row.type}`)}</Badge>
          )}
          {row.planName && <span className="text-sm text-muted-foreground">{row.planName}</span>}
        </span>
      ),
    },
    { key: 'date', header: t('common.date'), sortable: true, mobile: 'subtitle', cell: (row) => formatDate(row.date) },
    {
      key: 'diagnosis',
      header: t('journal.diagnosis'),
      // Notes are not a diagnosis: they go under it, quieter.
      cell: (row) => (
        <span className="block min-w-0">
          {(row.diagnosis || !row.notes) && <span className="block">{row.diagnosis ?? '—'}</span>}
          {row.notes && <span className="line-clamp-2 block text-sm break-words text-muted-foreground">{row.notes}</span>}
        </span>
      ),
    },
    {
      key: 'drug',
      header: t('journal.drug'),
      cell: (row) => (
        <span className="block min-w-0">
          {row.itemName ?? '—'}
          {row.itemName && row.qtyUsed ? <span className="block text-sm whitespace-nowrap text-muted-foreground">{formatQty(row.qtyUsed, row.itemUnit ?? undefined)}</span> : null}
        </span>
      ),
    },
    { key: 'withdrawal', header: t('journal.withdrawalUntil'), mobile: 'hidden', cell: (row) => formatDate(row.withdrawalUntil) },
    { key: 'vet', header: t('journal.vet'), mobile: 'hidden', cell: (row) => row.vetName ?? '—' },
    ...(canSeeMoney
      ? [
          {
            key: 'totalCost',
            header: t('journal.cost'),
            align: 'right',
            sortable: true,
            mobile: 'hidden',
            // Nothing came from stock, so there is no cost to show, not a cost of 0.
            cell: (row) => (row.itemId ? <MoneyText value={row.totalCost} /> : '—'),
          } satisfies Column<HealthRecord>,
        ]
      : []),
  ];

  return (
    <>
      <DataTable<HealthRecord>
        path={PATH}
        urlPrefix="j"
        params={{ type: type || undefined }}
        columns={columns}
        defaultSort="-date"
        searchPlaceholder={t('journal.searchPlaceholder')}
        filters={
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <Select
              aria-label={t('journal.typeFilter')}
              value={type}
              onChange={(e) => setType(e.target.value)}
              options={enumOptions('healthRecordType', HEALTH_RECORD_TYPES)}
              placeholder={t('common.all')}
              className="md:w-56"
            />
            {canWrite && (
              <Button onClick={() => setAdding(true)}>
                <Plus aria-hidden />
                {t('journal.add')}
              </Button>
            )}
          </div>
        }
        empty={{ icon: ClipboardList, title: t('journal.emptyTitle'), description: t('journal.emptyBody') }}
        rowActions={(row) => {
          // Quarantine and sick reports drive an animal's status, so they close in their own tabs.
          const lifecycle = row.type === 'quarantine' || row.reportStatus !== null;
          return [
            { label: t('common:actions.edit'), icon: Pencil, hidden: !canWrite || lifecycle, onClick: () => setEditing(row) },
            {
              label: t('common:actions.delete'),
              icon: Trash2,
              destructive: true,
              hidden: !canDelete || lifecycle,
              onClick: async () => {
                const ok = await confirm({
                  title: t('journal.deleteTitle'),
                  description: t('journal.deleteBody'),
                  destructive: true,
                });
                if (ok) remove.mutate(row.id);
              },
            },
          ];
        }}
      />
      <RecordDialog
        open={adding || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAdding(false);
            setEditing(null);
          }
        }}
        record={editing}
      />
    </>
  );
}
