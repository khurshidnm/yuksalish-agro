import { X } from 'lucide-react';
import { Dialog as RDialog } from 'radix-ui';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export const Dialog = RDialog.Root;
export const DialogTrigger = RDialog.Trigger;
export const DialogClose = RDialog.Close;

const SIZES = { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' };

export interface DialogContentProps extends ComponentProps<typeof RDialog.Content> {
  size?: keyof typeof SIZES;
  hideClose?: boolean;
}

/** Bottom sheet on phones, centred dialog from `sm`. Compose with DialogHeader, DialogBody, DialogFooter. */
export function DialogContent({ className, size = 'md', hideClose, children, ...props }: DialogContentProps) {
  const { t } = useTranslation();
  return (
    <RDialog.Portal>
      <RDialog.Overlay className="data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in fixed inset-0 z-50 bg-black/50" />
      <RDialog.Content
        className={cn(
          'data-[state=open]:animate-rise-in sm:data-[state=open]:animate-pop-in fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-2xl border border-border bg-card text-card-foreground shadow-pop outline-none sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[86dvh] sm:w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl',
          SIZES[size],
          className,
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <RDialog.Close
            aria-label={t('common:actions.close')}
            className="focus-ring absolute top-2 right-2 flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
          >
            <X className="size-5" aria-hidden />
          </RDialog.Close>
        )}
      </RDialog.Content>
    </RDialog.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex shrink-0 flex-col gap-1 border-b border-border p-4 pr-14', className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof RDialog.Title>) {
  return <RDialog.Title className={cn('text-lg font-semibold', className)} {...props} />;
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof RDialog.Description>) {
  return <RDialog.Description className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

/** The scrolling middle of a dialog. */
export function DialogBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto p-4', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex shrink-0 flex-col-reverse gap-2 border-t border-border p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end sm:pb-4',
        className,
      )}
      {...props}
    />
  );
}
