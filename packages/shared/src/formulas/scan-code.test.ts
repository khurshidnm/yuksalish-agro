import { describe, expect, it } from 'vitest';
import { SCAN_CODE_MAX, animalLabelCode, itemLabelCode, matchScan, normalizeScan, scanKey, scanKeyVariants } from './scan-code';

describe('normalizeScan', () => {
  it.each([
    ['UZ-0042', 'UZ-0042'],
    ['  UZ-0042  ', 'UZ-0042'],
    ['UZ-0042\r\n', 'UZ-0042'],
    ['UZ-0042\t', 'UZ-0042'],
    ['﻿UZ-0042', 'UZ-0042'],
    ['UZ   0042', 'UZ 0042'],
    ['ya-0042', 'ya-0042'],
    ['982 000123456789', '982 000123456789'],
    ['4780012345678', '4780012345678'],
    [']C1ABC-123', 'ABC-123'],
    [']Q3UZ-0042', 'UZ-0042'],
  ])('%j reads as %j', (raw, code) => {
    expect(normalizeScan(raw)).toBe(code);
  });

  it.each([
    ['https://agropanel.uz/t/UZ-0042', 'UZ-0042'],
    ['HTTPS://AGROPANEL.UZ/t/UZ-0042', 'UZ-0042'],
    ['http://example.uz/animals/UZ-0042/', 'UZ-0042'],
    ['https://example.uz/scan?tag=UZ-0042', 'UZ-0042'],
    ['https://example.uz/scan?Code=UZ-0042&x=1', 'UZ-0042'],
    ['https://example.uz/a/b?code=QR%2F7', 'QR/7'],
    ['https://example.uz/t/YA%200042', 'YA 0042'],
    ['https://example.uz/t/UZ-0042#top', 'UZ-0042'],
  ])('takes the code out of the address %j', (raw, code) => {
    expect(normalizeScan(raw)).toBe(code);
  });

  it('prefers a code parameter to the path', () => {
    expect(normalizeScan('https://example.uz/t/page?code=UZ-1')).toBe('UZ-1');
  });

  it.each([[''], ['   '], ['\n'], [null], [undefined], ['https://example.uz'], ['https://example.uz/'], ['http://']])('%j is no code', (raw) => {
    expect(normalizeScan(raw)).toBeNull();
  });

  it('refuses a code longer than the registry stores', () => {
    expect(normalizeScan('A'.repeat(SCAN_CODE_MAX))).toBe('A'.repeat(SCAN_CODE_MAX));
    expect(normalizeScan('A'.repeat(SCAN_CODE_MAX + 1))).toBeNull();
  });

  it('does not treat a tag that merely contains an address as one', () => {
    expect(normalizeScan('TAG http://x.uz/1')).toBe('TAG http://x.uz/1');
  });
});

describe('scanKey', () => {
  it('ignores letter case and spaces, and nothing else', () => {
    expect(scanKey('ya-0042')).toBe(scanKey('YA-0042'));
    expect(scanKey('982 000123456789')).toBe(scanKey('982000123456789'));
    expect(scanKey('YA-0042')).not.toBe(scanKey('YA0042'));
    expect(scanKey('YA-0042')).not.toBe(scanKey('YA-42'));
  });

  it('treats a UPC-A and its EAN-13 as one number', () => {
    expect(scanKeyVariants('036000291452')).toEqual(['036000291452', '0036000291452']);
    expect(scanKeyVariants('0036000291452')).toEqual(['0036000291452', '036000291452']);
    expect(scanKeyVariants('4780012345678')).toEqual(['4780012345678']);
    expect(scanKeyVariants('ya-1')).toEqual(['YA-1']);
    expect(scanKeyVariants('  ')).toEqual([]);
  });
});

describe('label codes', () => {
  it('an animal label carries its own QR identifier, else its ear tag', () => {
    expect(animalLabelCode({ tag: 'UZ-0042', qr: 'QR-777' })).toBe('QR-777');
    expect(animalLabelCode({ tag: 'UZ-0042', qr: null })).toBe('UZ-0042');
    expect(animalLabelCode({ tag: 'UZ-0042' })).toBe('UZ-0042');
    expect(animalLabelCode({ tag: ' UZ-0042 ', qr: '  ' })).toBe('UZ-0042');
  });

  it('an item label carries its barcode, else its code, else its id', () => {
    const id = '0190a6c8-7b1e-7c3a-9a55-3f2f8f0f4a11';
    expect(itemLabelCode({ id, sku: 'HAY-1', barcode: '4780012345678' })).toBe('4780012345678');
    expect(itemLabelCode({ id, sku: 'HAY-1', barcode: null })).toBe('HAY-1');
    expect(itemLabelCode({ id, sku: ' ', barcode: '' })).toBe(id);
    expect(itemLabelCode({ id })).toBe(id);
  });

  it('every label reads back as the code that was printed', () => {
    const id = '0190a6c8-7b1e-7c3a-9a55-3f2f8f0f4a11';
    const printed = [
      animalLabelCode({ tag: 'UZ-0042' }),
      animalLabelCode({ tag: 'ya 0042' }),
      animalLabelCode({ tag: 'T-1', qr: 'https-not-a-url' }),
      itemLabelCode({ id }),
      itemLabelCode({ id, sku: 'ДТ-92' }),
      itemLabelCode({ id, barcode: '036000291452' }),
    ];
    for (const code of printed) expect(normalizeScan(code)).toBe(code);
  });

  it('a QR identifier that is a web address is printed as the code inside it', () => {
    const code = animalLabelCode({ tag: 'UZ-1', qr: 'https://tags.example/t/QR-9' });
    expect(code).toBe('QR-9');
    expect(normalizeScan(code)).toBe('QR-9');
  });
});

describe('matchScan', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const c = { id: 'c' };

  it('matches whatever the case and spacing, and nothing looser', () => {
    const candidates = [
      { value: 'YA-0042', item: a },
      { value: 'YA-0043', item: b },
      { value: 'YA-42', item: c },
    ];
    expect(matchScan('ya-0042', candidates).map((m) => m.item)).toEqual([a]);
    expect(matchScan('YA - 0042', candidates).map((m) => m.item)).toEqual([a]);
    expect(matchScan('42', candidates)).toEqual([]);
    expect(matchScan('YA-004', candidates)).toEqual([]);
  });

  it('returns both animals when a code belongs to two', () => {
    const candidates = [
      { value: '123', item: a },
      { value: '123', item: b },
    ];
    expect(matchScan('123', candidates).map((m) => m.item)).toEqual([a, b]);
  });

  it('prefers the letter-for-letter match, and offers both when there is none', () => {
    const candidates = [
      { value: 'ya-1', item: a },
      { value: 'YA-1', item: b },
    ];
    expect(matchScan('YA-1', candidates)).toEqual([{ item: b, value: 'YA-1', exact: true }]);
    expect(matchScan('Ya-1', candidates).map((m) => m.item)).toEqual([a, b]);
    expect(matchScan('Ya-1', candidates).every((m) => !m.exact)).toBe(true);
  });

  it('lists an animal once when its tag and its chip carry the same code', () => {
    const candidates = [
      { value: 'X1', item: a },
      { value: 'X1', item: a },
    ];
    expect(matchScan('X1', candidates)).toHaveLength(1);
  });

  it('finds a UPC-A stored as EAN-13', () => {
    expect(matchScan('036000291452', [{ value: '0036000291452', item: a }]).map((m) => m.item)).toEqual([a]);
  });
});
