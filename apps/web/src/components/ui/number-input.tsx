import { readTypedNumber } from '@yap/shared/formulas/typed-number';
import { type ComponentProps, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { intlLocale } from '@/lib/format';
import { cn } from '@/lib/utils';
import { controlClasses } from './input';

export interface NumberInputProps extends Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type' | 'defaultValue'> {
  value: number | null | undefined;
  /** Null when the field is empty, or holds text that is not a number. */
  onChange: (value: number | null) => void;
  /** The text cannot be read. Told instead of onChange, for a form that must then refuse to save. */
  onUnreadable?: () => void;
  /** Unit shown inside the field: kg, so'm, ga. */
  suffix?: string;
  /** Maximum fraction digits while displaying; input is not truncated. */
  maxDigits?: number;
  /** Allow a negative sign. Off by default: most farm quantities cannot be negative. */
  allowNegative?: boolean;
  /** A third decimal means nothing here, so 25.000 is twenty-five thousand. */
  money?: boolean;
}

function display(value: number | null | undefined, maxDigits: number): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: maxDigits }).format(value);
}

const withoutSpaces = (text: string) => text.replace(/\s/g, '');

/** Number field with grouped digits when idle, so 2 100 000 000 is readable in the field. */
export function NumberInput({
  value,
  onChange,
  onUnreadable,
  suffix,
  money = false,
  maxDigits = money ? 2 : 3,
  allowNegative,
  className,
  onFocus,
  onBlur,
  onPointerDown,
  onClick,
  ...props
}: NumberInputProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(() => display(value, maxDigits));
  /** What the person typed, until the value is set from outside. Its reading stays on screen after they leave the field. */
  const [typed, setTyped] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  /** Field whose selection must be restored after the focus re-render, if any. */
  const reselect = useRef<HTMLInputElement | null>(null);
  /** This press is what brought the focus, rather than one placing the caret in a field already in use. */
  const pressedIn = useRef(false);
  /** Focus came from a dialog opening, a label or Tab, so the first tap here still replaces the value. */
  const untouched = useRef(false);

  const read = (input: string) => readTypedNumber(input, { money, decimals: maxDigits, negative: allowNegative });
  const reading = typed === null ? null : read(typed);

  useEffect(() => {
    if (focused) return;
    setText(display(value, maxDigits));
    setTyped(null);
    // Leaving the field must not run this: an unreadable text stays where the person can correct it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, maxDigits]);

  // Runs before the next keystroke can arrive, so typing replaces the value instead of appending.
  useLayoutEffect(() => {
    reselect.current?.select();
    reselect.current = null;
  }, [text]);

  // Six digits, so the note says exactly what was read even where the field rounds what it shows.
  const heard = reading?.value == null ? '' : display(reading.value, Math.max(maxDigits, 6));
  const doubtful = reading?.otherReading != null;
  const restated = typed !== null && /[.,]/.test(typed) && withoutSpaces(heard) !== withoutSpaces(typed);
  // Not while typing, when 1.500.0 is on its way to 1.500.000. A form's own error takes over from this.
  const unreadableNote = reading?.unreadable && !focused && !props['aria-invalid'];

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="relative">
        <input
          type="text"
          inputMode={allowNegative ? 'text' : 'decimal'}
          autoComplete="off"
          className={cn(controlClasses, 'tabular-nums', suffix && 'pr-14', className)}
          value={text}
          onChange={(e) => {
            const next = e.target.value;
            untouched.current = false;
            setText(next);
            setTyped(next);
            const { unreadable, value: parsed } = read(next);
            if (unreadable && onUnreadable) onUnreadable();
            else onChange(parsed);
          }}
          onPointerDown={(e) => {
            pressedIn.current = !focused;
            onPointerDown?.(e);
          }}
          onClick={(e) => {
            // A tap puts the caret at the end, and typing would append: 12349650 became 1234965012345.
            if (pressedIn.current || untouched.current) e.currentTarget.select();
            pressedIn.current = false;
            untouched.current = false;
            onClick?.(e);
          }}
          onFocus={(e) => {
            setFocused(true);
            const input = e.currentTarget;
            untouched.current = !pressedIn.current;
            const raw = reading?.unreadable ? text : value === null || value === undefined ? '' : String(value).replace('.', decimalSeparator());
            // Swapping the grouped text for the raw number would drop a selection: 7000000 plus 123 would become 7000000123.
            if (untouched.current && raw === text) input.select();
            reselect.current = untouched.current && raw !== text ? input : null;
            setText(raw);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            if (!reading?.unreadable) setText(display(reading ? reading.value : value, maxDigits));
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
      {doubtful && (
        <p className="text-sm font-medium text-warning" data-testid="number-doubt" aria-live="polite">
          {t('common:number.readAsNot', { value: heard, other: display(reading.otherReading, maxDigits) })}
        </p>
      )}
      {!doubtful && restated && heard && (
        <p className="text-sm text-muted-foreground" data-testid="number-read-as" aria-live="polite">
          {t('common:number.readAs', { value: heard })}
        </p>
      )}
      {unreadableNote && (
        <p role="alert" className="text-sm text-destructive">
          {t('common:validation.unreadableNumber')}
        </p>
      )}
    </div>
  );
}

function decimalSeparator(): string {
  return (1.5).toLocaleString(intlLocale()).includes(',') ? ',' : '.';
}
