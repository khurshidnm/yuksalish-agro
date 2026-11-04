# Web app

React 19, Vite, Tailwind 4. Conventions are in the root `CLAUDE.md`; this is the working reference for
building a page. `features/finance/CounterpartiesPage.tsx` is the example to copy.

## Adding a page

Every route already exists with a stub. Replace `features/<group>/<Name>Page.tsx`; it must stay the file's
default export. The router and `app/nav.ts` do not need changing. For a new sub-route, add a line to
`features/<group>/routes.tsx`:

```tsx
{ path: 'finance/loans/:id', element: page(() => import('./LoanCardPage'), 'finance.view') }
```

Strings go in `packages/shared/src/i18n/locales/{uz,ru,en}/<namespace>.json`. A test fails if the three
languages disagree. Uzbek Cyrillic is derived, so do not write it.

```tsx
const { t } = useTranslation('livestock');
t('animals.title');              // own namespace
t('common:actions.save');        // another namespace
t(`enums:animalStatus.${value}`);
```

**API errors:** add `errors.<CODE>` to your namespace and `errorMessage()` finds it. Without it, users see
the API's English fallback. Plain-object `details` work as placeholders: `"{{available}} kg qoldi"`.

## Imports

```tsx
import { DataTable, FormDialog, PageHeader, ... } from '@/components';   // composites + UI kit
import { ChartCard } from '@/components/ChartCard';                      // never from the barrel
```

## Composites

| Component | Props |
| --- | --- |
| `PageHeader` | `title, description?, actions?, back?: { to, label }` |
| `DataTable<T>` | `path, columns, params?, searchable?, searchPlaceholder?, filters?, defaultSort?, pageSize?, urlPrefix?, empty?, rowKey?, rowActions?, rowHref?, onRowClick?` |
| `DataTableView<T>` | Same table for rows you hold: `rows, columns, loading?, error?, onRetry?, sort?, onSortChange?, empty?, footer?` |
| `Column<T>` | `key, header, cell(row), sortable?: boolean \| string, align?, className?, mobile?: 'title' \| 'subtitle' \| 'hidden'` |
| `RowAction` | `label, icon?, onClick, destructive?, disabled?, hidden?` |
| `FormDialog` | `open, onOpenChange, title, description?, schema, defaultValues, onSubmit, submitLabel?, successMessage?, size?, children(form)` |
| `FormGrid` | Two columns on wide dialogs, one on phones |
| `TextField`, `TextareaField`, `NumberField`, `DateField`, `SelectField`, `ComboboxField`, `SwitchField`, `CheckboxField` | `form, name, label?, hint?, required?, className?` plus control props |
| `FormField` | `form, name, label?, hint?, required?, children(field)`, for any other control |
| `StatCard` | `label, value, delta?: { value, direction, goodWhen?, label? }, hint?, tone?, icon?, loading?, to?` |
| `ChartCard<T>` | `title, description?, kind: 'bar' \| 'stacked-bar' \| 'line' \| 'area', data, xKey, series: { key, label, slot? }[], formatValue?, formatAxis?, formatX?, formatLabel?, height?, action?, loading?, error?, onRetry?, emptyText?` |
| `EmptyState` | `icon?, title, description?, action?` |
| `ErrorCard` | `error, onRetry?, title?` |
| `MoneyText` | `value, currency?, compact?, digits?, plain?, signed?` |
| `PermissionGate` | `permission?, anyOf?, fallback?, children` |
| `UrlTabs` | `tabs: { value, label, content, hidden? }[], param?` |
| `ConfirmDialog` | Controlled; usually prefer `useConfirm()` |

Hooks: `useConfirm()` gives `confirm({ title, description?, confirmLabel?, destructive? }) => Promise<boolean>`.
`useUrlParam(name, default?)` gives `[value, set]`, a value kept in the query string.

## UI kit

