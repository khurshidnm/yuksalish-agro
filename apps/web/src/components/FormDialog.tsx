import { zodResolver } from '@hookform/resolvers/zod';
import { type ReactNode, useEffect, useState } from 'react';
import { type DefaultValues, type FieldValues, type Path, type UseFormReturn, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/query';
import { Alert, Button, Dialog, DialogBody, DialogContent, type DialogContentProps, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui';

export interface FormDialogProps<S extends z.ZodType<FieldValues, FieldValues>> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  schema: S;
  /** Applied every time the dialog opens: pass the record when editing. */
  defaultValues: DefaultValues<z.input<S>>;
  /** Receives validated, transformed values. A thrown ApiError is displayed in the form. */
  onSubmit: (values: z.output<S>) => Promise<unknown> | unknown;
  submitLabel?: ReactNode;
  /** i18n key or text for the success toast. */
  successMessage?: string;
  size?: DialogContentProps['size'];
  children: (form: UseFormReturn<z.input<S>, unknown, z.output<S>>) => ReactNode;
}

/**
 * A form in a dialog: bottom sheet on phones, with validation, submit state and server errors.
 * Field errors in `error.details.fieldErrors` land on their inputs; anything else shows at the top.
 */
export function FormDialog<S extends z.ZodType<FieldValues, FieldValues>>({
  open,
  onOpenChange,
  title,
  description,
  schema,
  defaultValues,
  onSubmit,
  submitLabel,
  successMessage,
  size,
  children,
}: FormDialogProps<S>) {
  const { t } = useTranslation();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<z.input<S>, unknown, z.output<S>>({
    // The resolver's generics cannot follow a schema type parameter.
    resolver: zodResolver(schema as never) as never,
    defaultValues,
  });

  useEffect(() => {
    if (open) {
      form.reset(defaultValues);
      setServerError(null);
    }
    // Only opening resets: an inline `defaultValues` object changes identity on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      await onSubmit(values);
      if (successMessage) toast.success(t(successMessage));
      onOpenChange(false);
    } catch (error) {
      if (error instanceof ApiError) {
        for (const [field, message] of Object.entries(error.fieldErrors)) {
          // `_` is the API's key for an error on the whole form: the banner covers it.
          if (field !== '_') form.setError(field as Path<z.input<S>>, { type: 'server', message });
        }
      }
      setServerError(errorMessage(error));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size={size}>
        <form onSubmit={(e) => void submit(e)} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className={description ? undefined : 'sr-only'}>{description ?? title}</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            {serverError && <Alert tone="danger">{serverError}</Alert>}
            {children(form)}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              {submitLabel ?? t('common:actions.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Two columns on wide dialogs, one on phones. */
export function FormGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>;
}
