import type { ComponentProps, ReactNode } from 'react';
import { useId } from 'react';
import { type FieldPath, type FieldValues, type UseFormReturn, useController } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  Checkbox,
  Combobox,
  type ComboboxProps,
  DateInput,
  Input,
  Label,
  NumberInput,
  type NumberInputProps,
  Select,
  type SelectOption,
  Switch,
  Textarea,
} from './ui';

// The form's own transformed-output type is irrelevant to a field.
// biome-ignore lint: react-hook-form's third generic must stay open here.
type AnyForm<F extends FieldValues> = UseFormReturn<F, any, any>;

export interface FieldBaseProps<F extends FieldValues, N extends FieldPath<F>> {
  form: AnyForm<F>;
  name: N;
  label?: ReactNode;
  hint?: ReactNode;
  /** Marks the label. Validation itself comes from the zod schema. */
  required?: boolean;
  className?: string;
}

export interface FieldControlProps {
  id: string;
  name: string;
  // biome-ignore lint: the value type depends on the form field.
  value: any;
  onChange: (value: unknown) => void;
  onBlur: () => void;
  ref: (el: unknown) => void;
  disabled?: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

export interface FormFieldProps<F extends FieldValues, N extends FieldPath<F>> extends FieldBaseProps<F, N> {
  children: (field: FieldControlProps) => ReactNode;
}

/** Label, control, hint and error for one form value. Use the typed fields below when one fits. */
export function FormField<F extends FieldValues, N extends FieldPath<F>>({ form, name, label, hint, required, className, children }: FormFieldProps<F, N>) {
  const { t } = useTranslation();
  const id = useId();
  const { field, fieldState } = useController({ control: form.control, name });
  const describedBy = fieldState.error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {label && (
        <Label htmlFor={id}>
          {label}
          {required && (
            <span className="text-destructive" title={t('common:form.required')}>
              {' *'}
            </span>
          )}
        </Label>
      )}
      {children({
        id,
        name: field.name,
        value: field.value,
        onChange: field.onChange,
        onBlur: field.onBlur,
        ref: field.ref,
        disabled: field.disabled,
        'aria-invalid': fieldState.invalid || undefined,
        'aria-describedby': describedBy,
      })}
      {hint && !fieldState.error && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {fieldState.error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {fieldState.error.message}
        </p>
      )}
    </div>
  );
}

type NativeInputProps = Pick<ComponentProps<'input'>, 'type' | 'placeholder' | 'autoComplete' | 'inputMode' | 'maxLength' | 'autoFocus' | 'disabled'>;

export function TextField<F extends FieldValues, N extends FieldPath<F>>({ form, name, label, hint, required, className, ...input }: FieldBaseProps<F, N> & NativeInputProps) {
  return (
    <FormField form={form} name={name} label={label} hint={hint} required={required} className={className}>
      {(field) => <Input {...input} {...field} disabled={input.disabled ?? field.disabled} value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value)} />}
    </FormField>
  );
}

export function TextareaField<F extends FieldValues, N extends FieldPath<F>>({
  form,
  name,
  label,
  hint,
  required,
  className,
  rows,
  placeholder,
}: FieldBaseProps<F, N> & { rows?: number; placeholder?: string }) {
  return (
    <FormField form={form} name={name} label={label} hint={hint} required={required} className={className}>
      {(field) => <Textarea rows={rows} placeholder={placeholder} {...field} value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value)} />}
    </FormField>
  );
}

export function NumberField<F extends FieldValues, N extends FieldPath<F>>({
  form,
  name,
  label,
  hint,
  required,
  className,
  ...input
}: FieldBaseProps<F, N> & Pick<NumberInputProps, 'suffix' | 'maxDigits' | 'allowNegative' | 'placeholder' | 'disabled'>) {
  return (
    <FormField form={form} name={name} label={label} hint={hint} required={required} className={className}>
      {(field) => <NumberInput {...input} {...field} disabled={input.disabled ?? field.disabled} value={field.value ?? null} onChange={field.onChange} />}
    </FormField>
  );
}

export function DateField<F extends FieldValues, N extends FieldPath<F>>({
  form,
  name,
  label,
  hint,
  required,
  className,
  min,
  max,
}: FieldBaseProps<F, N> & { min?: string; max?: string }) {
  return (
    <FormField form={form} name={name} label={label} hint={hint} required={required} className={className}>
      {(field) => <DateInput min={min} max={max} {...field} value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value)} />}
    </FormField>
  );
}

export function SelectField<F extends FieldValues, N extends FieldPath<F>>({
  form,
  name,
  label,
  hint,
  required,
  className,
  options,
  placeholder,
  disabled,
}: FieldBaseProps<F, N> & { options: readonly SelectOption[]; placeholder?: string; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <FormField form={form} name={name} label={label} hint={hint} required={required} className={className}>
      {(field) => (
        <Select
          {...field}
          disabled={disabled ?? field.disabled}
          options={options}
          placeholder={placeholder ?? t('common:form.selectPlaceholder')}
          value={field.value ?? ''}
          onChange={(e) => field.onChange(e.target.value || null)}
        />
      )}
    </FormField>
  );
}

export function ComboboxField<F extends FieldValues, N extends FieldPath<F>>({
  form,
  name,
  label,
  hint,
  required,
  className,
  onSelect,
  ...combobox
}: FieldBaseProps<F, N> & Omit<ComboboxProps, 'value' | 'onChange' | 'id' | 'name' | 'invalid' | 'onBlur'> & { onSelect?: ComboboxProps['onChange'] }) {
  return (
    <FormField form={form} name={name} label={label} hint={hint} required={required} className={className}>
      {(field) => (
        <Combobox
          {...combobox}
          id={field.id}
          name={field.name}
          value={field.value ?? null}
          invalid={field['aria-invalid']}
          aria-describedby={field['aria-describedby']}
          onBlur={field.onBlur}
          onChange={(value, option) => {
            field.onChange(value);
            onSelect?.(value, option);
          }}
        />
      )}
    </FormField>
  );
}

export function SwitchField<F extends FieldValues, N extends FieldPath<F>>({ form, name, label, hint, className }: Omit<FieldBaseProps<F, N>, 'required'>) {
  return (
    <FormField form={form} name={name} hint={hint} className={className}>
      {(field) => (
        <div className="flex min-h-11 items-center justify-between gap-3">
          <Label htmlFor={field.id}>{label}</Label>
          <Switch id={field.id} name={field.name} checked={Boolean(field.value)} onCheckedChange={field.onChange} onBlur={field.onBlur} disabled={field.disabled} />
        </div>
      )}
    </FormField>
  );
}

export function CheckboxField<F extends FieldValues, N extends FieldPath<F>>({ form, name, label, hint, className }: Omit<FieldBaseProps<F, N>, 'required'>) {
  return (
    <FormField form={form} name={name} hint={hint} className={className}>
      {(field) => (
        <div className="flex min-h-11 items-center gap-3">
          <Checkbox id={field.id} name={field.name} checked={Boolean(field.value)} onCheckedChange={(v) => field.onChange(v === true)} onBlur={field.onBlur} disabled={field.disabled} />
          <Label htmlFor={field.id}>{label}</Label>
        </div>
      )}
    </FormField>
  );
}
