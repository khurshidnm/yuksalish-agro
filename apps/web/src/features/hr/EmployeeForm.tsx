import { EMPLOYEE_STATUSES, PAY_TYPES } from '@yap/shared';
import { PIECE_UNITS } from '@yap/shared/formulas/payroll';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { DateField, FormDialog, FormGrid, NumberField, SelectField, TextField, TextareaField } from '@/components';
import { Separator } from '@/components/ui';
import { api } from '@/lib/api';
import { currencyLabel } from '@/lib/format';
import { zDate, zEnum, zNonNegative, zOptionalDate, zOptionalNumber, zOptionalRef, zOptionalText, zText } from '@/lib/forms';
import i18n, { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import type { Employee } from './shared';

const PATH = '/hr/employees';

const schema = z
  .object({
    fullName: zText(160),
    position: zText(120),
    division: zOptionalRef(),
    phone: zOptionalText(30),
    passport: zOptionalText(30),
    hireDate: zDate(),
    status: zEnum(EMPLOYEE_STATUSES),
    payType: zEnum(PAY_TYPES),
    baseRate: zNonNegative(),
    pieceRates: z.object({ ha: zOptionalNumber(), head: zOptionalNumber(), headDay: zOptionalNumber(), t: zOptionalNumber() }),
    herdId: zOptionalRef(),
    userId: zOptionalRef(),
    contractEndDate: zOptionalDate(),
    medicalCheckDate: zOptionalDate(),
    notes: zOptionalText(1000),
  })
  .refine((v) => v.payType !== 'seasonal' || Boolean(v.contractEndDate), {
    path: ['contractEndDate'],
    error: () => i18n.t('hr:errors.SEASON_END_REQUIRED'),
  });

type FormValues = z.input<typeof schema>;

const EMPTY: FormValues = {
  fullName: '',
  position: '',
  division: '',
  phone: '',
  passport: '',
  hireDate: '',
  status: 'active',
  payType: 'monthly',
  baseRate: 0,
  pieceRates: { ha: null, head: null, headDay: null, t: null },
  herdId: '',
  userId: '',
  contractEndDate: '',
  medicalCheckDate: '',
  notes: '',
};

function toForm(row: Employee): FormValues {
  return {
    ...EMPTY,
    ...row,
    status: row.status,
    division: row.division ?? '',
    phone: row.phone ?? '',
    passport: row.passport ?? '',
    herdId: row.herdId ?? '',
    userId: row.userId ?? '',
    contractEndDate: row.contractEndDate ?? '',
    medicalCheckDate: row.medicalCheckDate ?? '',
    notes: row.notes ?? '',
    baseRate: row.baseRate ?? 0,
    pieceRates: { ...EMPTY.pieceRates, ...row.pieceRates },
  };
}

function cleanRates(rates: Record<string, number | null>) {
  return Object.fromEntries(Object.entries(rates).filter(([, value]) => value !== null && value > 0));
}

export interface LinkableUser {
  id: string;
  fullName: string;
  phone: string;
  roleKey: string;
  employeeId: string | null;
}

export interface EmployeeFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The record to edit; null adds a new person. */
  employee: Employee | null;
}

