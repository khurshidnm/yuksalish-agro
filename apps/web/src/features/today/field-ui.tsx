/**
 * Controls for people in gloves, in sun, on cheap phones: 56 px targets, large type, high contrast,
 * and the main action within thumb reach.
 */
import { ArrowLeft, Camera, Check, Minus, Plus, Search, X, type LucideIcon } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Button, NumberInput, Skeleton } from '@/components/ui';
import { compressImage } from '@/features/livestock/shared';
import { cn } from '@/lib/utils';
import { matchAnimals, stepDown, stepUp, type DirectoryAnimal } from './logic';

/** Small enough to wait in the queue and to survive a poor upload. */
const PHOTO_MAX_SIDE = 1280;
const PHOTO_QUALITY = 0.7;

export function FieldScreen({ title, subtitle, backTo = '/today', children }: { title: string; subtitle?: string; backTo?: string; children: ReactNode }) {
  const { t } = useTranslation('today');
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <header className="flex items-center gap-2">
        <Link
          to={backTo}
          aria-label={t('common.back')}
          className="focus-ring -ml-2 flex size-14 shrink-0 items-center justify-center rounded-xl text-foreground hover:bg-muted"
        >
          <ArrowLeft className="size-7" aria-hidden />
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl leading-tight font-bold break-words">{title}</h1>
          {subtitle && <p className="text-base text-muted-foreground">{subtitle}</p>}
        </div>
      </header>
      {children}
    </div>
  );
}

export function FieldSkeleton() {
  return (
    <div aria-hidden className="mx-auto flex w-full max-w-xl flex-col gap-3">
      <Skeleton className="h-14 w-full rounded-xl" />
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-32 w-full rounded-xl" />
    </div>
  );
}

/**
 * Sits above the bottom navigation, so saving never needs a scroll to the end. Opaque, because the
 * disabled button is see-through and the form scrolls under it.
 */
export function SaveBar({ label, onClick, disabled, busy }: { label: string; onClick: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <div className="sticky bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-10 -mx-1 rounded-2xl bg-background p-1 lg:bottom-4">
      <Button size="lg" className="min-h-16 w-full rounded-xl text-lg" onClick={onClick} disabled={disabled} loading={busy}>
        <Check aria-hidden className="size-6!" />
        {label}
      </Button>
    </div>
  );
}

export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="text-base font-semibold">
      {children}
    </label>
  );
}

interface StepperProps {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  step: number;
  unit: string;
  hint?: ReactNode;
  children?: ReactNode;
  invalid?: boolean;
}

