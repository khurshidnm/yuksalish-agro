import { describe, expect, it } from 'vitest';
import { decodeFileText, looksBinary } from './file-text';

const bytes = (...values: number[]) => new Uint8Array(values);
const utf8 = (text: string) => new TextEncoder().encode(text);

function utf16(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xfeff, littleEndian);
  for (let i = 0; i < text.length; i += 1) view.setUint16(2 + i * 2, text.charCodeAt(i), littleEndian);
  return out;
}

describe('decodeFileText', () => {
  it('reads plain UTF-8', () => {
    expect(decodeFileText(utf8('Tag;Weight\nUZ-001;45,5'))).toBe('Tag;Weight\nUZ-001;45,5');
  });

  it('reads UTF-8 Cyrillic and Uzbek letters', () => {
    expect(decodeFileText(utf8('Бирка;Вес\nҚЎЙ-1;45'))).toBe('Бирка;Вес\nҚЎЙ-1;45');
  });

  it('drops the UTF-8 mark, so the first heading is not read with an invisible letter in front', () => {
    const text = decodeFileText(bytes(0xef, 0xbb, 0xbf, ...utf8('Tag,Weight')));
    expect(text).toBe('Tag,Weight');
    expect(text.charCodeAt(0)).toBe(84);
  });

  it('reads UTF-16, both byte orders: a spreadsheet saves "Unicode text" this way', () => {
    expect(decodeFileText(utf16('Бирка\tВес\n101\t45,5', true))).toBe('Бирка\tВес\n101\t45,5');
    expect(decodeFileText(utf16('Бирка\tВес\n101\t45,5', false))).toBe('Бирка\tВес\n101\t45,5');
  });

  it('reads Windows-1251 when the bytes are not UTF-8', () => {
    // "Вес;Бирка" in Windows-1251.
    const cp1251 = bytes(0xc2, 0xe5, 0xf1, 0x3b, 0xc1, 0xe8, 0xf0, 0xea, 0xe0, 0x0a, 0x34, 0x35, 0x3b, 0x31);
    expect(decodeFileText(cp1251)).toBe('Вес;Бирка\n45;1');
  });

  it('gives an empty file as empty text', () => {
    expect(decodeFileText(bytes())).toBe('');
  });
});

describe('looksBinary', () => {
  it('lets text through, UTF-16 with its zero bytes included', () => {
    expect(looksBinary(utf8('Tag;Weight\n1;45'))).toBe(false);
    expect(looksBinary(utf16('Tag\tWeight', true))).toBe(false);
    expect(looksBinary(bytes())).toBe(false);
  });

  it('stops a spreadsheet file', () => {
    // The first bytes of an .xlsx (a zip) and of an old .xls.
    expect(looksBinary(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00))).toBe(true);
    expect(looksBinary(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00))).toBe(true);
  });
});
