import { type ComponentProps, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { intlLocale } from '@/lib/format';
import { cn } from '@/lib/utils';
import { controlClasses } from './input';

export interface NumberInputProps extends Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type' | 'defaultValue'> {
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  /** Unit shown inside the field: kg, so'm, ga. */
  suffix?: string;
  /** Maximum fraction digits while displaying; input is not truncated. */
  maxDigits?: number;
  /** Allow a negative sign. Off by default: most farm quantities cannot be negative. */
  allowNegative?: boolean;
}

/** Accepts both "1,5" and "1.5" and ignores spaces, since people type numbers either way. */
export function parseNumber(text: string): number | null {
  const cleaned = text.replace(/[\s  ]/g, '').replace(',', '.');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function display(value: number | null | undefined, maxDigits: number): string {
  if (value === null || value === undefined) return '';
  return new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: maxDigits }).format(value);
}

/** Number field with grouped digits when idle, so 2 100 000 000 is readable in the field. */
export function NumberInput({
  value,
  onChange,
  suffix,
  maxDigits = 3,
  allowNegative,
  className,
  onFocus,
  onBlur,
  ...props
}: NumberInputProps) {
  const [text, setText] = useState(() => display(value, maxDigits));
  const focused = useRef(false);
  /** Field whose selection must be restored after the focus re-render, if any. */
  const reselect = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!focused.current) setText(display(value, maxDigits));
  }, [value, maxDigits]);

  // Runs before the next keystroke can arrive, so typing replaces the value instead of appending.
  useLayoutEffect(() => {
    reselect.current?.select();
    reselect.current = null;
  }, [text]);

  return (
    <div className="relative">
      <input
        type="text"
        inputMode={allowNegative ? 'text' : 'decimal'}
        autoComplete="off"
        className={cn(controlClasses, 'tabular-nums', suffix && 'pr-14', className)}
        value={text}
        onChange={(e) => {
          const next = e.target.value;
          const allowed = allowNegative ? /^-?[\d\s  ]*[.,]?\d*$/ : /^[\d\s  ]*[.,]?\d*$/;
          if (!allowed.test(next)) return;
          setText(next);
          onChange(parseNumber(next));
        }}
        onFocus={(e) => {
          focused.current = true;
          const input = e.currentTarget;
          // Tabbing into a field selects all of it, and swapping the grouped text for the raw
          // number would drop that selection: 7000000 plus 123 would become 7000000123.
          const wholeSelected =
            input.value !== '' && input.selectionStart === 0 && input.selectionEnd === input.value.length;
          const raw = value === null || value === undefined ? '' : String(value).replace('.', decimalSeparator());
          reselect.current = wholeSelected && raw !== text ? input : null;
          setText(raw);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          focused.current = false;
          setText(display(parseNumber(text), maxDigits));
          onBlur?.(e);
        }}
        {...props}
      />
      {suffix && (
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
          {suffix}
        </span>
      )}
    </div>
  );
}

function decimalSeparator(): string {
  return (1.5).toLocaleString(intlLocale()).includes(',') ? ',' : '.';
}
