import { formatMoney, type MoneyOptions } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface MoneyTextProps extends MoneyOptions {
  value: number | string | null | undefined;
  /** Show an explicit sign, coloured by direction. The sign means it never relies on colour alone. */
  signed?: boolean;
  className?: string;
}

/** A money amount. `null` renders as a dash, including when the API stripped the value. */
export function MoneyText({ value, signed, className, ...options }: MoneyTextProps) {
  const n = value === null || value === undefined || value === '' ? null : Number(value);
  const positive = n !== null && n > 0;
  const negative = n !== null && n < 0;
  return (
    <span className={cn('whitespace-nowrap tabular-nums', signed && positive && 'text-success', signed && negative && 'text-danger', className)}>
      {signed && positive && '+'}
      {formatMoney(value, options)}
    </span>
  );
}
