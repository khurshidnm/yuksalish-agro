import { zodResolver } from '@hookform/resolvers/zod';
import { Check, Copy } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { type DefaultValues, type FieldValues, type Path, type UseFormReturn, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Alert, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/query';

/**
 * An Uzbek number as people write it, '+998 90 123 45 67', the shape the phone field asks for.
 * Anything else is shown as stored.
 */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  const match = /^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(phone.replace(/[\s()-]/g, ''));
  return match ? `+998 ${match[1]} ${match[2]} ${match[3]} ${match[4]}` : phone;
}

export interface ShowOnceDialogProps {
  /** The value to reveal; null keeps the dialog closed. */
  secret: string | null;
  title: ReactNode;
  description?: ReactNode;
  /** Label above the value. */
  label: ReactNode;
  onClose: () => void;
}

/**
 * A password, key or secret the server will never show again. Clicking outside does not close
 * it: losing the value by accident means generating a new one.
 */
export function ShowOnceDialog({ secret, title, description, label, onClose }: ShowOnceDialogProps) {
  const { t } = useTranslation('settings');
  const [copied, setCopied] = useState(false);

  useEffect(() => setCopied(false), [secret]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret ?? '');
      setCopied(true);
    } catch {
      toast.error(t('showOnce.copyFailed'));
    }
  };

  return (
    <Dialog open={secret !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm" hideClose onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={description ? undefined : 'sr-only'}>{description ?? title}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <Alert tone="warning">{t('showOnce.warning')}</Alert>
          <div>
            <p className="mb-1.5 text-sm font-medium">{label}</p>
            <div className="flex items-stretch gap-2">
              <code className="min-w-0 flex-1 rounded-lg border border-border bg-muted px-3 py-2.5 font-mono text-sm break-all select-all">{secret}</code>
              <Button variant="outline" size="icon" onClick={() => void copy()} aria-label={t('showOnce.copy')}>
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              </Button>
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>{t('showOnce.saved')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface InlineFormProps<S extends z.ZodType<FieldValues, FieldValues>> {
  schema: S;
  /** Current values. The form resets when this object changes. */
  values: DefaultValues<z.input<S>>;
  onSubmit: (values: z.output<S>) => Promise<unknown>;
  /** Show the values without a way to save them. */
  readOnly?: boolean;
  children: (form: UseFormReturn<z.input<S>, unknown, z.output<S>>) => ReactNode;
}

/** A form on the page itself, for settings that are read more often than edited. */
export function InlineForm<S extends z.ZodType<FieldValues, FieldValues>>({ schema, values, onSubmit, readOnly, children }: InlineFormProps<S>) {
  const { t } = useTranslation();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<z.input<S>, unknown, z.output<S>>({
    // The resolver's generics cannot follow a schema type parameter.
    resolver: zodResolver(schema as never) as never,
    defaultValues: values,
  });

  useEffect(() => {
    form.reset(values);
    // `form` is stable; only new server values should reset the fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  const submit = form.handleSubmit(async (next) => {
    setServerError(null);
    try {
      await onSubmit(next);
      toast.success(t('common:toast.saved'));
    } catch (error) {
      if (error instanceof ApiError) {
        for (const [field, message] of Object.entries(error.fieldErrors)) {
          if (field !== '_') form.setError(field as Path<z.input<S>>, { type: 'server', message });
        }
      }
      setServerError(errorMessage(error));
    }
  });

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
      {serverError && <Alert tone="danger">{serverError}</Alert>}
      <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-4">
        {children(form)}
      </fieldset>
      {!readOnly && (
        <div className="flex justify-end">
          <Button type="submit" loading={form.formState.isSubmitting} disabled={!form.formState.isDirty}>
            {t('common:actions.save')}
          </Button>
        </div>
      )}
    </form>
  );
}

/** Any stored value as readable text. */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Short-form label for a role: system roles are translated, custom ones keep their name. */
export function useRoleLabel() {
  const { t } = useTranslation();
  return (role: { key: string; name: string }) => t(`enums:role.${role.key}`, { defaultValue: role.name });
}