export function EmployeeForm({ open, onOpenChange, employee }: EmployeeFormProps) {
  const { t } = useTranslation('hr');
  const divisions = useDetail<{ key: string; name: string }[]>(open ? '/hr/divisions' : null);
  const herds = useDetail<{ id: string; name: string }[]>(open ? '/livestock/herds/lookup' : null);
  const logins = useDetail<LinkableUser[]>(open ? '/hr/linkable-users' : null);

  // The API hides pay from people who may not see it. Sending it back would be refused.
  const ratesHidden = employee !== null && employee.baseRate === null;

  const loginOptions = useMemo(
    () =>
      (logins.data ?? [])
        .filter((user) => user.employeeId === null || user.employeeId === employee?.id)
        .map((user) => ({ value: user.id, label: `${user.fullName} (${t(`enums:role.${user.roleKey}`)})` })),
    [logins.data, employee, t],
  );

  const save = useApiMutation<z.output<typeof schema>>({
    mutationFn: ({ pieceRates, baseRate, status, ...values }) => {
      const pay = ratesHidden ? {} : { baseRate, pieceRates: cleanRates(pieceRates) };
      if (!employee) return api.post(PATH, { ...values, ...pay });
      // Leaving is its own flow, so a terminated person's status is not resent.
      const edited = status === 'terminated' ? {} : { status };
      return api.patch(`${PATH}/${employee.id}`, { ...values, ...pay, ...edited });
    },
    invalidate: [PATH, '/hr/linkable-users'],
    silentError: true,
  });

  const money = currencyLabel();

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={employee ? t('employees.edit') : t('employees.add')}
      schema={schema}
      defaultValues={employee ? toForm(employee) : EMPTY}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage={employee ? 'common:toast.updated' : 'common:toast.created'}
      size="lg"
    >
      {(form) => {
        const payType = form.watch('payType');
        return (
          <>
            <TextField form={form} name="fullName" label={t('employees.fields.fullName')} required autoFocus />
            <FormGrid>
              <TextField form={form} name="position" label={t('employees.fields.position')} required />
              <SelectField
                form={form}
                name="division"
                label={t('employees.fields.division')}
                options={(divisions.data ?? []).map((d) => ({ value: d.key, label: d.name }))}
              />
              <TextField form={form} name="phone" label={t('employees.fields.phone')} type="tel" inputMode="tel" />
              <TextField form={form} name="passport" label={t('employees.fields.passport')} />
              <DateField form={form} name="hireDate" label={t('employees.fields.hireDate')} required />
              {employee && employee.status !== 'terminated' && (
                <SelectField
                  form={form}
                  name="status"
                  label={t('employees.fields.status')}
                  required
                  options={enumOptions('employeeStatus', ['active', 'on_leave'])}
                />
              )}
            </FormGrid>

            {!ratesHidden && (
              <>
                <Separator />
                <p className="text-sm font-medium">{t('employees.sections.pay')}</p>
                <FormGrid>
                  <SelectField form={form} name="payType" label={t('employees.fields.payType')} required options={enumOptions('payType', PAY_TYPES)} />
                  {payType !== 'piece' && (
                    <NumberField money form={form} name="baseRate" label={t(`employees.rate.${payType}`)} suffix={money} required maxDigits={2} />
                  )}
                </FormGrid>
                <p className="text-sm text-muted-foreground">{t('employees.pieceHint')}</p>
                <FormGrid>
                  {PIECE_UNITS.map((unit) => (
                    <NumberField money key={unit} form={form} name={`pieceRates.${unit}`} label={t(`employees.pieceUnit.${unit}`)} suffix={money} maxDigits={2} />
                  ))}
                </FormGrid>
              </>
            )}

            <Separator />
            <p className="text-sm font-medium">{t('employees.sections.work')}</p>
            <FormGrid>
              <SelectField
                form={form}
                name="herdId"
                label={t('employees.fields.herd')}
                hint={t('employees.fields.herdHint')}
                options={(herds.data ?? []).map((h) => ({ value: h.id, label: h.name }))}
              />
              <SelectField form={form} name="userId" label={t('employees.fields.login')} hint={t('employees.fields.loginHint')} options={loginOptions} />
              <DateField
                form={form}
                name="contractEndDate"
                label={t('employees.fields.contractEnd')}
                hint={payType === 'seasonal' ? t('employees.fields.contractEndSeasonal') : undefined}
                required={payType === 'seasonal'}
              />
              <DateField form={form} name="medicalCheckDate" label={t('employees.fields.medicalCheck')} />
            </FormGrid>
            <TextareaField form={form} name="notes" label={t('employees.fields.notes')} />
          </>
        );
      }}
    </FormDialog>
  );
}
