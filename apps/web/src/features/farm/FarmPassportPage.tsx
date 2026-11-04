import { LAND_USES } from '@yap/shared';
import { Map as MapIcon, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useFieldArray, type UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { z } from 'zod';
import { DateField, ErrorCard, FormDialog, FormGrid, NumberField, PageHeader, StatCard, TextField, TextareaField } from '@/components';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Meter, Separator, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate, formatNumber, formatPercent } from '@/lib/format';
import { zOptionalDate, zOptionalNumber, zOptionalText, zText } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';
import type { AreaBalance, Passport } from './types';
import { formatHa } from './utils';
import { WeatherCard } from './WeatherCard';

const PATH = '/farm/passport';

const schema = z.object({
  name: zText(200),
  region: zOptionalText(120),
  district: zOptionalText(120),
  address: zOptionalText(300),
  totalAreaHa: zOptionalNumber(),
  lat: zOptionalNumber(),
  lng: zOptionalNumber(),
  cadastreNumber: zOptionalText(80),
  passport: z.object({
    landRightType: zOptionalText(80),
    leaseContractNo: zOptionalText(80),
    leaseContractDate: zOptionalDate(),
    leaseValidUntil: zOptionalDate(),
    bankName: zOptionalText(120),
    bankAccount: zOptionalText(40),
    mfo: zOptionalText(10),
    notes: zOptionalText(2000),
    responsiblePersons: z.array(z.object({ role: zText(80), fullName: zText(120), phone: zOptionalText(30) })),
  }),
});

type FormInput = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;

function toForm(p: Passport): FormInput {
  const d = p.passport;
  return {
    name: p.name,
    region: p.region ?? '',
    district: p.district ?? '',
    address: p.address ?? '',
    totalAreaHa: p.totalAreaHa,
    lat: p.lat,
    lng: p.lng,
    cadastreNumber: p.cadastreNumber ?? '',
    passport: {
      landRightType: d.landRightType ?? '',
      leaseContractNo: d.leaseContractNo ?? '',
      leaseContractDate: d.leaseContractDate ?? '',
      leaseValidUntil: d.leaseValidUntil ?? '',
      bankName: d.bankName ?? '',
      bankAccount: d.bankAccount ?? '',
      mfo: d.mfo ?? '',
      notes: d.notes ?? '',
      responsiblePersons: d.responsiblePersons.map((person) => ({ ...person, phone: person.phone ?? '' })),
    },
  };
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-medium break-words">{children ?? '—'}</dd>
    </div>
  );
}

function BalanceCard({ balance }: { balance: AreaBalance }) {
  const { t } = useTranslation('farm');
  const total = balance.totalAreaHa;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('passport.balanceTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {balance.overAssigned && <Alert tone="danger">{t('passport.overAssignedBody', { area: formatHa(Math.abs(balance.unassignedHa ?? 0)) })}</Alert>}
        <ul className="flex flex-col gap-3">
          {LAND_USES.map((use) => {
            const row = balance.byLandUse.find((r) => r.landUse === use);
            const share = total ? ((row?.areaHa ?? 0) * 100) / total : null;
            return (
              <li key={use}>
                <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                  <span>
                    {t(`enums:landUse.${use}`)}
                    {row?.count ? <span className="text-muted-foreground"> · {t('fields.contourCount', { value: formatNumber(row.count) })}</span> : null}
                  </span>
                  <span className="font-medium tabular-nums">
                    {formatHa(row?.areaHa ?? 0)}
                    {share !== null && <span className="ml-1.5 font-normal text-muted-foreground">{formatPercent(share, 0)}</span>}
                  </span>
                </div>
                <Meter value={share} label={t(`enums:landUse.${use}`)} />
              </li>
            );
          })}
        </ul>
        <Separator />
        <dl>
          <Row label={t('passport.assigned')}>{formatHa(balance.assignedHa)}</Row>
          <Row label={t('passport.unassigned')}>{balance.overAssigned ? '—' : formatHa(balance.unassignedHa)}</Row>
        </dl>
      </CardContent>
    </Card>
  );
}

