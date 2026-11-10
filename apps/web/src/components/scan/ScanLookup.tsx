import { ScanBarcode, Search, SearchX } from 'lucide-react';
import { type ReactNode, type RefObject, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button, type ButtonProps, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui';
import { errorMessage } from '@/lib/query';
import { ScanDialog } from './ScanDialog';

export interface ScanOutcomeProps<T> {
  code: string;
  matches: T[];
  matchKey: (match: T) => string;
  renderMatch: (match: T) => ReactNode;
  onPick: (match: T) => void;
  /** Said when nothing carries the code, e.g. "No animal carries this code". */
  noneBody: ReactNode;
  /** Said above the list when several records carry the code. */
  severalBody: ReactNode;
}

/**
 * What a scan found when it did not find exactly one record: nothing, or several to choose from.
 * A scan never picks one of several by itself.
 */
export function ScanOutcome<T>({ code, matches, matchKey, renderMatch, onPick, noneBody, severalBody }: ScanOutcomeProps<T>) {
  if (matches.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-4 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-warning-soft text-warning">
          <SearchX className="size-6" aria-hidden />
        </span>
        <p className="max-w-full text-lg font-semibold break-all">{code}</p>
        <p className="max-w-md text-sm text-muted-foreground">{noneBody}</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{severalBody}</p>
      <ul className="space-y-2">
        {matches.map((match) => (
          <li key={matchKey(match)}>
            <button
              type="button"
              onClick={() => onPick(match)}
              className="focus-ring flex min-h-14 w-full items-center gap-3 rounded-xl border border-border bg-popover px-3 py-2 text-left hover:bg-muted"
            >
              {renderMatch(match)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface ScanLookupProps<T> extends Omit<ButtonProps, 'onClick' | 'children' | 'title'> {
  /** The exact lookup: every record that carries the code, none when none does. */
  lookup: (code: string) => Promise<T[]>;
  /** One record carries the code, or the person chose one of several. */
  onPick: (match: T, code: string) => void;
  matchKey: (match: T) => string;
  renderMatch: (match: T) => ReactNode;
  noneTitle: ReactNode;
  noneBody: ReactNode;
  severalTitle: ReactNode;
  severalBody: ReactNode;
  /** A way on when nothing carries the code: usually "search for it". */
  noneAction?: { label: ReactNode; onClick: (code: string) => void };
  label?: ReactNode;
  scanTitle?: ReactNode;
  scanDescription?: ReactNode;
  hint?: ReactNode;
  focusAfter?: RefObject<HTMLElement | null>;
}

/** Scan, look the code up exactly, and hand over the one record it names. */
export function ScanLookup<T>({
  lookup,
  onPick,
  matchKey,
  renderMatch,
  noneTitle,
  noneBody,
  severalTitle,
  severalBody,
  noneAction,
  label,
  scanTitle,
  scanDescription,
  hint,
  focusAfter,
  variant = 'outline',
  size,
  ...props
}: ScanLookupProps<T>) {
  const { t } = useTranslation('scan');
  const [scanning, setScanning] = useState(false);
  const [looking, setLooking] = useState(false);
  const [outcome, setOutcome] = useState<{ code: string; matches: T[] } | null>(null);
  // Set when the person chose one of several: the cursor then goes on to the next field, as after a plain scan.
  const chose = useRef(false);

  const onCode = async (code: string) => {
    setLooking(true);
    try {
      const matches = await lookup(code);
      if (matches.length === 1) onPick(matches[0]!, code);
      else setOutcome({ code, matches });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLooking(false);
    }
  };

  const none = outcome?.matches.length === 0;

  return (
    <>
      <Button
        variant={variant}
        size={size ?? (label ? 'md' : 'icon')}
        aria-label={label ? undefined : t('button')}
        title={label ? undefined : t('button')}
        loading={looking}
        {...props}
        onClick={() => setScanning(true)}
      >
        {!looking && <ScanBarcode aria-hidden />}
        {label}
      </Button>
      <ScanDialog
        open={scanning}
        onOpenChange={setScanning}
        onResult={(code) => void onCode(code)}
        title={scanTitle}
        description={scanDescription}
        hint={hint}
        focusAfter={focusAfter}
      />
      <Dialog open={outcome !== null} onOpenChange={(open) => !open && setOutcome(null)}>
        <DialogContent
          size="sm"
          onCloseAutoFocus={(event) => {
            const target = focusAfter?.current;
            const go = chose.current && target;
            chose.current = false;
            if (!go) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{none ? noneTitle : severalTitle}</DialogTitle>
            <DialogDescription className="sr-only">{none ? noneBody : severalBody}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {outcome && (
              <ScanOutcome
                code={outcome.code}
                matches={outcome.matches}
                matchKey={matchKey}
                renderMatch={renderMatch}
                noneBody={noneBody}
                severalBody={severalBody}
                onPick={(match) => {
                  const { code } = outcome;
                  chose.current = true;
                  setOutcome(null);
                  onPick(match, code);
                }}
              />
            )}
          </DialogBody>
          <DialogFooter>
            {none && noneAction && outcome && (
              <Button
                variant="outline"
                onClick={() => {
                  const { code } = outcome;
                  setOutcome(null);
                  noneAction.onClick(code);
                }}
              >
                <Search aria-hidden />
                {noneAction.label}
              </Button>
            )}
            <Button
              variant={none ? 'primary' : 'outline'}
              onClick={() => {
                setOutcome(null);
                setScanning(true);
              }}
            >
              <ScanBarcode aria-hidden />
              {t('again')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
