import { ScanBarcode } from 'lucide-react';
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, type ButtonProps, Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui';
import { IDLE, type ScanState, type Scanner, browserEnv, createScanner } from './scanner';
import { ScanView } from './ScanView';

/** How long "code read" stays on the screen before the dialog closes by itself. */
const FOUND_MS = 350;

/** The camera lives exactly as long as this is mounted: the dialog mounts it when it opens. */
function ScanSession({ onCode, hint }: { onCode: (code: string, typed: boolean) => void; hint?: ReactNode }) {
  const video = useRef<HTMLVideoElement>(null);
  const scanner = useRef<Scanner | null>(null);
  const deliver = useRef(onCode);
  const [state, setState] = useState<ScanState>(IDLE);

  useEffect(() => {
    deliver.current = onCode;
  }, [onCode]);

  useEffect(() => {
    const made = createScanner({
      env: browserEnv(),
      video: () => video.current,
      onState: setState,
      onResult: (code) => deliver.current(code, false),
    });
    scanner.current = made;
    void made.start();
    // A phone put in the pocket, or another tab: the camera goes off, and comes back with the page.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') made.stop();
      else if (made.state().phase !== 'found') void made.start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      made.stop();
      scanner.current = null;
    };
  }, []);

  return (
    <ScanView
      state={state}
      videoRef={video}
      hint={hint}
      onTorch={(on) => void scanner.current?.setTorch(on)}
      onRetry={() => void scanner.current?.start()}
      onManual={(code) => {
        scanner.current?.stop();
        deliver.current(code, true);
      }}
    />
  );
}

export interface ScanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The code read or typed, normalised (`normalizeScan`). Called once, as the dialog closes. */
  onResult: (code: string) => void;
  title?: ReactNode;
  description?: ReactNode;
  /** Said while the camera is looking, e.g. "the tag on the ear". */
  hint?: ReactNode;
  /** Where the cursor goes after a code was read: the next field to fill. Default: back to the button. */
  focusAfter?: RefObject<HTMLElement | null>;
}

/**
 * Reads one QR or bar code with the phone's back camera, or takes it typed. The camera is switched
 * off the moment a code is read, and whenever the dialog closes for any other reason.
 */
export function ScanDialog({ open, onOpenChange, onResult, title, description, hint, focusAfter }: ScanDialogProps) {
  const { t } = useTranslation('scan');
  const pending = useRef<{ code: string; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const delivered = useRef(false);

  const finish = useCallback(() => {
    const held = pending.current;
    if (!held) return;
    pending.current = null;
    if (held.timer !== null) clearTimeout(held.timer);
    delivered.current = true;
    onOpenChange(false);
    onResult(held.code);
  }, [onOpenChange, onResult]);

  const latestFinish = useRef(finish);
  useEffect(() => {
    latestFinish.current = finish;
  }, [finish]);

  useEffect(() => {
    if (open) delivered.current = false;
  }, [open]);

  // Gone from the screen with a code in hand that was never handed over: drop the timer.
  useEffect(
    () => () => {
      if (pending.current?.timer != null) clearTimeout(pending.current.timer);
      pending.current = null;
    },
    [],
  );

  const onCode = useCallback((code: string, typed: boolean) => {
    if (pending.current) return;
    pending.current = { code, timer: null };
    // What was typed needs no "code read" shown back; what the camera read is shown for a moment.
    if (typed) return latestFinish.current();
    pending.current.timer = setTimeout(() => latestFinish.current(), FOUND_MS);
  }, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closed by hand while "code read" was showing: the code still counts.
        if (!next && pending.current) return finish();
        onOpenChange(next);
      }}
    >
      <DialogContent
        size="sm"
        onCloseAutoFocus={(event) => {
          const target = focusAfter?.current;
          if (!delivered.current || !target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title ?? t('title')}</DialogTitle>
          <DialogDescription>{description ?? t('description')}</DialogDescription>
        </DialogHeader>
        <DialogBody>{open && <ScanSession onCode={onCode} hint={hint} />}</DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export interface ScanButtonProps extends Omit<ButtonProps, 'onClick' | 'children' | 'title'>, Pick<ScanDialogProps, 'onResult' | 'title' | 'description' | 'hint' | 'focusAfter'> {
  /** Shown beside the icon. Without it the button is the icon alone, named for screen readers. */
  label?: ReactNode;
}

/** The button that opens the scanner. 44 px even as an icon alone: it is pressed with gloves on. */
export function ScanButton({ onResult, title, description, hint, focusAfter, label, variant = 'outline', size, ...props }: ScanButtonProps) {
  const { t } = useTranslation('scan');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant={variant}
        size={size ?? (label ? 'md' : 'icon')}
        aria-label={label ? undefined : t('button')}
        title={label ? undefined : t('button')}
        {...props}
        onClick={() => setOpen(true)}
      >
        <ScanBarcode aria-hidden />
        {label}
      </Button>
      <ScanDialog open={open} onOpenChange={setOpen} onResult={onResult} title={title} description={description} hint={hint} focusAfter={focusAfter} />
    </>
  );
}
