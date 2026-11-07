import { Archive, ArrowRightLeft, ClipboardList, Home, MapPin, PawPrint, Pencil, Scale, Wheat } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { ErrorCard, PageHeader, StatCard, useConfirm } from '@/components';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Meter, Skeleton, TBody, THead, Table, Td, Th, Tr } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber, formatQty } from '@/lib/format';
import { useApiMutation, useDetail } from '@/lib/query';
import { HerdForm } from './HerdForm';
import { type HerdRow, StatusBadge } from './shared';
import { TransferDialog } from './TransferDialog';

interface HerdCard extends Omit<HerdRow, 'facilityName' | 'rationName'> {
  averageKg: number | null;
  totalKg: number | null;
  composition: { category: string; status: 'active' | 'pregnant' | 'sick' | 'quarantine'; head: number; averageKg: number | null }[];
  ration: {
    id: string;
    name: string;
    lines: { itemId: string; itemName: string; unit: string; kgPerHeadDay: number; dailyKg: number }[];
  } | null;
  facility: { id: string; name: string; capacity: number | null; occupied: number } | null;
  recentLogs: { id: string; date: string; headCount: number; condition: string; waterL: number | null }[];
  pasture: { id: string; fieldNumber: string; outDate: string; returnDate: string | null }[];
}

