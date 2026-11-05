import { Command } from 'cmdk';
import { Check, ChevronsUpDown, Loader2, X } from 'lucide-react';
import { Popover } from 'radix-ui';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type QueryParams } from '@/lib/api';
import { cn } from '@/lib/utils';
import { controlClasses } from './input';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Secondary line: tag number, unit, balance. */
  hint?: string;
  disabled?: boolean;
  /** Original record, handed back to onChange. */
  raw?: unknown;
}

export interface ComboboxProps {
  value: string | null | undefined;
  onChange: (value: string | null, option: ComboboxOption | null) => void;
  /** Static options, filtered locally. */
  options?: readonly ComboboxOption[];
  /** Async options, called with the search text. Use for long lists. */
  loadOptions?: (search: string) => Promise<ComboboxOption[]>;
  /** Label for a value not in the loaded options, e.g. when editing a record. */
  selectedLabel?: string | null;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  clearable?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  name?: string;
  className?: string;
  onBlur?: () => void;
  'aria-describedby'?: string;
  'aria-labelledby'?: string;
  renderOption?: (option: ComboboxOption) => ReactNode;
}

/** Searchable select for long lists: items, animals, counterparties. */
export function Combobox({
  value,
  onChange,
  options,
  loadOptions,
  selectedLabel,
  placeholder,
  searchPlaceholder,
  emptyText,
  clearable = true,
  disabled,
  invalid,
  id,
  name,
  className,
  onBlur,
  renderOption,
  ...aria
}: ComboboxProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [remote, setRemote] = useState<ComboboxOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<ComboboxOption | null>(null);
  const listId = useId();
  const loaderRef = useRef(loadOptions);
  loaderRef.current = loadOptions;
  const isAsync = Boolean(loadOptions);

  useEffect(() => {
    if (!open || !isAsync) return;
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const next = await loaderRef.current!(search);
        if (!cancelled) setRemote(next);
      } catch {
        if (!cancelled) setRemote([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, search, isAsync]);

  const list = useMemo(() => (isAsync ? remote : (options ?? [])), [isAsync, remote, options]);
  const current = list.find((o) => o.value === value) ?? (picked?.value === value ? picked : null);
  const label = current?.label ?? selectedLabel ?? null;

  // A form can fill the value itself, such as an item's default warehouse: the name is in the list.
  useEffect(() => {
    if (!isAsync || !value || label) return;
    let cancelled = false;
    loaderRef.current!('')
      .then((next) => {
        if (!cancelled) setRemote(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isAsync, value, label]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setSearch('');
          onBlur?.();
        }
      }}
    >
      <div className="relative">
        <Popover.Trigger asChild>
          <button
            type="button"
            id={id}
            name={name}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-invalid={invalid || undefined}
            disabled={disabled}
            className={cn(controlClasses, 'flex items-center justify-between gap-2 pr-10 text-left', clearable && value && 'pr-16', className)}
            {...aria}
          >
            <span className={cn('truncate', !label && 'text-muted-foreground')}>{label ?? placeholder ?? t('common:form.selectPlaceholder')}</span>
          </button>
        </Popover.Trigger>
        {clearable && value && !disabled && (
          <button
            type="button"
            aria-label={t('common:actions.clear')}
            className="focus-ring absolute top-1/2 right-9 flex size-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            onClick={() => {
              setPicked(null);
              onChange(null, null);
            }}
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
        <ChevronsUpDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      </div>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="data-[state=open]:animate-pop-in z-[60] w-[var(--radix-popover-trigger-width)] min-w-64 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-pop"
        >
          <Command shouldFilter={!isAsync} loop>
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder={searchPlaceholder ?? t('common:form.searchPlaceholder')}
              className="min-h-11 w-full border-b border-border bg-transparent px-3 text-base outline-none placeholder:text-muted-foreground md:text-sm"
            />
            <Command.List id={listId} className="max-h-72 overflow-y-auto p-1">
              {loading && (
                <div className="flex items-center justify-center p-4 text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" aria-label={t('common:status.loading')} />
                </div>
              )}
              {!loading && <Command.Empty className="p-4 text-center text-sm text-muted-foreground">{emptyText ?? t('common:form.noOptions')}</Command.Empty>}
              {!loading &&
                list.map((option) => (
                  <Command.Item
                    key={option.value}
                    value={`${option.label} ${option.hint ?? ''} ${option.value}`}
                    disabled={option.disabled}
                    onSelect={() => {
                      setPicked(option);
                      onChange(option.value, option);
                      setOpen(false);
                      setSearch('');
                    }}
                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-disabled:opacity-50 data-[selected=true]:bg-muted"
                  >
                    <Check className={cn('size-4 shrink-0', option.value === value ? 'opacity-100' : 'opacity-0')} aria-hidden />
                    {renderOption ? (
                      renderOption(option)
                    ) : (
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{option.label}</span>
                        {option.hint && <span className="block truncate text-xs text-muted-foreground">{option.hint}</span>}
                      </span>
                    )}
                  </Command.Item>
                ))}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Loader for a Combobox backed by a list endpoint:
 * loadOptions={apiOptions<Item>('/inventory/items', (i) => ({ value: i.id, label: i.name }), { category: 'feed' })}
 */
export function apiOptions<T>(path: string, toOption: (row: T) => ComboboxOption, params?: QueryParams) {
  return async (search: string): Promise<ComboboxOption[]> => {
    const { data } = await api.list<T>(path, { ...params, search, pageSize: 30 });
    return data.map((row) => ({ raw: row, ...toOption(row) }));
  };
}
