import { animalLabelCode, itemLabelCode, matchScan, normalizeScan } from '@yap/shared/formulas/scan-code';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { itemPrintLabels } from '@/features/inventory/ItemLabelsPage';
import { type TagLabel, tagPrintLabels } from '@/features/livestock/TagLabelsPage';
import i18n from '@/lib/i18n';
import { LabelSheet, LabelToolbar, labelPages } from './LabelSheet';
import { qrPictures } from './test-pictures';
import { decodeLuminance } from './zxing-detector';

vi.mock('sonner', () => ({ toast: {} }));

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterAll(async () => {
  await i18n.changeLanguage('uz');
});

/** What a camera reads off every label of a printed sheet, in order, through the scan normaliser. */
function readBack(markup: string): (string | null)[] {
  return qrPictures(markup).map((picture) => normalizeScan(decodeLuminance(picture.grey, picture.width, picture.height)));
}

/** The words printed on the sheet, without the drawings. */
function printedText(markup: string): string[] {
  return markup
    .replace(/<style>.*?<\/style>/gs, '')
    .replace(/<svg.*?<\/svg>/gs, '')
    .split(/<[^>]+>/)
    .map((text) => text.trim())
    .filter(Boolean);
}

describe('a printed animal tag is read back as the animal it was printed for', () => {
  // The registry: two tags that differ only in letter case, and an animal that already wears a QR tag.
  const animals = [
    { id: 'a1', tag: 'YA-0042', qr: null, herdName: 'Ewes 1' },
    { id: 'a2', tag: 'ya-0042', qr: null, herdName: 'Ewes 2' },
    { id: 'a3', tag: 'UZ 860 000123', qr: 'QR-777', herdName: null },
    { id: 'a4', tag: "Qo'y 17", qr: null, herdName: 'Rams' },
  ];
  const candidates = animals.flatMap((animal) => [{ value: animal.tag, item: animal.id }, ...(animal.qr ? [{ value: animal.qr, item: animal.id }] : [])]);
  const rows: TagLabel[] = animals.map((animal) => ({ id: animal.id, tag: animal.tag, herdName: animal.herdName, code: animalLabelCode(animal) }));
  const markup = renderToStaticMarkup(<LabelSheet labels={tagPrintLabels(rows)} />);

  it('every label decodes to the code that was printed', () => {
    expect(readBack(markup)).toEqual(['YA-0042', 'ya-0042', 'QR-777', "Qo'y 17"]);
    expect(readBack(markup)).toEqual(rows.map((row) => row.code));
  });

  it('and that code finds exactly its own animal, even beside a tag that differs only in case', () => {
    const found = readBack(markup).map((code) => matchScan(code!, candidates).map((match) => match.item));
    expect(found).toEqual([['a1'], ['a2'], ['a3'], ['a4']]);
  });

  it('prints the tag number and the herd, and nothing else', () => {
    expect(printedText(markup)).toEqual(['YA-0042', 'Ewes 1', 'ya-0042', 'Ewes 2', 'UZ 860 000123', "Qo&#x27;y 17", 'Rams']);
  });

  it('the code is the bare code: no web address, no record id', () => {
    for (const row of rows) {
      expect(row.code).not.toMatch(/https?:|\//);
      expect(row.code).not.toBe(row.id);
    }
  });
});

describe('a printed item label is read back as the item it was printed for', () => {
  const ID = '018f3c2e-7d4a-7b1c-9e55-0a1b2c3d4e5f';
  const items = [
    { id: 'i1', name: 'Barley', sku: 'FD-01', barcode: '4780012345678' },
    { id: 'i2', name: 'Salt lick', sku: 'SL-9', barcode: null },
    { id: ID, name: 'Hay, own', sku: null, barcode: null },
  ];
  const candidates = items.flatMap((item) => [
    ...(item.barcode ? [{ value: item.barcode, item: item.id }] : []),
    ...(item.sku ? [{ value: item.sku, item: item.id }] : []),
    { value: item.id, item: item.id },
  ]);
  const labels = itemPrintLabels(items);
  const markup = renderToStaticMarkup(<LabelSheet labels={labels} size="large" />);

  it('encodes the barcode, else the item code, else the record id', () => {
    expect(labels.map((label) => label.code)).toEqual(['4780012345678', 'SL-9', ID]);
    expect(labels.map((label) => label.code)).toEqual(items.map((item) => itemLabelCode(item)));
  });

  it('every label decodes to that code, and the code finds exactly its own item', () => {
    const codes = readBack(markup);
    expect(codes).toEqual(['4780012345678', 'SL-9', ID]);
    expect(codes.map((code) => matchScan(code!, candidates).map((match) => match.item))).toEqual([['i1'], ['i2'], [ID]]);
  });

  it('prints the name and the code a person can type: no stock, no price', () => {
    expect(printedText(markup)).toEqual(['Barley', '4780012345678', 'Salt lick', 'SL-9', 'Hay, own']);
  });

  it('carries nothing but what a label holds, whatever else the item row has', () => {
    const rich = { ...items[0]!, qtyOnHand: 1250, avgCost: 3400, transferPrice: 4100, notes: 'from Karim aka' };
    const [label] = itemPrintLabels([rich]);
    expect(label).toEqual({ key: 'i1', code: '4780012345678', title: 'Barley', subtitle: '4780012345678' });
  });
});

describe('the sheet on paper', () => {
  const labels = Array.from({ length: 30 }, (_, index) => ({ key: String(index), code: `YA-${index}`, title: `YA-${index}`, subtitle: 'Ewes' }));

  it('is A4, three across when small and two across when large, and no label is cut by a page end', () => {
    const small = renderToStaticMarkup(<LabelSheet labels={labels} />);
    expect(small).toContain('@page { size: A4 portrait;');
    expect(small).toContain('data-label-sheet="small"');
    expect(small).toContain('print:grid-cols-3');
    expect(small.match(/break-inside-avoid/g)).toHaveLength(30);
    expect(renderToStaticMarkup(<LabelSheet labels={labels} size="large" />)).toContain('print:grid-cols-2');
  });

  it('counts the pages: 24 small labels a page, 10 large ones', () => {
    expect(labelPages(0, 'small')).toBe(0);
    expect(labelPages(24, 'small')).toBe(1);
    expect(labelPages(25, 'small')).toBe(2);
    expect(labelPages(700, 'small')).toBe(30);
    expect(labelPages(10, 'large')).toBe(1);
    expect(labelPages(11, 'large')).toBe(2);
  });

  it('is black on white whatever the theme, so the code scans', () => {
    expect(renderToStaticMarkup(<LabelSheet labels={labels.slice(0, 1)} />)).toMatch(/<li class="[^"]*bg-white[^"]*text-black/);
  });

  it('the bar with the print button stays off the paper, and cannot print an empty sheet', () => {
    const bar = renderToStaticMarkup(<LabelToolbar count={30} size="small" onSize={() => {}} />);
    expect(bar).toMatch(/^<div class="[^"]*print:hidden/);
    expect(bar).toContain('30');
    expect(bar).toContain(i18n.t('scan:labels.print'));
    expect(bar).not.toMatch(/<button[^>]*disabled=""/);
    expect(renderToStaticMarkup(<LabelToolbar count={0} size="small" onSize={() => {}} />)).toMatch(/<button[^>]*disabled=""/);
  });
});
