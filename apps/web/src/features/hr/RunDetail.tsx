import { todayIso } from '@yap/shared';
import { ArrowLeft, Banknote, CheckCheck, RefreshCw, Send, Trash2, Undo2, Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, DataTableView, DateField, ErrorCard, FormDialog, MoneyText, NumberField, SelectField, StatCard, TextareaField, useConfirm } from '@/components';
import { Alert, Badge, type BadgeVariant, Button, Card, CardContent, CardHeader, CardTitle, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Meter, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission, useSession } from '@/lib/auth';
import { currencyLabel, formatDateTime, formatMoney, formatMonth, formatNumber } from '@/lib/format';
import { zDate, zNonNegative, zRef, zText } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';
import { accountLabel } from '@/features/finance/lib';
import { monthParams } from './shared';

export interface KpiResult {
  name: string;
  metric: string;
  value: number | null;
  threshold: number;
  bonus: number;
}

interface Basis {
  presentDays?: number;
  paidDays?: number;
  /** Runs worked out before these were stored have only paidDays. */
  sickDays?: number;
  vacationDays?: number;
  expectedDays?: number;
  employedDays?: number;
  daysInMonth?: number;
  work?: { hectares: number; tons: number; headTreated: number; headDays: number };
  kpi?: KpiResult[];
}

export interface PayrollLine {
  id: string;
  employeeId: string;
  fullName: string | null;
  position: string;
  payType: string;
  daysWorked: number;
  base: number;
  piecework: number;
  bonus: number;
  advance: number;
  deductions: number;
  net: number;
  gross: number;
  overrides: string[];
  basis: Basis;
}

export type RunStatus = 'draft' | 'pending' | 'approved' | 'paid';

export interface PayrollRun {
  id: string;
  month: string;
  status: RunStatus;
  totalGross: number;
  totalNet: number;
  preparedBy: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  returnedReason: string | null;
  lines: PayrollLine[];
  allocation: { costCenterId: string; name: string; type: string; amount: number }[];
}

export const RUN_STATUS_VARIANT: Record<RunStatus, BadgeVariant> = {
  draft: 'neutral',
  pending: 'warning',
  approved: 'info',
  paid: 'success',
};

const PATH = '/hr/payroll';

const lineSchema = z.object({
  base: zNonNegative(),
  piecework: zNonNegative(),
  bonus: zNonNegative(),
  advance: zNonNegative(),
  deductions: zNonNegative(),
});

/** Most lines have no piecework or advance, so zeros recede and the real figures stand out. */
function Amount({ value }: { value: number }) {
  return <MoneyText value={value} className={value === 0 ? 'text-muted-foreground' : undefined} />;
}

const returnSchema = z.object({ reason: zText(500) });
const paySchema = z.object({ accountId: zRef(), date: zDate() });

