import { IDENTIFIER_TYPES, todayIso } from '@yap/shared';
import { ArrowRightLeft, Camera, DoorOpen, Pencil, Plus, Scale, ShieldAlert, Tag, Trash2 } from 'lucide-react';
import { lazy, Suspense, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { DateField, ErrorCard, FormDialog, FormGrid, MoneyText, NumberField, PageHeader, SelectField, StatCard, TextField, UrlTabs, useConfirm } from '@/components';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Skeleton, TBody, THead, Table, Td, Th, Tr } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber, formatQty } from '@/lib/format';
import { zDate, zEnum, zPositive, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { errorMessage, useApiMutation, useDetail } from '@/lib/query';
import { AnimalForm } from './AnimalForm';
import { ExitForm } from './ExitForm';
import { type Animal, type I18nName, StatusBadge, compressImage, isOnFarm, useAgeText, useLocalName } from './shared';
import { TransferDialog } from './TransferDialog';

const WeightChart = lazy(() => import('./WeightChart'));

interface WeightRow {
  id: string;
  date: string;
  weightKg: number;
  method: string;
  notes: string | null;
  adgG: number | null;
}

interface AnimalCard extends Animal {
  speciesName: I18nName;
  breedName: I18nName | null;
  herdName: string | null;
  facilityName: string | null;
  damTag: string | null;
  sireTag: string | null;
  sellerName: string | null;
  photoUrl: string | null;
  identifiers: { id: string; type: string; value: string }[];
  weights: WeightRow[];
  adgG: number | null;
  transfers: { id: string; date: string; reason: string | null; fromHerdName: string | null; toHerdName: string | null }[];
  exit: { type: string; date: string; reason: string | null; liveWeightKg: number | null; amount: number | null; lossAmount: number | null; vetConclusion: string | null } | null;
  pregnancy: { id: string; matingDate: string; expectedDate: string } | null;
  withdrawalUntil: string | null;
  cost: { purchasePrice: number | null; accumulatedPerHead: number | null; bookValue: number | null } | null;
}

const weightSchema = z.object({ date: zDate(), weightKg: zPositive() });
const identifierSchema = z.object({ type: zEnum(IDENTIFIER_TYPES), value: zText(60) });

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-medium break-words">{children}</dd>
    </div>
  );
}

