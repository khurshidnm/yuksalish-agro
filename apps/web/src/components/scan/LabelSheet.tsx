/**
 * A sheet of labels to print on A4 and cut or peel: a QR code, the number to read with the eye, and
 * one line saying what it belongs to.
 *
 * What the QR holds is decided in one place, `animalLabelCode` and `itemLabelCode` in
 * packages/shared/src/formulas/scan-code.ts, and it is the bare code: no web address, no name of a
 * person, no price. `normalizeScan` reads it back unchanged, and the exact lookups find the record
 * by it (the round trip is tested in LabelSheet.test.tsx).
 *
 * Import from this file, not from '@/components': the QR drawing code loads only on print pages.
 */
import { Printer } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Select } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface PrintLabel {
  key: string;
  /** What the QR encodes. */
  code: string;
  /** The large line: the tag number, or the item's name. */
  title: string;
  /** The small line: the herd, or the item's own code. */
  subtitle?: string | null;
}

export type LabelSize = 'small' | 'large';

/** A4 with 10 mm above and below and 8 mm at the sides: 24 small labels a page, or 10 large ones. */
const PAGE_RULE = '@page { size: A4 portrait; margin: 10mm 8mm; }';

const LAYOUT: Record<LabelSize, { grid: string; label: string; code: string; title: string; perPage: number }> = {
  small: {
    grid: 'grid-cols-2 sm:grid-cols-3 print:grid-cols-3',
    label: 'print:h-[34mm]',
    code: 'size-16 print:size-[26mm]',
    title: 'text-lg print:text-[15pt]',
    perPage: 24,
  },
  large: {
    grid: 'grid-cols-1 sm:grid-cols-2 print:grid-cols-2',
    label: 'print:h-[55mm]',
    code: 'size-24 print:size-[44mm]',
    title: 'text-2xl print:text-[24pt]',
    perPage: 10,
  },
};

export function labelPages(count: number, size: LabelSize): number {
  return Math.ceil(count / LAYOUT[size].perPage);
}

/**
 * The labels alone. Paper is white and ink is black whatever the theme, so these two colours are
 * fixed here; a dark code on a dark label would not scan.
 */
export function LabelSheet({ labels, size = 'small' }: { labels: PrintLabel[]; size?: LabelSize }) {
  const layout = LAYOUT[size];
  return (
    <>
      <style>{PAGE_RULE}</style>
      <ul className={cn('grid gap-2 print:gap-0', layout.grid)} data-label-sheet={size}>
        {labels.map((label) => (
          <li
            key={label.key}
            className={cn(
              'flex min-w-0 break-inside-avoid items-center gap-2 overflow-hidden rounded-lg border border-dashed border-border bg-white p-2 text-black print:rounded-none print:p-[3mm]',
              layout.label,
            )}
          >
            {/* Level M: a quarter of the code may be scuffed and it still reads. The margin is the quiet zone a reader needs. */}
            <QRCodeSVG value={label.code} level="M" marginSize={2} className={cn('shrink-0', layout.code)} />
            <div className="min-w-0 flex-1">
              <p className={cn('leading-tight font-bold break-words tabular-nums', layout.title)}>{label.title}</p>
              {label.subtitle && <p className="mt-0.5 text-xs leading-tight break-words print:text-[8pt]">{label.subtitle}</p>}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The bar above the sheet: how many, which size, and the print button. Not printed. */
export function LabelToolbar({
  count,
  size,
  onSize,
  children,
}: {
  count: number;
  size: LabelSize;
  onSize: (size: LabelSize) => void;
  /** Further choices, such as the herd. */
  children?: ReactNode;
}) {
  const { t } = useTranslation('scan');
  return (
    <div className="mb-4 flex flex-wrap items-end gap-2 print:hidden">
      {children}
      <Select
        aria-label={t('labels.size')}
        value={size}
        onChange={(event) => onSize(event.target.value === 'large' ? 'large' : 'small')}
        options={[
          { value: 'small', label: t('labels.sizes.small') },
          { value: 'large', label: t('labels.sizes.large') },
        ]}
        className="w-full sm:w-56"
      />
      {count > 0 && (
        <p className="w-full text-sm text-muted-foreground sm:w-auto sm:flex-1 sm:self-center">
          {t('labels.count', { labels: formatNumber(count), pages: formatNumber(labelPages(count, size)) })}
        </p>
      )}
      <Button className="w-full sm:ms-auto sm:w-auto" disabled={count === 0} onClick={() => window.print()}>
        <Printer aria-hidden />
        {t('labels.print')}
      </Button>
    </div>
  );
}
