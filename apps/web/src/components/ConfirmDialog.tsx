import { AlertDialog } from 'radix-ui';
import { type ReactNode, createContext, useCallback, useContext, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui';

export interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  /** Red confirm button for deletes and other irreversible actions. */
  destructive?: boolean;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<unknown>;
  loading?: boolean;
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, cancelLabel, destructive, onConfirm, loading }: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="data-[state=open]:animate-fade-in fixed inset-0 z-50 bg-black/50" />
        <AlertDialog.Content className="data-[state=open]:animate-rise-in sm:data-[state=open]:animate-pop-in fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border border-border bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-card-foreground shadow-pop sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-[calc(100vw-2rem)] sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:p-5">
          <AlertDialog.Title className="text-lg font-semibold">{title}</AlertDialog.Title>
          {description ? (
            <AlertDialog.Description className="mt-1 text-sm text-muted-foreground">{description}</AlertDialog.Description>
          ) : (
            <AlertDialog.Description className="sr-only">{title}</AlertDialog.Description>
          )}
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialog.Cancel asChild>
              <Button variant="outline">{cancelLabel ?? t('common:actions.cancel')}</Button>
            </AlertDialog.Cancel>
            <Button
              variant={destructive ? 'destructive' : 'primary'}
              loading={loading}
              onClick={() => void onConfirm()}
            >
              {confirmLabel ?? t(destructive ? 'common:actions.delete' : 'common:actions.confirm')}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [open, setOpen] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((next) => {
    resolver.current?.(false);
    setOptions(next);
    setOpen(true);
    return new Promise((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpen(false);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {options && <ConfirmDialog {...options} open={open} onOpenChange={(next) => !next && settle(false)} onConfirm={() => settle(true)} />}
    </ConfirmContext.Provider>
  );
}

/** `if (await confirm({ title, destructive: true })) remove()` */
export function useConfirm(): ConfirmFn {
  const value = useContext(ConfirmContext);
  if (!value) throw new Error('useConfirm must be used inside ConfirmProvider');
  return value;
}
