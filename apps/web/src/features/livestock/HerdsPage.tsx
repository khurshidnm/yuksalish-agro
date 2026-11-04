import { Boxes, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTable, PageHeader, UrlTabs } from '@/components';
import { Badge, Button } from '@/components/ui';
import { usePermission } from '@/lib/auth';
import { formatNumber } from '@/lib/format';
import { HerdForm } from './HerdForm';
import { PasturePanel } from './PasturePanel';
import type { HerdRow } from './shared';
import { ShearingPanel } from './ShearingPanel';
import { WeighingPanel } from './WeighingPanel';

function HerdList() {
  const { t } = useTranslation('livestock');
  const canManage = usePermission('livestock.update');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<HerdRow | null>(null);

  const columns: Column<HerdRow>[] = [
    { key: 'name', header: t('fields.name'), cell: (row) => <span className="font-semibold">{row.name}</span>, sortable: true, mobile: 'title' },
    { key: 'state', header: t('herds.state'), cell: (row) => <Badge>{t(`enums:physiologicalState.${row.state}`)}</Badge>, sortable: true, mobile: 'subtitle' },
    { key: 'head', header: t('fields.headCount'), cell: (row) => formatNumber(row.headCount), align: 'right' },
    { key: 'facility', header: t('herds.facility'), cell: (row) => row.facilityName ?? '—' },
    { key: 'ration', header: t('herds.ration'), cell: (row) => row.rationName ?? <span className="text-warning">{t('herds.noRation')}</span> },
  ];

  return (
    <div className="space-y-3">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            {t('herds.add')}
          </Button>
        </div>
      )}
      <DataTable<HerdRow>
        path="/livestock/herds"
        columns={columns}
        defaultSort="name"
        searchPlaceholder={t('herds.searchPlaceholder')}
        rowHref={(row) => `/livestock/herds/${row.id}`}
        rowActions={(row) => [{ label: t('common:actions.edit'), icon: Pencil, hidden: !canManage, onClick: () => setEditing(row) }]}
        empty={{
          icon: Boxes,
          title: t('herds.emptyTitle'),
          description: t('herds.emptyBody'),
          action: canManage && (
            <Button onClick={() => setAdding(true)}>
              <Plus aria-hidden />
              {t('herds.add')}
            </Button>
          ),
        }}
      />
      <HerdForm open={adding || editing !== null} herd={editing} onOpenChange={(open) => { if (!open) { setAdding(false); setEditing(null); } }} />
    </div>
  );
}

export default function HerdsPage() {
  const { t } = useTranslation('livestock');
  return (
    <>
      <PageHeader title={t('herds.title')} description={t('herds.description')} />
      <UrlTabs
        tabs={[
          { value: 'herds', label: t('herds.tabs.herds'), content: <HerdList /> },
          { value: 'weighing', label: t('herds.tabs.weighing'), content: <WeighingPanel /> },
          { value: 'pasture', label: t('herds.tabs.pasture'), content: <PasturePanel /> },
          { value: 'shearing', label: t('herds.tabs.shearing'), content: <ShearingPanel /> },
        ]}
      />
    </>
  );
}