`Button` (`variant`: primary, secondary, accent, outline, ghost, destructive, link; `size`: sm, md, lg, icon,
icon-sm; `loading`, `asChild`), `Input`, `Textarea`, `DateInput`, `PasswordInput`,
`NumberInput` (`value: number | null`, `onChange(number | null)`, `suffix`, `maxDigits`, `allowNegative`),
`Select` (`options`, `placeholder`), `Combobox` (`value`, `onChange(value, option)`, `options` or `loadOptions`,
`selectedLabel`, `clearable`), `apiOptions(path, row => option, params?)`, `Checkbox`, `Switch`, `Label`,
`Dialog*`, `Sheet*`, `Tabs*`, `Card*`, `Table`, `THead`, `TBody`, `Tr`, `Th`, `Td`, `Badge` (`variant`: neutral,
success, warning, danger, info, outline), `Alert` (`tone`, `title`), `Meter` (`value`, `tone`, `label`),
`DropdownMenu*`, `Tooltip` (`content`), `Separator`, `Skeleton`, `Pagination`.

Long lists (items, animals, counterparties) use `ComboboxField` with `apiOptions`, so they search on the
server:

```tsx
<ComboboxField form={form} name="itemId" label={t('item')}
  loadOptions={apiOptions<Item>('/inventory/items', (i) => ({ value: i.id, label: i.name, hint: i.unit }), { category: 'feed' })}
  selectedLabel={record?.itemName} />
```

## Data

```ts
api.get<T>(path, params?)                  // unwrapped data
api.list<T>(path, params?)                 // { data, meta }
api.post<T>(path, body?, { idempotencyKey? })   // also patch, put, delete(path)
api.upload(file, name?)                    // { id, name, mimeType, url }; url works as an <img> src
api.postFile<T>(path, file, fields?)       // multipart to any endpoint, e.g. spreadsheet import
api.download(path, filename?, params?)     // authenticated download
api.blobUrl(path)                          // object URL; the caller revokes it

useList<T>(path, params?, options?)
useDetail<T>(path | null, params?, options?)
useApiMutation({ mutationFn, invalidate?: string[], successMessage?, silentError?, onSuccess?, onError? })
errorMessage(error)                        // translated text for anything thrown
```

`invalidate: ['/finance/counterparties']` also refreshes its records and filtered lists. Pass
`silentError: true` when the mutation runs inside a `FormDialog`, which displays the error itself.

Auth: `useAuth()`, `useSession()`, `usePermission(perm)`, `useCan()`, `useModuleEnabled()`.

## Forms

`lib/forms`: `zText(max?)`, `zOptionalText(max?)`, `zNumber()`, `zPositive()`, `zNonNegative()`,
`zOptionalNumber()`, `zDate()`, `zOptionalDate()`, `zRef()`, `zOptionalRef()`, `zEnum(VALUES)`,
`zOptionalEnum(VALUES)`. Optional values come out as `null`, so a cleared field really clears the column
on PATCH. Validation messages follow the UI language automatically. Option lists:
`enumOptions('unit', UNITS)`; the group is the camelCase singular of the constant.

## Formatting

`lib/format`: `formatMoney(v, { currency?, compact?, digits?, plain? })`, `formatQty(v, unit?, digits?)`,
`formatNumber(v, digits?)`, `formatCompact(v)`, `formatPercent(v, digits?)` (v is already a percentage),
`formatDate`, `formatDateLong`, `formatDateTime`, `formatMonth('2026-11')`, `formatMonthShort`.
`null` always renders as `—`.

**Do not call `Intl` with an `uz` locale, or `toLocaleString()` without one.** Browsers claim to support
`uz` but ship almost no data for it: real Chrome prints "2.1G" for billions and "M11" for November. Everything
in `lib/format` is safe. For month axes: `formatX={(m) => formatMonthShort(m)} formatLabel={formatMonth}`.

## Charts

Series take colours in a fixed, validated order: use `slot` when a filter can hide series, so the rest keep
their colour. Status tokens (`success`, `warning`, `danger`) are never series colours, and one chart has one
y axis. For two scales, draw two charts. Amber, teal and olive fall below 3:1 on the light surface, which
is why `ChartCard` always offers the table view; custom charts must do the same.
