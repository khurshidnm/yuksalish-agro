import { normalizeScan, SCAN_CODE_MAX } from '@yap/shared/formulas/scan-code';
import { Camera, CameraOff, CheckCircle2, Flashlight, FlashlightOff, Loader2, LockKeyhole, type LucideIcon, RefreshCw, ShieldAlert } from 'lucide-react';
import { type FormEvent, type ReactNode, type Ref, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Label } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { ScanPhase, ScanState } from './scanner';

const ICONS: Record<ScanPhase, LucideIcon> = {
  idle: Camera,
  asking: Loader2,
  denied: ShieldAlert,
  insecure: LockKeyhole,
  no_camera: CameraOff,
  busy: CameraOff,
  failed: CameraOff,
  searching: Camera,
  found: CheckCircle2,
};

/** Phases a second try can cure. A page without HTTPS stays without it. */
const RETRY: ScanPhase[] = ['denied', 'no_camera', 'busy', 'failed'];

export interface ScanViewProps {
  state: ScanState;
  videoRef?: Ref<HTMLVideoElement>;
  onTorch?: (on: boolean) => void;
  onRetry?: () => void;
  /** A code typed by hand, already normalised. */
  onManual: (code: string) => void;
  /** What to point the camera at, when the place of use can say it better than "a code". */
  hint?: ReactNode;
}

/**
 * Everything the scan dialog shows, for every state of the camera. It holds no camera itself, so
 * each state can be drawn (and tested) on its own. The typing field is there in all of them: a
 * refused or missing camera must never leave the person without a way to enter the code.
 */
export function ScanView({ state, videoRef, onTorch, onRetry, onManual, hint }: ScanViewProps) {
  const { t } = useTranslation('scan');
  const fieldId = useId();
  const [typed, setTyped] = useState('');
  const [invalid, setInvalid] = useState(false);

  const { phase } = state;
  const live = phase === 'searching';
  const Icon = ICONS[phase];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // A form inside a form's dialog must not submit the form behind it.
    event.stopPropagation();
    const code = normalizeScan(typed);
    if (code === null) return setInvalid(true);
    onManual(code);
  };

  return (
    <div className="space-y-3" data-scan-phase={phase}>
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-black text-white">
        {/* playsInline: without it iOS opens the picture full screen and the frame is lost. */}
        <video ref={videoRef} className={cn('size-full object-cover', !live && 'invisible')} playsInline muted autoPlay aria-hidden />
        {live ? (
          <>
            <div aria-hidden className="pointer-events-none absolute inset-[12%] rounded-2xl border-2 border-white/80" />
            {state.torch !== null && onTorch && (
              <button
                type="button"
                aria-pressed={state.torch}
                aria-label={t(state.torch ? 'torchOff' : 'torchOn')}
                onClick={() => onTorch(!state.torch)}
                className={cn(
                  'focus-ring absolute right-2 bottom-2 flex size-12 items-center justify-center rounded-full',
                  state.torch ? 'bg-white text-black' : 'bg-black/60 text-white',
                )}
              >
                {state.torch ? <FlashlightOff className="size-6" aria-hidden /> : <Flashlight className="size-6" aria-hidden />}
              </button>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
            <Icon className={cn('size-10', phase === 'asking' && 'animate-spin')} aria-hidden />
            {phase === 'found' && <p className="max-w-full text-xl font-semibold break-all">{state.code}</p>}
          </div>
        )}
      </div>

      <div role="status" aria-live="polite" className="space-y-1">
        <p className="font-semibold">{t(`state.${phase}.title`)}</p>
        <p className="text-sm text-muted-foreground">{phase === 'searching' && hint ? hint : t(`state.${phase}.body`)}</p>
      </div>

      {RETRY.includes(phase) && onRetry && (
        <Button variant="outline" className="w-full" onClick={onRetry}>
          <RefreshCw aria-hidden />
          {t('retry')}
        </Button>
      )}

      <form onSubmit={submit} noValidate className="space-y-1.5 border-t border-border pt-3">
        <Label htmlFor={fieldId}>{t('manual.label')}</Label>
        <div className="flex gap-2">
          <Input
            id={fieldId}
            className="min-w-0 flex-1"
            autoComplete="off"
            autoCapitalize="characters"
            enterKeyHint="done"
            maxLength={SCAN_CODE_MAX}
            placeholder={t('manual.placeholder')}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${fieldId}-problem` : undefined}
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
              setInvalid(false);
            }}
          />
          <Button type="submit" variant="secondary">
            {t('manual.submit')}
          </Button>
        </div>
        {invalid && (
          <p id={`${fieldId}-problem`} role="alert" className="text-sm text-destructive">
            {t('manual.invalid', { max: SCAN_CODE_MAX })}
          </p>
        )}
      </form>
    </div>
  );
}