function BasisFacts({ line }: { line: PayrollLine }) {
  const { t } = useTranslation('hr');
  const { basis } = line;
  const present = basis.presentDays ?? line.daysWorked;
  const facts: string[] = [t('payroll.basis.days', { present, expected: basis.expectedDays ?? 0 })];
  // A monthly wage also pays sick and leave days, and covers only the part of the month on staff.
  if (line.payType === 'monthly') {
    const leave = (basis.paidDays ?? present) - present;
    if (leave > 0) {
      const detail =
        basis.sickDays === undefined || basis.vacationDays === undefined
          ? t('payroll.basis.leave', { days: leave })
          : [
              basis.sickDays ? t('payroll.basis.sick', { days: basis.sickDays }) : null,
              basis.vacationDays ? t('payroll.basis.vacation', { days: basis.vacationDays }) : null,
            ]
              .filter(Boolean)
              .join(', ');
      facts.push(t('payroll.basis.paid', { paid: basis.paidDays, detail }));
    }
    if (basis.employedDays !== undefined && basis.daysInMonth !== undefined && basis.employedDays < basis.daysInMonth) {
      facts.push(t('payroll.basis.employed', { employed: basis.employedDays, days: basis.daysInMonth }));
    }
  }
  if (basis.work?.hectares) facts.push(t('payroll.basis.hectares', { value: formatNumber(basis.work.hectares) }));
  if (basis.work?.tons) facts.push(t('payroll.basis.tons', { value: formatNumber(basis.work.tons) }));
  if (basis.work?.headTreated) facts.push(t('payroll.basis.head', { value: formatNumber(basis.work.headTreated, 0) }));
  if (basis.work?.headDays) facts.push(t('payroll.basis.headDays', { value: formatNumber(basis.work.headDays, 0) }));

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted p-3 text-sm">
      <p className="font-medium">{t('payroll.basis.title')}</p>
      <ul className="flex flex-col gap-0.5 text-muted-foreground">
        {facts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
        {basis.kpi?.map((kpi) => (
          <li key={kpi.name}>
            {kpi.value === null
              ? t('payroll.basis.kpiNoData', { name: kpi.name })
              : t('payroll.basis.kpi', { name: kpi.name, value: formatNumber(kpi.value), bonus: formatMoney(kpi.bonus) })}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PaySlip({ line }: { line: PayrollLine }) {
  const { t } = useTranslation('hr');
  const rows: [string, number][] = [
    [t('payroll.fields.base'), line.base],
    [t('payroll.fields.piecework'), line.piecework],
    [t('payroll.fields.bonus'), line.bonus],
    [t('payroll.fields.gross'), line.gross],
    [t('payroll.fields.advance'), line.advance],
    [t('payroll.fields.deductions'), line.deductions],
    [t('payroll.fields.net'), line.net],
  ];
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right">
            <MoneyText value={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function LineDialog({ run, line, editable, onClose }: { run: PayrollRun; line: PayrollLine | null; editable: boolean; onClose: () => void }) {
  const { t } = useTranslation('hr');
  const money = currencyLabel();
  const save = useApiMutation<z.output<typeof lineSchema>>({
    mutationFn: (values) => {
      // Only figures that really changed count as hand edits, so the rest keep following the timesheet.
      const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => line?.[key as keyof PayrollLine] !== value));
      if (Object.keys(changed).length === 0) return Promise.resolve();
      return api.patch(`${PATH}/${run.id}/lines/${line?.id}`, changed);
    },
    invalidate: [PATH],
    silentError: true,
  });

  const title = line?.fullName ?? line?.position;

  if (!editable) {
    return (
      <Dialog open={line !== null} onOpenChange={(open) => !open && onClose()}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{t('payroll.slipFor', monthParams(run.month))}</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            {line && (
              <>
                <PaySlip line={line} />
                <BasisFacts line={line} />
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common:actions.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <FormDialog
      open={line !== null}
      onOpenChange={(open) => !open && onClose()}
      title={title}
      description={t('payroll.slipFor', monthParams(run.month))}
      schema={lineSchema}
      defaultValues={{
        base: line?.base ?? 0,
        piecework: line?.piecework ?? 0,
        bonus: line?.bonus ?? 0,
        advance: line?.advance ?? 0,
        deductions: line?.deductions ?? 0,
      }}
      onSubmit={(values) => save.mutateAsync(values)}
      size="sm"
    >
      {(form) => (
        <>
          {line && <BasisFacts line={line} />}
          {(['base', 'piecework', 'bonus', 'advance', 'deductions'] as const).map((field) => (
            <NumberField
              money
              key={field}
              form={form}
              name={field}
              label={t(`payroll.fields.${field}`)}
              suffix={money}
              maxDigits={2}
              hint={line?.overrides.includes(field) ? t('payroll.editedByHand') : undefined}
            />
          ))}
        </>
      )}
    </FormDialog>
  );
}

function AllocationCard({ run }: { run: PayrollRun }) {
  const { t } = useTranslation('hr');
  const total = run.allocation.reduce((sum, row) => sum + row.amount, 0);
  if (run.allocation.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('payroll.allocation.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-3">
          {run.allocation.map((row) => {
            const name = row.type === 'general' ? t('payroll.allocation.general') : row.name;
            return (
              <li key={row.costCenterId} className="flex flex-col gap-1 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">{name}</span>
                  <MoneyText value={row.amount} />
                </div>
                <Meter value={total ? (row.amount / total) * 100 : 0} label={name} />
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

export function RunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const { t } = useTranslation('hr');
  const session = useSession();
  const confirm = useConfirm();
  const canUpdate = usePermission('payroll.update');
  const canApprove = usePermission('payroll.approve');
  const canDelete = usePermission('payroll.delete');
  const url = `${PATH}/${runId}`;

  const query = useDetail<PayrollRun>(url);
  const run = query.data;

  const [selected, setSelected] = useState<PayrollLine | null>(null);
  const [returning, setReturning] = useState(false);
  const [paying, setPaying] = useState(false);

  const accounts = useDetail<{ id: string; name: string | null }[]>(paying ? '/finance/accounts/lookup' : null);

  const action = (path: string, successMessage: string) => ({
    mutationFn: () => api.post<PayrollRun>(`${url}/${path}`),
    invalidate: [PATH, '/hr/timesheets'],
    successMessage,
  });
  const recalculate = useApiMutation(action('recalculate', 'hr:payroll.recalculated'));
  const submit = useApiMutation(action('submit', 'hr:payroll.submitted'));
  const approve = useApiMutation(action('approve', 'hr:payroll.approved'));
  const remove = useApiMutation({
    mutationFn: () => api.delete(url),
    invalidate: [PATH],
    successMessage: 'common:toast.deleted',
    onSuccess: onBack,
  });
  const sendBack = useApiMutation<z.output<typeof returnSchema>>({
    mutationFn: (values) => api.postOnce(`${url}/return`, values),
    invalidate: [PATH],
    silentError: true,
  });
  const pay = useApiMutation<z.output<typeof paySchema>>({
    mutationFn: (values) => api.postOnce(`${url}/pay`, values),
    invalidate: [PATH, '/finance'],
    silentError: true,
  });

  const back = (
    <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
      <ArrowLeft aria-hidden />
      {t('payroll.backToRuns')}
    </Button>
  );

  if (query.isLoading) return <Skeleton className="h-64 rounded-xl" />;
  if (query.error || !run) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <ErrorCard error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  const makerChecker = (session.settings.finance as { makerChecker?: boolean } | undefined)?.makerChecker !== false;
  const isMaker = makerChecker && run.preparedBy === session.user.id;
  const open = run.status === 'draft' || run.status === 'pending';
  const editable = run.status === 'draft' && canUpdate;
  const toPay = run.lines.reduce((sum, line) => sum + Math.max(0, line.net), 0);

  const columns: Column<PayrollLine>[] = [
    { key: 'fullName', header: t('employees.fields.fullName'), cell: (row) => row.fullName ?? row.position, mobile: 'title' },
    { key: 'position', header: t('employees.fields.position'), cell: (row) => row.position, mobile: 'subtitle' },
    { key: 'daysWorked', header: t('payroll.fields.days'), cell: (row) => formatNumber(row.daysWorked, 1), align: 'right' },
    { key: 'base', header: t('payroll.fields.base'), cell: (row) => <Amount value={row.base} />, align: 'right' },
    { key: 'piecework', header: t('payroll.fields.piecework'), cell: (row) => <Amount value={row.piecework} />, align: 'right', mobile: 'hidden' },
    { key: 'bonus', header: t('payroll.fields.bonus'), cell: (row) => <Amount value={row.bonus} />, align: 'right' },
    { key: 'advance', header: t('payroll.fields.advance'), cell: (row) => <Amount value={row.advance} />, align: 'right', mobile: 'hidden' },
    { key: 'deductions', header: t('payroll.fields.deductions'), cell: (row) => <Amount value={row.deductions} />, align: 'right', mobile: 'hidden' },
    {
      key: 'net',
      header: t('payroll.fields.net'),
      cell: (row) => <MoneyText value={row.net} className={row.net < 0 ? 'text-danger' : 'font-medium'} />,
      align: 'right',
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {back}

      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-semibold">{formatMonth(run.month)}</h2>
          <Badge className="mt-1" variant={RUN_STATUS_VARIANT[run.status]}>
            {t(`enums:payrollStatus.${run.status}`)}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          {editable && (
            <>
              <Button variant="outline" loading={recalculate.isPending} onClick={() => recalculate.mutate()}>
                <RefreshCw aria-hidden />
                {t('payroll.recalculate')}
              </Button>
              <Button variant="secondary" loading={submit.isPending} onClick={() => submit.mutate()}>
                <Send aria-hidden />
                {t('payroll.submit')}
              </Button>
            </>
          )}
          {open && canApprove && (
            <Button
              disabled={isMaker}
              loading={approve.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: t('payroll.approveTitle', monthParams(run.month)),
                  description: t('payroll.approveBody', { amount: formatMoney(run.totalGross) }),
                  confirmLabel: t('payroll.approve'),
                });
                if (ok) approve.mutate();
              }}
            >
              <CheckCheck aria-hidden />
              {t('payroll.approve')}
            </Button>
          )}
          {run.status === 'pending' && canApprove && (
            <Button variant="outline" onClick={() => setReturning(true)}>
              <Undo2 aria-hidden />
              {t('payroll.return')}
            </Button>
          )}
          {run.status === 'approved' && canUpdate && (
            <Button onClick={() => setPaying(true)}>
              <Banknote aria-hidden />
              {t('payroll.pay')}
            </Button>
          )}
          {run.status === 'draft' && canDelete && (
            <Button
              variant="ghost"
              className="text-destructive"
              loading={remove.isPending}
              onClick={async () => {
                const ok = await confirm({ title: t('payroll.deleteTitle', monthParams(run.month)), destructive: true });
                if (ok) remove.mutate();
              }}
            >
              <Trash2 aria-hidden />
              {t('common:actions.delete')}
            </Button>
          )}
        </div>
      </div>

      {open && canApprove && isMaker && <Alert tone="info">{t('payroll.makerHint')}</Alert>}
      {run.returnedReason && (
        <Alert tone="warning" title={t('payroll.returnedTitle')}>
          {run.returnedReason}
        </Alert>
      )}
      {run.paidAt && <Alert tone="success">{t('payroll.paidOn', { date: formatDateTime(run.paidAt) })}</Alert>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={t('payroll.fields.gross')} value={<MoneyText value={run.totalGross} compact />} hint={t('payroll.grossHint')} />
        <StatCard label={t('payroll.fields.net')} value={<MoneyText value={run.totalNet} compact />} hint={t('payroll.netHint')} tone="success" />
        <StatCard label={t('payroll.people')} value={run.lines.length} icon={Users} />
      </div>

      <DataTableView<PayrollLine>
        rows={run.lines}
        columns={columns}
        onRowClick={setSelected}
        empty={{ title: t('payroll.noLines') }}
      />

      <AllocationCard run={run} />

      <LineDialog run={run} line={selected} editable={editable} onClose={() => setSelected(null)} />

      <FormDialog
        open={returning}
        onOpenChange={setReturning}
        title={t('payroll.returnTitle')}
        schema={returnSchema}
        defaultValues={{ reason: '' }}
        onSubmit={(values) => sendBack.mutateAsync(values)}
        submitLabel={t('payroll.return')}
        size="sm"
      >
        {(form) => <TextareaField form={form} name="reason" label={t('payroll.returnReason')} required />}
      </FormDialog>

      <FormDialog
        open={paying}
        onOpenChange={setPaying}
        title={t('payroll.payTitle', monthParams(run.month))}
        description={t('payroll.payBody', { amount: formatMoney(toPay) })}
        schema={paySchema}
        defaultValues={{ accountId: '', date: todayIso() }}
        onSubmit={(values) => pay.mutateAsync(values)}
        successMessage="hr:payroll.paid"
        submitLabel={t('payroll.pay')}
        size="sm"
      >
        {(form) => (
          <>
            <SelectField
              form={form}
              name="accountId"
              label={t('payroll.account')}
              required
              options={(accounts.data ?? []).map((a) => ({ value: a.id, label: accountLabel(a) }))}
            />
            <DateField form={form} name="date" label={t('payroll.payDate')} required />
          </>
        )}
      </FormDialog>
    </div>
  );
}
