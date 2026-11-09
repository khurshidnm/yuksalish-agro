import { DEFAULT_TIMEZONE, monthOf, todayIso } from '@yap/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, type BadgeVariant } from '@/components/ui';
import { formatMonth, intlLocale } from '@/lib/format';
import i18n from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { shiftMonth } from './months';

export interface Employee {
  id: string;
  fullName: string;
  position: string;
  division: string | null;
  phone: string | null;
  passport: string | null;
  hireDate: string;
  terminationDate: string | null;
  payType: 'monthly' | 'daily' | 'piece' | 'seasonal';
  baseRate: number | null;
  pieceRates: Record<string, number> | null;
  status: 'active' | 'on_leave' | 'terminated';
  userId: string | null;
  herdId: string | null;
  contractEndDate: string | null;
  medicalCheckDate: string | null;
  notes: string | null;
}

export interface EmployeeLookup {
  id: string;
  name: string;
  position: string;
}

export const EMPLOYEE_STATUS_VARIANT: Record<Employee['status'], BadgeVariant> = {
  active: 'success',
  on_leave: 'info',
  terminated: 'neutral',
};

export { shiftMonth };

export const currentMonth = () => monthOf(todayIso());

/**
 * A month inside a sentence: "Расчётный лист за октябрь 2026". Russian and Uzbek write month names in
 * lower case there; the capital of formatMonth belongs to headings. English keeps its capital.
 */
export function monthText(month: string): string {
  const heading = formatMonth(month);
  return i18n.language?.startsWith('en') ? heading : heading.toLocaleLowerCase(intlLocale());
}

/** Both forms, so each language's sentence takes the one it needs: `{{month}}` opens a sentence, `{{monthText}}` sits inside one. */
export const monthParams = (month: string) => ({ month: formatMonth(month), monthText: monthText(month) });

/** 24-hour clock at the farm, e.g. 08:14. */
export function formatTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(intlLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: DEFAULT_TIMEZONE,
  }).format(new Date(value));
}

export function MonthSwitcher({ value, onChange, className }: { value: string; onChange: (month: string) => void; className?: string }) {
  const { t } = useTranslation('hr');
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Button variant="outline" size="icon-sm" aria-label={t('month.previous')} onClick={() => onChange(shiftMonth(value, -1))}>
        <ChevronLeft aria-hidden />
      </Button>
      <span className="min-w-36 text-center font-medium">{formatMonth(value)}</span>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={t('month.next')}
        disabled={value >= currentMonth()}
        onClick={() => onChange(shiftMonth(value, 1))}
      >
        <ChevronRight aria-hidden />
      </Button>
    </div>
  );
}