export default function AnimalCardPage() {
  const { t } = useTranslation('livestock');
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const canManage = usePermission('livestock.update');
  const canDelete = usePermission('livestock.delete');
  const canExit = usePermission('livestock.create');
  const canSell = usePermission('sales.create');
  const localName = useLocalName();
  const ageText = useAgeText();
  const confirm = useConfirm();
  const today = todayIso();

  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [weighing, setWeighing] = useState(false);
  const [addingId, setAddingId] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);

  const path = `/livestock/animals/${id}`;
  const { data: animal, error, isLoading, refetch } = useDetail<AnimalCard>(path);

  const addWeight = useApiMutation<z.output<typeof weightSchema>>({
    mutationFn: (values) => api.post('/livestock/weights', { ...values, animalId: id }),
    invalidate: ['/livestock/animals', '/livestock/herds'],
    silentError: true,
  });
  const removeWeight = useApiMutation<string>({
    mutationFn: (weightId) => api.delete(`/livestock/weights/${weightId}`),
    invalidate: ['/livestock/animals'],
    successMessage: 'common:toast.deleted',
  });
  const addIdentifier = useApiMutation<z.output<typeof identifierSchema>>({
    mutationFn: (values) => api.post(`${path}/identifiers`, values),
    invalidate: ['/livestock/animals'],
    silentError: true,
  });
  const removeIdentifier = useApiMutation<string>({
    mutationFn: (identifierId) => api.delete(`${path}/identifiers/${identifierId}`),
    invalidate: ['/livestock/animals'],
    successMessage: 'common:toast.deleted',
  });
  const removeAnimal = useApiMutation<void>({
    mutationFn: () => api.delete(path),
    invalidate: ['/livestock/animals', '/livestock/summary', '/livestock/herds'],
    successMessage: 'common:toast.deleted',
    onSuccess: () => navigate('/livestock/animals'),
  });
  const setPhoto = useApiMutation<File>({
    mutationFn: async (file) => {
      const uploaded = await api.upload(await compressImage(file));
      await api.patch(path, { photoFileId: uploaded.id });
    },
    invalidate: ['/livestock/animals'],
    successMessage: 'common:toast.saved',
    onError: (e) => toast.error(errorMessage(e)),
  });

  const back = { to: '/livestock/animals', label: t('animals.title') };
  if (error) {
    return (
      <>
        <PageHeader title={t('animals.title')} back={back} />
        <ErrorCard error={error} onRetry={() => void refetch()} />
      </>
    );
  }
  if (isLoading || !animal) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const active = isOnFarm(animal.status);

  const overview = (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t('card.details')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4">
            <Detail label={t('fields.species')}>{localName(animal.speciesName)}</Detail>
            <Detail label={t('fields.breed')}>{localName(animal.breedName)}</Detail>
            <Detail label={t('fields.sex')}>{t(`enums:sex.${animal.sex}`)}</Detail>
            <Detail label={t('fields.category')}>{t(`enums:animalCategory.${animal.category}`)}</Detail>
            <Detail label={t('fields.birthDate')}>
              {formatDate(animal.birthDate)}
              {animal.birthDateEstimated && animal.birthDate ? ` (${t('card.estimated')})` : ''}
            </Detail>
            <Detail label={t('fields.origin')}>{t(`enums:animalOrigin.${animal.origin}`)}</Detail>
            {animal.purchaseDate && <Detail label={t('fields.purchaseDate')}>{formatDate(animal.purchaseDate)}</Detail>}
            <Detail label={t('fields.herd')}>
              {animal.herdId ? (
                <Link className="underline underline-offset-2" to={`/livestock/herds/${animal.herdId}`}>
                  {animal.herdName}
                </Link>
              ) : (
                '—'
              )}
            </Detail>
            <Detail label={t('card.place')}>{animal.facilityName ?? '—'}</Detail>
          </dl>
          {animal.notes && <p className="mt-4 rounded-lg bg-muted p-3 text-sm">{animal.notes}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('card.parents')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4">
            <Detail label={t('card.dam')}>
              {animal.damId ? (
                <Link className="underline underline-offset-2" to={`/livestock/animals/${animal.damId}`}>
                  {animal.damTag}
                </Link>
              ) : (
                '—'
              )}
            </Detail>
            <Detail label={t('card.sire')}>
              {animal.sireId ? (
                <Link className="underline underline-offset-2" to={`/livestock/animals/${animal.sireId}`}>
                  {animal.sireTag}
                </Link>
              ) : (
                '—'
              )}
            </Detail>
          </dl>
        </CardContent>
      </Card>

      {animal.cost && (
        <Card>
          <CardHeader>
            <CardTitle>{t('card.cost')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4">
              <Detail label={t('fields.purchasePrice')}>
                <MoneyText value={animal.cost.purchasePrice} />
              </Detail>
              <Detail label={t('card.accumulated')}>
                <MoneyText value={animal.cost.accumulatedPerHead} />
              </Detail>
              <Detail label={t('card.bookValue')}>
                <MoneyText value={animal.cost.bookValue} />
              </Detail>
              {animal.sellerName && <Detail label={t('fields.seller')}>{animal.sellerName}</Detail>}
            </dl>
          </CardContent>
        </Card>
      )}

      {animal.exit && (
        <Card>
          <CardHeader>
            <CardTitle>{t('card.exit')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4">
              <Detail label={t('exits.type')}>{t(`enums:animalExitType.${animal.exit.type}`)}</Detail>
              <Detail label={t('fields.date')}>{formatDate(animal.exit.date)}</Detail>
              <Detail label={t('exits.liveWeight')}>{formatQty(animal.exit.liveWeightKg, 'kg', 1)}</Detail>
              {animal.exit.reason && <Detail label={t('exits.reason')}>{animal.exit.reason}</Detail>}
              {animal.exit.vetConclusion && <Detail label={t('exits.vetConclusion')}>{animal.exit.vetConclusion}</Detail>}
              {animal.exit.amount !== null && (
                <Detail label={t('exits.amount')}>
                  <MoneyText value={animal.exit.amount} />
                </Detail>
              )}
              {animal.exit.lossAmount !== null && (
                <Detail label={t('exits.loss')}>
                  <MoneyText value={animal.exit.lossAmount} />
                </Detail>
              )}
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );

  const weights = (
    <div className="space-y-4">
      {animal.weights.length >= 2 && (
        <Suspense fallback={<Skeleton className="h-72 w-full" />}>
          <WeightChart title={t('card.weightChart')} seriesLabel={t('fields.weight')} data={animal.weights} />
        </Suspense>
      )}
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>{t('card.weightHistory')}</CardTitle>
          {canManage && active && (
            <Button onClick={() => setWeighing(true)}>
              <Plus aria-hidden />
              {t('card.addWeight')}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {animal.weights.length === 0 ? (
            <p className="text-muted-foreground">{t('card.noWeights')}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <Tr>
                    <Th>{t('fields.date')}</Th>
                    <Th className="text-right">{t('fields.weight')}</Th>
                    <Th className="text-right">{t('card.adg')}</Th>
                    <Th>{t('card.method')}</Th>
                    {canManage && <Th aria-label={t('common:actions.delete')} />}
                  </Tr>
                </THead>
                <TBody>
                  {[...animal.weights].reverse().map((row) => (
                    <Tr key={row.id}>
                      <Td className="tabular-nums">{formatDate(row.date)}</Td>
                      <Td className="text-right tabular-nums">{formatQty(row.weightKg, 'kg', 1)}</Td>
                      <Td className="text-right tabular-nums">{row.adgG === null ? '—' : `${formatNumber(row.adgG, 0)} g`}</Td>
                      <Td>{t(`enums:weightMethod.${row.method}`)}</Td>
                      {canManage && (
                        <Td className="text-right">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('common:actions.delete')}
                            onClick={async () => {
                              const ok = await confirm({ title: t('card.deleteWeight'), destructive: true });
                              if (ok) removeWeight.mutate(row.id);
                            }}
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        </Td>
                      )}
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );

  const identifiers = (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{t('card.identifiers')}</CardTitle>
        {canManage && active && (
          <Button onClick={() => setAddingId(true)}>
            <Plus aria-hidden />
            {t('card.addIdentifier')}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {animal.identifiers.map((identifier) => (
            <li key={identifier.id} className="flex items-center justify-between gap-2 py-2">
              <span>
                <span className="block text-sm text-muted-foreground">{t(`enums:identifierType.${identifier.type}`)}</span>
                <span className="font-medium break-all tabular-nums">{identifier.value}</span>
              </span>
              {canManage && !(identifier.type === 'ear_tag' && identifier.value === animal.tag) && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('common:actions.delete')}
                  onClick={async () => {
                    const ok = await confirm({ title: t('card.deleteIdentifier', { value: identifier.value }), destructive: true });
                    if (ok) removeIdentifier.mutate(identifier.id);
                  }}
                >
                  <Trash2 aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );

  const transfers = (
    <Card>
      <CardHeader>
        <CardTitle>{t('card.transfers')}</CardTitle>
      </CardHeader>
      <CardContent>
        {animal.transfers.length === 0 ? (
          <p className="text-muted-foreground">{t('card.noTransfers')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {animal.transfers.map((row) => (
              <li key={row.id} className="py-2">
                <p className="font-medium">
                  {row.fromHerdName ?? '—'} → {row.toHerdName ?? '—'}
                </p>
                <p className="text-sm text-muted-foreground">
                  {formatDate(row.date)}
                  {row.reason ? ` · ${row.reason}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {animal.tag}
            <StatusBadge status={animal.status} />
          </span>
        }
        description={`${localName(animal.breedName)} · ${t(`enums:animalCategory.${animal.category}`)}`}
        actions={
          <>
            {canManage && active && (
              <Button onClick={() => setWeighing(true)}>
                <Scale aria-hidden />
                {t('card.addWeight')}
              </Button>
            )}
            {canManage && active && (
              <Button variant="outline" onClick={() => setMoving(true)}>
                <ArrowRightLeft aria-hidden />
                {t('transfer.title')}
              </Button>
            )}
            {canManage && active && (
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil aria-hidden />
                {t('common:actions.edit')}
              </Button>
            )}
            {(canExit || canSell) && active && (
              <Button variant="outline" onClick={() => setExiting(true)}>
                <DoorOpen aria-hidden />
                {t('exits.add')}
              </Button>
            )}
            {canDelete && (
              <Button
                variant="ghost"
                onClick={async () => {
                  const ok = await confirm({ title: t('card.deleteTitle'), description: t('card.deleteBody', { tag: animal.tag }), destructive: true });
                  if (ok) removeAnimal.mutate();
                }}
              >
                <Trash2 aria-hidden />
                {t('common:actions.delete')}
              </Button>
            )}
          </>
        }
      />

      {animal.withdrawalUntil && (
        <Alert tone="warning" title={t('card.withdrawalTitle')} className="mb-4">
          {t('card.withdrawalBody', { date: formatDate(animal.withdrawalUntil) })}
        </Alert>
      )}
      {animal.pregnancy && (
        <Alert tone="info" title={t('card.pregnancyTitle')} className="mb-4">
          {t('card.pregnancyBody', { date: formatDate(animal.pregnancy.expectedDate) })}
        </Alert>
      )}
      {animal.status === 'quarantine' && (
        <Alert tone="warning" title={t('card.quarantineTitle')} className="mb-4">
          <ShieldAlert className="sr-only" aria-hidden />
          {t('card.quarantineBody')}
        </Alert>
      )}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
        <div className="relative size-32 overflow-hidden rounded-xl border border-border bg-muted">
          {animal.photoUrl ? (
            <img src={animal.photoUrl} alt={t('photo.animalAlt', { tag: animal.tag })} className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center text-muted-foreground">
              <Tag className="size-10" aria-hidden />
            </div>
          )}
          {canManage && active && (
            <>
              <input
                ref={photoInput}
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) setPhoto.mutate(file);
                  e.target.value = '';
                }}
              />
              <Button
                variant="secondary"
                size="icon-sm"
                className="absolute right-1 bottom-1"
                loading={setPhoto.isPending}
                aria-label={t('photo.change')}
                onClick={() => photoInput.current?.click()}
              >
                <Camera aria-hidden />
              </Button>
            </>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <StatCard label={t('fields.weight')} value={formatQty(animal.currentWeightKg, 'kg', 1)} hint={animal.lastWeighedOn ? t('card.weighedOn', { date: formatDate(animal.lastWeighedOn) }) : undefined} />
          <StatCard label={t('card.adg')} value={animal.adgG === null ? '—' : `${formatNumber(animal.adgG, 0)} g`} tone={animal.adgG !== null && animal.adgG < 0 ? 'danger' : 'neutral'} />
          <StatCard label={t('fields.age')} value={ageText(animal.birthDate, animal.exitDate ?? today)} />
        </div>
      </div>

      <UrlTabs
        tabs={[
          { value: 'overview', label: t('card.tabs.overview'), content: overview },
          { value: 'weights', label: t('card.tabs.weights'), content: weights },
          { value: 'identifiers', label: t('card.tabs.identifiers'), content: identifiers },
          { value: 'transfers', label: t('card.tabs.transfers'), content: transfers },
        ]}
      />

      <AnimalForm open={editing} onOpenChange={setEditing} animal={animal} />
      <TransferDialog open={moving} onOpenChange={setMoving} animalIds={[animal.id]} count={1} />
      <ExitForm open={exiting} onOpenChange={setExiting} animal={animal} />
      <FormDialog
        open={weighing}
        onOpenChange={setWeighing}
        title={t('card.addWeight')}
        schema={weightSchema}
        defaultValues={{ date: today, weightKg: animal.currentWeightKg ?? 0 }}
        onSubmit={(values) => addWeight.mutateAsync(values)}
        successMessage="common:toast.saved"
      >
        {(form) => (
          <FormGrid>
            <NumberField form={form} name="weightKg" label={t('fields.weight')} suffix="kg" maxDigits={2} required />
            <DateField form={form} name="date" label={t('fields.date')} required max={today} />
          </FormGrid>
        )}
      </FormDialog>
      <FormDialog
        open={addingId}
        onOpenChange={setAddingId}
        title={t('card.addIdentifier')}
        schema={identifierSchema}
        defaultValues={{ type: 'rfid', value: '' }}
        onSubmit={(values) => addIdentifier.mutateAsync(values)}
        successMessage="common:toast.saved"
      >
        {(form) => (
          <>
            <SelectField form={form} name="type" label={t('card.identifierType')} required options={enumOptions('identifierType', IDENTIFIER_TYPES)} />
            <TextField form={form} name="value" label={t('card.identifierValue')} required autoFocus />
          </>
        )}
      </FormDialog>
    </>
  );
}
