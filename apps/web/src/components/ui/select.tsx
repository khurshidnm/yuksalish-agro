import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { controlClasses } from './input';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends ComponentProps<'select'> {
  options?: readonly SelectOption[];
  /** Adds an empty first option. */
  placeholder?: string;
}

/** Native select: opens the phone's own picker, which is the easiest control with gloves on. */
export function Select({ options, placeholder, className, children, ...props }: SelectProps) {
  return (
    <div className="relative">
      <select className={cn(controlClasses, 'appearance-none truncate pr-10', className)} {...props}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
    </div>
  );
}