function PeopleEditor({ form, showPhone }: { form: UseFormReturn<FormInput, unknown, FormOutput>; showPhone: boolean }) {
  const { t } = useTranslation('farm');
  const people = useFieldArray({ control: form.control, name: 'passport.responsiblePersons' });
  const errors = form.formState.errors.passport?.responsiblePersons;

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 font-semibold">{t('passport.people')}</legend>
      {people.fields.map((person, index) => (
        <div key={person.id} className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Label htmlFor={`${person.id}-role`}>{t('passport.personRole')}</Label>
            <Input id={`${person.id}-role`} aria-invalid={Boolean(errors?.[index]?.role) || undefined} {...form.register(`passport.responsiblePersons.${index}.role`)} />
          </div>
          <div className="min-w-0 flex-1">
            <Label htmlFor={`${person.id}-name`}>{t('passport.personName')}</Label>
            <Input id={`${person.id}-name`} aria-invalid={Boolean(errors?.[index]?.fullName) || undefined} {...form.register(`passport.responsiblePersons.${index}.fullName`)} />
          </div>
          {showPhone && (
            <div className="min-w-0 flex-1">
              <Label htmlFor={`${person.id}-phone`}>{t('passport.personPhone')}</Label>
              <Input id={`${person.id}-phone`} type="tel" {...form.register(`passport.responsiblePersons.${index}.phone`)} />
            </div>
          )}
          <Button variant="ghost" size="icon" aria-label={t('common:actions.delete')} onClick={() => people.remove(index)}>
            <Trash2 aria-hidden />
          </Button>
        </div>
      ))}
      <Button variant="outline" className="self-start" onClick={() => people.append({ role: '', fullName: '', phone: '' })}>
        <Plus aria-hidden />
        {t('passport.addPerson')}
      </Button>
    </fieldset>
  );
}