export function Stepper({ label, value, onChange, step, unit, hint, children, invalid }: StepperProps) {
  const { t } = useTranslation('today');
  const buttonClass =
    'focus-ring flex size-14 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground hover:bg-secondary-hover active:bg-primary active:text-primary-foreground';
  return (
    <div className={cn('rounded-xl border bg-card p-3', invalid ? 'border-destructive' : 'border-border')}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-base font-semibold">{label}</span>
        {hint && <span className="text-sm text-muted-foreground">{hint}</span>}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className={buttonClass} aria-label={t('common.less', { label })} onClick={() => onChange(stepDown(value, step))}>
          <Minus className="size-7" aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <NumberInput
            value={value}
            onChange={onChange}
            suffix={unit}
            aria-label={label}
            aria-invalid={invalid || undefined}
            className="h-14 text-center text-xl font-semibold normal-nums"
            // Tap, then type the new amount. After the frame, because the field rewrites its text on focus.
            onFocus={(event) => {
              const input = event.currentTarget;
              requestAnimationFrame(() => input.select());
            }}
          />
        </div>
        <button type="button" className={buttonClass} aria-label={t('common.more', { label })} onClick={() => onChange(stepUp(value, step))}>
          <Plus className="size-7" aria-hidden />
        </button>
      </div>
      {children}
    </div>
  );
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

export function ChoiceButtons<T extends string>({
  label,
  options,
  value,
  onChange,
  columns = 2,
}: {
  label: string;
  options: Choice<T>[];
  value: T | null;
  onChange: (value: T) => void;
  columns?: 2 | 3;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('grid gap-2', columns === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
      {options.map((option) => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'focus-ring flex min-h-16 items-center justify-center gap-2 rounded-xl border-2 px-2 text-base font-semibold',
              selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card text-foreground hover:bg-muted',
            )}
          >
            {Icon && <Icon className="size-6 shrink-0" aria-hidden />}
            <span className="min-w-0 break-words">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Tap a common phrase rather than type with gloves on. */
export function QuickPhrases({ phrases, onPick }: { phrases: string[]; onPick: (phrase: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {phrases.map((phrase) => (
        <button
          key={phrase}
          type="button"
          onClick={() => onPick(phrase)}
          className="focus-ring min-h-14 rounded-full border-2 border-input bg-card px-4 text-base font-medium hover:bg-muted"
        >
          {phrase}
        </button>
      ))}
    </div>
  );
}

export interface LocalPhoto {
  key: string;
  name: string;
  blob: Blob;
  url: string;
}

/** Takes photos and keeps them on the phone. They upload with the record they belong to. */
export function PhotoCapture({ photos, onChange, max = 3 }: { photos: LocalPhoto[]; onChange: (photos: LocalPhoto[]) => void; max?: number }) {
  const { t } = useTranslation('today');
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const current = useRef(photos);
  current.current = photos;
  useEffect(() => () => current.current.forEach((photo) => URL.revokeObjectURL(photo.url)), []);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const compressed = await compressImage(file, PHOTO_MAX_SIDE, PHOTO_QUALITY);
      onChange([
        ...photos,
        { key: `${Date.now()}-${photos.length}`, name: compressed.name, blob: compressed, url: URL.createObjectURL(compressed) },
      ]);
    } catch {
      toast.error(t('photo.failed'));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        data-testid="photo-input"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      {photos.length > 0 && (
        <div className="flex flex-wrap gap-5 pt-3 pr-3">
          {photos.map((photo) => (
            <div key={photo.key} className="relative">
              <img src={photo.url} alt="" className="size-28 rounded-xl border border-border object-cover" />
              <button
                type="button"
                aria-label={t('photo.remove')}
                className="focus-ring absolute -top-3 -right-3 flex size-14 items-center justify-center rounded-full bg-foreground text-background"
                onClick={() => {
                  URL.revokeObjectURL(photo.url);
                  onChange(photos.filter((p) => p.key !== photo.key));
                }}
              >
                <X className="size-6" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
      {photos.length < max && (
        <Button variant="outline" size="lg" className="min-h-14 w-full" loading={busy} onClick={() => input.current?.click()}>
          <Camera aria-hidden className="size-6!" />
          {t('photo.take')}
        </Button>
      )}
    </div>
  );
}

interface AnimalPickerProps {
  animals: DirectoryAnimal[];
  value: DirectoryAnimal | null;
  onChange: (animal: DirectoryAnimal | null) => void;
  /** Called as the person types, for forms that can send a tag the phone does not know. */
  onTextChange?: (text: string) => void;
  label?: string;
}

/** Find an animal by the number on its ear tag, from the list stored on this phone. */
export function AnimalPicker({ animals, value, onChange, onTextChange, label }: AnimalPickerProps) {
  const { t } = useTranslation('today');
  const [query, setQuery] = useState('');
  const matches = matchAnimals(animals, query);

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-xl border-2 border-primary bg-card p-3">
        <div className="min-w-0 flex-1">
          <p className="text-xl font-bold break-words">{value.tag}</p>
          <p className="text-sm text-muted-foreground">
            {t(`enums:animalCategory.${value.category}`)} · {t(`enums:animalStatus.${value.status}`)}
          </p>
        </div>
        <Button variant="outline" size="lg" className="min-h-14" onClick={() => onChange(null)}>
          {t('animal.change')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <FieldLabel htmlFor="animal-search">{label ?? t('animal.label')}</FieldLabel>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-6 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          id="animal-search"
          type="search"
          autoComplete="off"
          enterKeyHint="search"
          value={query}
          placeholder={t('animal.placeholder')}
          onChange={(e) => {
            setQuery(e.target.value);
            onTextChange?.(e.target.value);
          }}
          className="focus-ring h-14 w-full rounded-xl border-2 border-input bg-card pr-3 pl-11 text-xl font-semibold placeholder:text-base placeholder:font-normal placeholder:text-muted-foreground"
        />
      </div>
      {matches.map((animal) => (
        <button
          key={animal.id}
          type="button"
          onClick={() => {
            onChange(animal);
            setQuery('');
          }}
          className="focus-ring flex min-h-14 items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-2 text-left hover:bg-muted"
        >
          <span className="text-lg font-semibold break-words">{animal.tag}</span>
          <span className="shrink-0 text-sm text-muted-foreground">{t(`enums:animalCategory.${animal.category}`)}</span>
        </button>
      ))}
      {query.trim() !== '' && matches.length === 0 && <p className="text-base text-muted-foreground">{t('animal.notFound')}</p>}
    </div>
  );
}
