import { ANIMAL_EXIT_TYPES } from '@yap/shared';
import { CircleMinus, Plus, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTable, MoneyText, PageHeader, useConfirm, useUrlParam } from '@/components';
import { Badge, type BadgeVariant, Button, DateInput, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan, usePermission } from '@/lib/auth';
import { formatDate, formatQty } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { ExitForm } from './ExitForm';

const PATH = '/livestock/exits';

interface ExitRow {
  id: string;
  animalId: string;
  tag: string;
  category: string;
  herdName: string | null;
  type: (typeof ANIMAL_EXIT_TYPES)[number];
  date: string;
  liveWeightKg: number | null;
  carcassWeightKg: number | null;
  amount: number | null;
  lossAmount: number | null;
  counterpartyName: string | null;
  transactionStatus: string | null;
  reason: string | null;
  transactionId: string | null;
}

const TYPE_VARIANT: Record<ExitRow['type'], BadgeVariant> = { sale: 'success', slaughter: 'info', death: 'danger', loss: 'warning' };

export default function ExitsPage() {
  const { t } = useTranslation('livestock');
  const can = useCan();
  const canSeeMoney = usePermission('finance.view');
  const canUndo = usePermission('livestock.delete');
  const canRecord = can('livestock.create') || can('sales.create');
  const confirm = useConfirm();

  const [type, setType] = useUrlParam('type');
  const [from, setFrom] = useUrlParam('from');
  const [to, setTo] = useUrlParam('to');
  const [adding, setAdding] = useState(false);

  const undo = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: [PATH, '/livestock/animals', '/livestock/herds', '/livestock/summary'],
    successMessage: 'livestock:exits.undone',
  });

  const columns: Column<ExitRow>[] = [
    {
      key: 'tag',
      header: t('fields.tag'),
      sortable: true,
      mobile: 'title',
      cell: (row) => (
        <Link to={`/livestock/animals/${row.animalId}`} className="font-semibold tabular-nums underline-offset-2 hover:underline">
          {row.tag}
        </Link>
      ),
    },
    { key: 'type', header: t('exits.type'), sortable: true, mobile: 'subtitle', cell: (row) => <Badge variant={TYPE_VARIANT[row.type]}>{t(`enums:animalExitType.${row.type}`)}</Badge> },
    { key: 'date', header: t('fields.date'), sortable: true, cell: (row) => formatDate(row.date) },
    { key: 'category', header: t('fields.category'), cell: (row) => t(`enums:animalCategory.${row.category}`), mobile: 'hidden' },
    { key: 'herd', header: t('fields.herd'), cell: (row) => row.herdName ?? '—', mobile: 'hidden' },
    { key: 'weight', header: t('exits.liveWeight'), align: 'right', cell: (row) => formatQty(row.liveWeightKg, 'kg', 1) },
    ...(canSeeMoney
      ? [
          {
            key: 'money',
            header: t('exits.amountOrLoss'),
            align: 'right' as const,
            cell: (row: ExitRow) => <MoneyText value={row.type === 'sale' ? row.amount : row.lossAmount} />,
          },
          { key: 'buyer', header: t('exits.buyer'), cell: (row: ExitRow) => row.counterpartyName ?? '—', mobile: 'hidden' as const },
        ]
      : []),
    { key: 'reason', header: t('exits.reason'), cell: (row) => row.reason ?? '—', mobile: 'hidden' },
  ];

  return (
    <>
      <PageHeader
        title={t('exits.title')}
        description={t('exits.description')}
        actions={
          canRecord && (
            <Button onClick={() => setAdding(true)}>
              <Plus aria-hidden />
              {t('exits.add')}
            </Button>
          )
        }
      />
      <DataTable<ExitRow>
        path={PATH}
        params={{ type: type || undefined, from: from || undefined, to: to || undefined }}
        columns={columns}
        defaultSort="-date"
        searchPlaceholder={t('exits.searchPlaceholder')}
        filters={
          <>
            <Select
              aria-label={t('exits.type')}
              value={type}
              onChange={(e) => setType(e.target.value)}
              options={enumOptions('animalExitType', ANIMAL_EXIT_TYPES)}
              placeholder={t('exits.allTypes')}
              className="md:w-44"
            />
            {/* Two equal date boxes need words: which one is "from" and which "to". */}
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="w-20 shrink-0 md:w-auto">{t('filters.from')}</span>
              <DateInput value={from} onChange={(e) => setFrom(e.target.value)} className="min-w-0 flex-1 md:w-44 md:flex-none" />
            </label>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="w-20 shrink-0 md:w-auto">{t('filters.to')}</span>
              <DateInput value={to} onChange={(e) => setTo(e.target.value)} className="min-w-0 flex-1 md:w-44 md:flex-none" />
            </label>
          </>
        }
        rowActions={(row) => [
          {
            label: t('exits.undo'),
            icon: Undo2,
            hidden: !canUndo || !!row.transactionId,
            onClick: async () => {
              const ok = await confirm({
                title: t('exits.undoTitle'),
                description: t('exits.undoBody', { tag: row.tag }),
                destructive: true,
                confirmLabel: t('exits.undo'),
                cancelLabel: t('common:actions.close'),
              });
              if (ok) undo.mutate(row.id);
            },
          },
        ]}
        empty={{ icon: CircleMinus, title: t('exits.emptyTitle'), description: t('exits.emptyBody') }}
      />
      <ExitForm open={adding} onOpenChange={setAdding} />
    </>
  );
}