export default function FarmPassportPage() {
  const { t } = useTranslation('farm');
  const canUpdate = usePermission('farm.update');
  const canSeePii = usePermission('pii.view');
  const query = useDetail<Passport>(PATH);
  const [editing, setEditing] = useState(false);

  const save = useApiMutation<FormOutput>({
    mutationFn: (values) => api.patch(PATH, values),
    invalidate: ['/farm'],
    silentError: true,
  });

  if (query.error) {
    return (
      <>
        <PageHeader title={t('passport.title')} />
        <ErrorCard error={query.error} onRetry={() => void query.refetch()} />
      </>
    );
  }

  if (!query.data) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-64" />
        <div className="grid gap-3 md:grid-cols-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  const p = query.data;
  const d = p.passport;
  const balance = p.areaBalance;
  const arable = balance.byLandUse.find((row) => row.landUse === 'arable');

  return (
    <>
      <PageHeader
        title={p.name}
        description={[p.region, p.district].filter(Boolean).join(', ') || t('passport.description')}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/farm/map">
                <MapIcon aria-hidden />
                {t('fields.openMap')}
              </Link>
            </Button>
            {canUpdate && (
              <Button onClick={() => setEditing(true)}>
                <Pencil aria-hidden />
                {t('common:actions.edit')}
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatCard label={t('passport.totalArea')} value={formatHa(balance.totalAreaHa)} />
        <StatCard label={t('fields.arableArea')} value={formatHa(arable?.areaHa)} tone="success" />
        <StatCard
          label={balance.overAssigned ? t('passport.overAssigned') : t('passport.unassigned')}
          value={formatHa(balance.unassignedHa === null ? null : Math.abs(balance.unassignedHa))}
          tone={balance.overAssigned ? 'danger' : 'neutral'}
          className="col-span-2 md:col-span-1"
        />
      </div>

      {d.notes && (
        <Alert tone="warning" className="mb-4">
          {d.notes}
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <BalanceCard balance={balance} />
          <WeatherCard />
        </div>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('passport.general')}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <Row label={t('passport.legalName')}>{p.tenant.legalName ?? p.tenant.name}</Row>
                <Row label={t('passport.tin')}>{p.tenant.tin}</Row>
                <Row label={t('passport.legalForm')}>{p.tenant.legalForm}</Row>
                <Row label={t('passport.taxRegime')}>{p.tenant.taxRegime}</Row>
                <Row label={t('passport.address')}>{p.address}</Row>
                <Row label={t('passport.coordinates')}>{p.lat != null && p.lng != null ? `${formatNumber(p.lat, 5)}, ${formatNumber(p.lng, 5)}` : null}</Row>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('passport.landRights')}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <Row label={t('passport.landRightType')}>{d.landRightType}</Row>
                <Row label={t('passport.leaseContractNo')}>{d.leaseContractNo}</Row>
                <Row label={t('passport.leaseContractDate')}>{d.leaseContractDate ? formatDate(d.leaseContractDate) : null}</Row>
                <Row label={t('passport.leaseValidUntil')}>{d.leaseValidUntil ? formatDate(d.leaseValidUntil) : null}</Row>
                <Row label={t('passport.cadastre')}>{p.cadastreNumber}</Row>
                <Row label={t('passport.bank')}>{[d.bankName, d.bankAccount, d.mfo].filter(Boolean).join(' · ') || null}</Row>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('passport.people')}</CardTitle>
            </CardHeader>
            <CardContent>
              {d.responsiblePersons.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('passport.noPeople')}</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {d.responsiblePersons.map((person) => (
                    <li key={`${person.role}-${person.fullName}`} className="flex items-center gap-3 py-2">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                        <UserRound className="size-5" aria-hidden />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium break-words">{person.fullName}</span>
                        <span className="block text-sm text-muted-foreground">
                          {person.role}
                          {person.phone && ` · ${person.phone}`}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <FormDialog
        open={editing}
        onOpenChange={setEditing}
        title={t('passport.edit')}
        schema={schema}
        defaultValues={toForm(p)}
        onSubmit={(values) => save.mutateAsync(values)}
        successMessage="common:toast.updated"
        size="lg"
      >
        {(form) => (
          <>
            <TextField form={form} name="name" label={t('passport.name')} required />
            <FormGrid>
              <TextField form={form} name="region" label={t('passport.region')} />
              <TextField form={form} name="district" label={t('passport.district')} />
            </FormGrid>
            <TextField form={form} name="address" label={t('passport.address')} />
            <FormGrid>
              <NumberField form={form} name="totalAreaHa" label={t('passport.totalArea')} suffix={t('unit.haShort')} maxDigits={4} />
              <TextField form={form} name="cadastreNumber" label={t('passport.cadastre')} />
              <NumberField form={form} name="lat" label={t('facilities.lat')} maxDigits={7} />
              <NumberField form={form} name="lng" label={t('facilities.lng')} maxDigits={7} />
            </FormGrid>
            <Separator />
            <FormGrid>
              <TextField form={form} name="passport.landRightType" label={t('passport.landRightType')} />
              <TextField form={form} name="passport.leaseContractNo" label={t('passport.leaseContractNo')} />
              <DateField form={form} name="passport.leaseContractDate" label={t('passport.leaseContractDate')} />
              <DateField form={form} name="passport.leaseValidUntil" label={t('passport.leaseValidUntil')} />
              <TextField form={form} name="passport.bankName" label={t('passport.bankName')} />
              <TextField form={form} name="passport.bankAccount" label={t('passport.bankAccount')} />
              <TextField form={form} name="passport.mfo" label={t('passport.mfo')} />
            </FormGrid>
            <Separator />
            <PeopleEditor form={form} showPhone={canSeePii} />
            <TextareaField form={form} name="passport.notes" label={t('notes')} rows={3} />
          </>
        )}
      </FormDialog>
    </>
  );
}
