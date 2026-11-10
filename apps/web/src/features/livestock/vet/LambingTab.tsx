import { Baby, DoorOpen, Milk, X } from 'lucide-react';
import { LAMBING_DESK } from '@yap/shared/formulas/lambing';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components';
import { Badge, Button } from '@/components/ui';
import { usePermission } from '@/lib/auth';
import { formatDate, formatQty } from '@/lib/format';
import { LambCareDialog } from './LambCare';
import { LambingForm } from './LambingForm';
import { PenStayDialog, type PenStayTarget } from './PensPanel';
import { LAMBINGS_PATH } from './options';
import type { Lambing } from './types';

interface JustLambed {
  ewe: { id: string; tag: string };
  lambingId: string;
  lambs: { id: string; tag: string }[];
}

/** Right after a lambing is saved: the first hours of each live lamb, and the pen. */
function AfterLambing({ saved, onClose }: { saved: JustLambed; onClose: () => void }) {
  const { t } = useTranslation('vet');
  const [caring, setCaring] = useState<{ id: string; tag: string } | null>(null);
  const [pen, setPen] = useState<PenStayTarget | null>(null);
  return (
    <section aria-label={t('care.afterTitle', { tag: saved.ewe.tag })} className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold break-words">{t('care.afterTitle', { tag: saved.ewe.tag })}</h2>
          <p className="text-sm text-muted-foreground">{t('care.afterHint')}</p>
        </div>
        <Button variant="ghost" size="icon" aria-label={t('common:actions.close')} onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {saved.lambs.map((lamb) => (
          <Button key={lamb.id} variant="outline" onClick={() => setCaring(lamb)}>
            <Milk aria-hidden />
            {t('care.recordFor', { tag: lamb.tag })}
          </Button>
        ))}
        <Button variant="outline" onClick={() => setPen({ ewe: saved.ewe, lambingId: saved.lambingId })}>
          <DoorOpen aria-hidden />
          {t('pens.putIn')}
        </Button>
      </div>
      <LambCareDialog lamb={caring} onOpenChange={(open) => !open && setCaring(null)} />
      <PenStayDialog target={pen} penDays={LAMBING_DESK.penDays} onOpenChange={(open) => !open && setPen(null)} />
    </section>
  );
}

export function LambingTab() {
  const { t } = useTranslation('vet');
  const canRecord = usePermission('livestock.create');
  const canRecordVet = usePermission('health.update');
  const [params, setParams] = useSearchParams();
  const [justLambed, setJustLambed] = useState<JustLambed | null>(null);

  const eweId = params.get('ewe');
  const tag = params.get('tag');
  const preset = useMemo(() => (eweId && tag ? { id: eweId, tag } : null), [eweId, tag]);

  const clearPreset = () =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('ewe');
        next.delete('tag');
        return next;
      },
      { replace: true },
    );

  const columns: Column<Lambing>[] = [
    {
      key: 'tag',
      header: t('common.ewe'),
      mobile: 'title',
      cell: (row) => (
        <Link className="relative font-medium text-primary after:absolute after:inset-x-0 after:-inset-y-3 hover:underline" to={`/livestock/animals/${row.eweId}`}>
          {row.eweTag}
        </Link>
      ),
    },
    { key: 'date', header: t('common.date'), sortable: true, mobile: 'subtitle', cell: (row) => formatDate(row.date) },
    {
      key: 'lambs',
      header: t('lambing.lambs'),
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          {row.lambs.map((lamb, index) =>
            lamb.animalId ? (
              <Link key={lamb.animalId} to={`/livestock/animals/${lamb.animalId}`} className="text-primary hover:underline">
                {lamb.tag}
                {lamb.birthWeightKg ? ` (${formatQty(lamb.birthWeightKg, 'kg')})` : ''}
              </Link>
            ) : (
              <Badge key={index} variant="danger">
                {t('lambing.stillborn')}
              </Badge>
            ),
          )}
        </span>
      ),
    },
    { key: 'born', header: t('lambing.bornAlive'), align: 'right', cell: (row) => `${row.lambsAlive} / ${row.lambsBorn}` },
    { key: 'complications', header: t('lambing.complications'), mobile: 'hidden', cell: (row) => row.complications ?? '—' },
    { key: 'herd', header: t('common.herd'), mobile: 'hidden', cell: (row) => row.herdName ?? '—' },
  ];

  return (
    <div className="space-y-4">
      {(canRecord || canRecordVet) && (
        <LambingForm
          presetEwe={preset}
          onDone={clearPreset}
          onSaved={(ewe, record) => {
            const lambs = record.lambs.flatMap((lamb) => (lamb.alive && lamb.animalId ? [{ id: lamb.animalId, tag: lamb.tag ?? '' }] : []));
            // Nothing to care for after a stillbirth, and nobody to put in a pen with her.
            setJustLambed(lambs.length > 0 ? { ewe, lambingId: record.id, lambs } : null);
          }}
        />
      )}
      {justLambed && <AfterLambing saved={justLambed} onClose={() => setJustLambed(null)} />}
      <h2 className="text-lg font-semibold">{t('lambing.recent')}</h2>
      <DataTable<Lambing>
        path={LAMBINGS_PATH}
        urlPrefix="l"
        columns={columns}
        defaultSort="-date"
        searchPlaceholder={t('common.searchTag')}
        empty={{ icon: Baby, title: t('lambing.emptyTitle'), description: t('lambing.emptyBody') }}
      />
    </div>
  );
}
