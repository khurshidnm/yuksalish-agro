import { X } from 'lucide-react';
import { Dialog as RDialog } from 'radix-ui';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export const Sheet = RDialog.Root;
export const SheetTrigger = RDialog.Trigger;
export const SheetClose = RDialog.Close;
export const SheetTitle = RDialog.Title;
export const SheetDescription = RDialog.Description;

const SIDES = {
  left: 'data-[state=open]:animate-slide-in-left inset-y-0 left-0 h-dvh w-80 max-w-[86vw] border-r',
  right: 'data-[state=open]:animate-slide-in-right inset-y-0 right-0 h-dvh w-96 max-w-[92vw] border-l',
  bottom: 'data-[state=open]:animate-rise-in inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl border-t',
};

export interface SheetContentProps extends ComponentProps<typeof RDialog.Content> {
  side?: keyof typeof SIDES;
  hideClose?: boolean;
}

export function SheetContent({ side = 'right', hideClose, className, children, ...props }: SheetContentProps) {
  const { t } = useTranslation();
  return (
    <RDialog.Portal>
      <RDialog.Overlay className="data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in fixed inset-0 z-50 bg-black/50" />
      <RDialog.Content
        className={cn('fixed z-50 flex flex-col border-border bg-card text-card-foreground shadow-pop outline-none', SIDES[side], className)}
        {...props}
      >
        {children}
        {!hideClose && (
          <RDialog.Close
            aria-label={t('common:actions.close')}
            className="focus-ring absolute top-2 right-2 flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-5" aria-hidden />
          </RDialog.Close>
        )}
      </RDialog.Content>
    </RDialog.Portal>
  );
}
