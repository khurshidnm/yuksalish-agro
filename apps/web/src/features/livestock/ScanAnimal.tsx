import type { AnimalStatus } from '@yap/shared';
import { type ReactNode, type RefObject, useState } from 'react';
import type { FieldPath, FieldValues, UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormField, ScanLookup } from '@/components';
import { type ButtonProps, Combobox, type ComboboxOption } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { StatusBadge } from './shared';

/** One animal that carries a scanned code: GET /livestock/animals/by-code. No money, no person. */
export interface ScannedAnimal {
  id: string;
  tag: string;
  status: AnimalStatus;
  onFarm: boolean;
  herdId: string | null;
  herdName: string | null;
  category: string;
  sex: string;
  speciesKey: string | null;
  birthDate: string | null;
  /** 'tag', or the kind of identifier that carried the code: 'rfid', 'qr', 'ear_tag'. */
  matchedBy: string;
  exact: boolean;
}

export const BY_CODE_PATH = '/livestock/animals/by-code';

export function animalsByCode(code: string): Promise<ScannedAnimal[]> {
  return api.get<ScannedAnimal[]>(BY_CODE_PATH, { code });
}

/** One line of the "which animal?" list. */
export function ScannedAnimalLine({ animal }: { animal: ScannedAnimal }) {
  const { t } = useTranslation('scan');
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-lg font-semibold tabular-nums">{animal.tag}</span>
        <span className="block truncate text-sm text-muted-foreground">
          {[t(`enums:animalCategory.${animal.category}`), animal.herdName].filter(Boolean).join(' · ')}
        </span>
      </span>
      {!animal.onFarm && <StatusBadge status={animal.status} />}
    </>
  );
}

export interface ScanAnimalButtonProps extends Omit<ButtonProps, 'onClick' | 'children' | 'title'> {
  onPick: (animal: ScannedAnimal) => void;
  /** Offered when no animal carries the code: usually a search of the list for it. */
  onSearch?: (code: string) => void;
  /** Refuse an animal that has left the farm, and say so. For forms that record work on a live animal. */
  onFarmOnly?: boolean;
  label?: ReactNode;
  focusAfter?: RefObject<HTMLElement | null>;
}

/**
 * Scans a tag and hands over the animal that carries it. The lookup is exact: no animal means "not
 * found", and two animals means the person chooses. Shown only to those who may see animals.
 */
export function ScanAnimalButton({ onPick, onSearch, onFarmOnly, label, focusAfter, ...props }: ScanAnimalButtonProps) {
  const { t } = useTranslation('scan');
  const canView = usePermission('livestock.view');
  if (!canView) return null;
  return (
    <ScanLookup<ScannedAnimal>
      {...props}
      label={label}
      focusAfter={focusAfter}
      lookup={animalsByCode}
      onPick={(animal) => {
        if (onFarmOnly && !animal.onFarm) return void toast.error(t('animal.offFarm', { tag: animal.tag }));
        onPick(animal);
      }}
      matchKey={(animal) => animal.id}
      renderMatch={(animal) => <ScannedAnimalLine animal={animal} />}
      scanTitle={t('animal.title')}
      hint={t('animal.hint')}
      noneTitle={t('animal.noneTitle')}
      noneBody={t('animal.noneBody')}
      severalTitle={t('animal.severalTitle')}
      severalBody={t('animal.severalBody')}
      noneAction={onSearch ? { label: t('animal.search'), onClick: onSearch } : undefined}
    />
  );
}

/**
 * The animal dropdown of a form, with a scan button beside it. Scanning fills the same value the
 * dropdown would, so the form and its checks do not change.
 */
export function AnimalPickerField<F extends FieldValues, N extends FieldPath<F>>({
  form,
  name,
  label,
  hint,
  required,
  className,
  loadOptions,
  selectedLabel,
}: {
  form: UseFormReturn<F>;
  name: N;
  label?: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  className?: string;
  loadOptions: (search: string) => Promise<ComboboxOption[]>;
  selectedLabel?: string | null;
}) {
  // The dropdown knows the names of the animals it has listed; a scanned one may not be among them.
  const [scanned, setScanned] = useState<ScannedAnimal | null>(null);
  return (
    <FormField form={form} name={name} label={label} hint={hint} required={required} className={className}>
      {(field) => (
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <Combobox
              id={field.id}
              name={field.name}
              value={field.value ?? null}
              invalid={field['aria-invalid']}
              aria-describedby={field['aria-describedby']}
              onBlur={field.onBlur}
              onChange={(value) => field.onChange(value)}
              loadOptions={loadOptions}
              selectedLabel={scanned && scanned.id === field.value ? scanned.tag : selectedLabel}
            />
          </div>
          <ScanAnimalButton
            onFarmOnly
            disabled={field.disabled}
            onPick={(animal) => {
              setScanned(animal);
              field.onChange(animal.id);
            }}
          />
        </div>
      )}
    </FormField>
  );
}
