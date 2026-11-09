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

/** Classes that size or place the control (md:w-48, flex-1, ml-auto...). */
const BOX_CLASS = /^(?:[\w-]+:)*-?(?:w|min-w|max-w|basis|grow|shrink|flex-(?:1|auto|initial|none)|self|order|col|row|m[trblxyse]?)(?:-|$)/;

/**
 * Native select: opens the phone's own picker, which is the easiest control with gloves on.
 * The chevron sits in a wrapper, so the classes that size or place the control go on the wrapper and
 * the select fills it: a select at md:w-48 in a full-width block keeps its chevron inside the box.
 */
export function Select({ options, placeholder, className, children, ...props }: SelectProps) {
  const classes = className?.split(/\s+/).filter(Boolean) ?? [];
  const box = classes.filter((c) => BOX_CLASS.test(c));
  const control = classes.filter((c) => !BOX_CLASS.test(c));
  return (
    <div className={cn('relative', box)}>
      <select className={cn(controlClasses, 'appearance-none truncate pr-10', control)} {...props}>
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
