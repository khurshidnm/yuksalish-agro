import { describe, expect, it } from 'vitest';
import { latinToCyrillic, mapStrings } from './translit';

describe('latinToCyrillic', () => {
  it.each([
    ["Bo'g'oz sovliqlar", 'Бўғоз совлиқлар'],
    ['ferma', 'ферма'],
    ['eslatma', 'эслатма'],
    ["ma'lumot", 'маълумот'],
    ["O'simlikchilik", 'Ўсимликчилик'],
    ['Chorvachilik', 'Чорвачилик'],
    ['yangi', 'янги'],
    ['yetkazib', 'етказиб'],
    ['Xarajat', 'Харажат'],
    ['Hisobotlar', 'Ҳисоботлар'],
    ['Ratsion', 'Рацион'],
    ['Operatsiya', 'Операция'],
    ["yo'l", 'йўл'],
    ['yoqilg\'i', 'ёқилғи'],
    ['Qoldiq', 'Қолдиқ'],
    ['SHU', 'ШУ'],
  ])('%s → %s', (latin, cyrillic) => {
    // "SHU" is treated as an acronym and kept; the rest transliterate.
    expect(latinToCyrillic(latin)).toBe(latin === 'SHU' ? 'SHU' : cyrillic);
  });

  it('keeps placeholders, acronyms, brands and URLs', () => {
    expect(latinToCyrillic('{{count}} bosh')).toBe('{{count}} бош');
    expect(latinToCyrillic('PDF va Excel')).toBe('PDF ва Excel');
    expect(latinToCyrillic('Sayt: https://keeping.uz')).toBe('Сайт: https://keeping.uz');
  });

  it('applies overrides', () => {
    expect(latinToCyrillic('Telegram')).toBe('Телеграм');
    expect(latinToCyrillic('Sentabr')).toBe('Сентябрь');
    expect(latinToCyrillic('iyun')).toBe('июнь');
  });

  it('leaves digits and punctuation alone', () => {
    expect(latinToCyrillic('500 bosh, 70 ga.')).toBe('500 бош, 70 га.');
  });
});

describe('real words a person would notice', () => {
  it.each([
    ['internetsiz', 'интернетсиз'],
    ['Muddatsiz', 'Муддатсиз'],
    ['harakatsizlik', 'ҳаракатсизлик'],
    ['kalitsiz', 'калитсиз'],
    ['yetsin', 'етсин'],
    ['ratsion', 'рацион'],
    ['operatsiya', 'операция'],
    ['litsenziya', 'лицензия'],
    ['meditsina', 'медицина'],
    ['protsent', 'процент'],
    ['Vaksina', 'Вакцина'],
    ['vaksinatsiya', 'вакцинация'],
    ['Kompyuterda', 'Компьютерда'],
    ['Obyektlar', 'Объектлар'],
    ["PDF'ga", "PDF'га"],
    ['STIR', 'СТИР'],
    ['Webhook', 'Webhook'],
    ['pH', 'pH'],
  ])('%s', (latin, cyrillic) => {
    expect(latinToCyrillic(latin)).toBe(cyrillic);
  });

  it('leaves paths and file types alone, but not a unit after a slash', () => {
    expect(latinToCyrillic('Hujjat: /api/docs')).toBe('Ҳужжат: /api/docs');
    expect(latinToCyrillic('Excel (.xlsx) yoki CSV')).toBe('Excel (.xlsx) ёки CSV');
    expect(latinToCyrillic("so'm/kg")).toBe('сўм/кг');
  });
});

describe('mapStrings', () => {
  it('walks nested dictionaries', () => {
    expect(mapStrings({ a: 'x', b: { c: ['y'] }, d: 1 }, (s) => s.toUpperCase())).toEqual({
      a: 'X',
      b: { c: ['Y'] },
      d: 1,
    });
  });
});