export default function HerdCardPage() {
  const { t } = useTranslation('livestock');
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const canManage = usePermission('livestock.update');
  const canDelete = usePermission('livestock.delete');
  const canLog = usePermission('livestock.create');
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);

  const { data: herd, error, isLoading, refetch } = useDetail<HerdCard>(`/livestock/herds/${id}`);

  const archive = useApiMutation<void>({
    mutationFn: () => api.delete(`/livestock/herds/${id}`),
    invalidate: ['/livestock/herds'],
    successMessage: 'livestock:herds.archived',
    onSuccess: () => navigate('/livestock/herds'),
  });

  const back = { to: '/livestock/herds', label: t('herds.title') };
  if (error) {
    return (
      <>
        <PageHeader title={t('herds.title')} back={back} />
        <ErrorCard error={error} onRetry={() => void refetch()} />
      </>
    );
  }
  if (isLoading || !herd) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const occupancy = herd.facility?.capacity ? (herd.facility.occupied / herd.facility.capacity) * 100 : null;

  return (
    <>
      <PageHeader
        back={back}
        title={herd.name}
        description={t(`enums:physiologicalState.${herd.state}`)}
        actions={
          <>
            {canLog && (
              <Button asChild>
                <Link to="/livestock/daily-logs">
                  <ClipboardList aria-hidden />
                  {t('herds.dailyRecord')}
                </Link>
              </Button>
            )}
            <Button variant="outline" asChild>
              <Link to={`/livestock/tracking?herd=${herd.id}`}>
                <MapPin aria-hidden />
                {t('tracking:map')}
              </Link>
            </Button>
            {canManage && (
              <Button variant="outline" asChild>
                <Link to={`/livestock/herds?tab=weighing&herd=${herd.id}`}>
                  <Scale aria-hidden />
                  {t('weighing.start')}
                </Link>
              </Button>
            )}
            {canManage && herd.headCount > 0 && (
              <Button variant="outline" onClick={() => setMoving(true)}>
                <ArrowRightLeft aria-hidden />
                {t('herds.moveAll')}
              </Button>
            )}
            {canManage && (
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil aria-hidden />
                {t('common:actions.edit')}
              </Button>
            )}
            {canDelete && herd.status === 'active' && (
              <Button
                variant="ghost"
                onClick={async () => {
                  const ok = await confirm({ title: t('herds.archiveTitle'), description: t('herds.archiveBody'), destructive: true });
                  if (ok) archive.mutate();
                }}
              >
                <Archive aria-hidden />
                {t('herds.archive')}
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('fields.headCount')} value={formatNumber(herd.headCount)} icon={PawPrint} to={`/livestock/animals?herd=${herd.id}`} />
        <StatCard label={t('herds.averageWeight')} value={formatQty(herd.averageKg, 'kg', 1)} icon={Scale} />
        <StatCard label={t('herds.totalWeight')} value={formatQty(herd.totalKg, 'kg', 0)} icon={Scale} />
        <StatCard label={t('herds.ration')} value={herd.ration?.name ?? '—'} icon={Wheat} tone={herd.ration ? 'neutral' : 'warning'} hint={herd.ration ? undefined : t('herds.noRationHint')} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('herds.composition')}</CardTitle>
          </CardHeader>
          <CardContent>
            {herd.composition.length === 0 ? (
              <p className="text-muted-foreground">{t('herds.noAnimals')}</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <Tr>
                      <Th>{t('fields.category')}</Th>
                      <Th>{t('fields.status')}</Th>
                      <Th className="text-right">{t('fields.headCount')}</Th>
                      <Th className="text-right">{t('herds.averageWeight')}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {herd.composition.map((row) => (
                      <Tr key={`${row.category}:${row.status}`}>
                        <Td>{t(`enums:animalCategory.${row.category}`)}</Td>
                        <Td>
                          <StatusBadge status={row.status} />
                        </Td>
                        <Td className="text-right tabular-nums">{formatNumber(row.head)}</Td>
                        <Td className="text-right tabular-nums">{formatQty(row.averageKg, 'kg', 1)}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('herds.rationToday')}</CardTitle>
          </CardHeader>
          <CardContent>
            {!herd.ration ? (
              <p className="text-muted-foreground">{t('herds.noRationHint')}</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <Tr>
                      <Th>{t('dailyLogs.feed')}</Th>
                      <Th className="text-right">{t('herds.perHead')}</Th>
                      <Th className="text-right">{t('herds.perDay')}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {herd.ration.lines.map((line) => (
                      <Tr key={line.itemId}>
                        <Td>{line.itemName}</Td>
                        <Td className="text-right tabular-nums">{formatQty(line.kgPerHeadDay, 'kg')}</Td>
                        <Td className="text-right tabular-nums">{formatQty(line.dailyKg, 'kg', 1)}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {herd.facility && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Home className="size-5" aria-hidden />
                {herd.facility.name}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {herd.facility.capacity ? (
                <>
                  <Meter value={occupancy} tone={occupancy !== null && occupancy > 100 ? 'danger' : 'primary'} label={t('herds.occupancy')} />
                  <p className="text-sm">{t('herds.occupied', { occupied: formatNumber(herd.facility.occupied), capacity: formatNumber(herd.facility.capacity) })}</p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{t('herds.occupiedNoCapacity', { occupied: formatNumber(herd.facility.occupied) })}</p>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>{t('herds.recentLogs')}</CardTitle>
          </CardHeader>
          <CardContent>
            {herd.recentLogs.length === 0 ? (
              <p className="text-muted-foreground">{t('dailyLogs.emptyBody')}</p>
            ) : (
              <ul className="divide-y divide-border">
                {herd.recentLogs.slice(0, 7).map((log) => (
                  <li key={log.id} className="flex items-center justify-between gap-2 py-2">
                    <span className="tabular-nums">{formatDate(log.date)}</span>
                    <Badge variant={log.condition === 'normal' ? 'success' : 'warning'}>{t(`enums:herdCondition.${log.condition}`)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {herd.pasture.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>{t('herds.tabs.pasture')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-border">
                {herd.pasture.map((move) => (
                  <li key={move.id} className="flex items-center justify-between gap-2 py-2">
                    <span>{t('pasture.fieldNumber', { number: move.fieldNumber })}</span>
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {formatDate(move.outDate)} — {move.returnDate ? formatDate(move.returnDate) : t('pasture.onPasture')}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>

      <HerdForm
        open={editing}
        onOpenChange={setEditing}
        herd={{ ...herd, facilityName: herd.facility?.name, rationName: herd.ration?.name }}
      />
      <TransferDialog open={moving} onOpenChange={setMoving} fromHerdId={herd.id} count={herd.headCount} />
    </>
  );
}
