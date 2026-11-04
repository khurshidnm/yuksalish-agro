import { describe, expect, it } from 'vitest';
import {
  Lookup,
  cellText,
  matchKey,
  parseAgeMonths,
  parseBankDetails,
  parseCoordinates,
  parseDate,
  parseMonth,
  parseNumber,
  serialToIso,
} from './values';

describe('parseDate', () => {
  it.each([
    ['2026-11-04', '2026-11-04'],
    ['2026.11.04', '2026-11-04'],
    ['2026-11-04T00:00:00.000Z', '2026-11-04'],
    ['04.11.2026', '2026-11-04'],
    ['4.11.2026', '2026-11-04'],
    ['04/11/2026', '2026-11-04'],
    ['04-11-2026', '2026-11-04'],
    ['04.11.26', '2026-11-04'],
    ['  04.11.2026  ', '2026-11-04'],
    ['04.11.2026 00:00', '2026-11-04'],
    ['4 noyabr 2026', '2026-11-04'],
    ['4-noyabr 2026-yil', '2026-11-04'],
    ['2026 yil 4 noyabr', '2026-11-04'],
    ['4 ноября 2026 г.', '2026-11-04'],
    ['Nov 4 2026', '2026-11-04'],
    ['46330', '2026-11-04'],
  ])('reads %s', (input, expected) => {
    expect(parseDate(input)).toBe(expected);
  });

  it('reads Excel serials as numbers, ignoring a time of day', () => {
    expect(parseDate(46330)).toBe('2026-11-04');
    expect(parseDate(46330.75)).toBe('2026-11-04');
    expect(serialToIso(45351)).toBe('2024-02-29');
  });

  it('keeps day-first meaning when both readings are possible', () => {
    expect(parseDate('03.04.2026')).toBe('2026-04-03');
    expect(parseDate('03/04/2026')).toBe('2026-04-03');
  });

  it('accepts month-first only when it can be nothing else', () => {
    expect(parseDate('10/28/2026')).toBe('2026-10-28');
  });

  it.each(['31.02.2026', '32.01.2026', '13.13.2026', '2026-13-01', 'kecha', 'noyabr 2026', '12345', '01.01.1800', ''])(
    'refuses %s',
    (input) => {
      expect(parseDate(input)).toBeNull();
    },
  );

  it('refuses small numbers and nulls', () => {
    expect(parseDate(3)).toBeNull();
    expect(parseDate(null)).toBeNull();
  });
});

describe('parseMonth', () => {
  it.each([
    ['2026-11', '2026-11'],
    ['2026.11', '2026-11'],
    ['11.2026', '2026-11'],
    ['11/2026', '2026-11'],
    ['Noyabr 2026', '2026-11'],
    ['ноябрь 2026', '2026-11'],
    ['Ноябрь 2026 г.', '2026-11'],
    ['November 2026', '2026-11'],
    ['2026-yil noyabr', '2026-11'],
    ['01.11.2026', '2026-11'],
    ['2026-11-15', '2026-11'],
  ])('reads %s', (input, expected) => {
    expect(parseMonth(input)).toBe(expected);
  });

  it('reads an Excel date', () => {
    expect(parseMonth(46330)).toBe('2026-11');
  });

  it.each(['noyabr', '13.2026', '2026', 'oy', ''])('refuses %s', (input) => {
    expect(parseMonth(input)).toBeNull();
  });
});

describe('parseNumber', () => {
  it.each([
    ['1200', 1200],
    ['1 200', 1200],
    ['1 200', 1200],
    ['12,5', 12.5],
    ['12.5', 12.5],
    ['1 200,5', 1200.5],
    ['1,200.50', 1200.5],
    ['1.200,50', 1200.5],
    ['-5', -5],
    ['12,5 ga', 12.5],
    ['120 kg', 120],
    ['500 kg.', 500],
  ])('reads %s', (input, expected) => {
    expect(parseNumber(input)).toBe(expected);
  });

  it('a lone 3-digit group is a decimal for quantities and thousands for money', () => {
    expect(parseNumber('1.250')).toBe(1.25);
    expect(parseNumber('1,250')).toBe(1.25);
    expect(parseNumber('4.200', 'money')).toBe(4200);
    expect(parseNumber('4,200', 'money')).toBe(4200);
  });

  it.each([
    ["4 200 000 so'm", 4_200_000],
    ['4 200 000 сум', 4_200_000],
    ["4'200'000", 4_200_000],
    ['4.200.000', 4_200_000],
    ['4,200,000', 4_200_000],
    ['4,2 mln', 4_200_000],
    ['4.2 млн', 4_200_000],
    ['850 ming', 850_000],
  ])('reads the money amount %s', (input, expected) => {
    expect(parseNumber(input, 'money')).toBeCloseTo(expected, 2);
  });

  it('passes real numbers through', () => {
    expect(parseNumber(12.5)).toBe(12.5);
  });

  it.each(['abc', '12a', '1.2.3', '1,2,3', '', '  ', 'so\'m', '--5'])('refuses %j', (input) => {
    expect(parseNumber(input)).toBeNull();
  });
});

describe('parseAgeMonths', () => {
  it.each([
    ['3', 36],
    ['3 yosh', 36],
    ['3 yoshli', 36],
    ['2,5', 30],
    ['2.5 года', 30],
    ['3 года', 36],
    ['5 лет', 60],
    ['18 oy', 18],
    ['6 мес', 6],
    ['2 yosh 6 oy', 30],
    ['4 years', 48],
  ])('reads %s', (input, expected) => {
    expect(parseAgeMonths(input)).toBe(expected);
  });

  it('a bare number means years, within reason', () => {
    expect(parseAgeMonths(3)).toBe(36);
    expect(parseAgeMonths(1.5)).toBe(18);
    expect(parseAgeMonths(46330)).toBeNull();
    expect(parseAgeMonths(0)).toBeNull();
  });

  it.each(['qari', '3 kun', 'yosh', '-', ''])('refuses %j', (input) => {
    expect(parseAgeMonths(input)).toBeNull();
  });
});

describe('matchKey and Lookup', () => {
  it('ignores case, spacing, punctuation and apostrophe style', () => {
    expect(matchKey("  Bug'doy ")).toBe('bugdoy');
    expect(matchKey('Bugʻdoy')).toBe('bugdoy');
    expect(matchKey('Bug’doy')).toBe('bugdoy');
    expect(matchKey('BUGDOY')).toBe('bugdoy');
    expect(matchKey('Beda  (pichan)')).toBe('beda pichan');
  });

  it('folds Uzbek Cyrillic onto what a Russian keyboard can type', () => {
    expect(matchKey('Буғдой')).toBe(matchKey('бугдой'));
    expect(matchKey('Ўғит')).toBe(matchKey('угит'));
  });

  it('finds a value by Latin, Cyrillic, Russian and English names', () => {
    const crops = new Lookup<string>().add('wheat', ["Bug'doy", 'Пшеница', 'Wheat', 'wheat']);
    for (const name of ["bug'doy", 'Bugdoy', 'Буғдой', 'бугдой', 'пшеница', 'WHEAT']) {
      expect(crops.get(name)).toBe('wheat');
    }
    expect(crops.get('Arpa')).toBeUndefined();
    expect(crops.labels).toEqual(["Bug'doy"]);
  });

  it('refuses a name two values share rather than picking one', () => {
    const list = new Lookup<string>().add('a', ['Bank']).add('b', ['Bank']);
    expect(list.get('bank')).toBeUndefined();
  });

  it('adding the same value under the same name is not ambiguity', () => {
    const list = new Lookup<string>().add('a', ['Bank', 'BANK']);
    expect(list.get('bank')).toBe('a');
  });
});

describe('parseCoordinates', () => {
  const polygon = {
    kind: 'polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [[[64.8, 39.5], [64.81, 39.5], [64.81, 39.51], [64.8, 39.5]]],
    },
  };

  it('reads lat, lng pairs and closes the ring', () => {
    expect(parseCoordinates('39.5, 64.8; 39.5, 64.81; 39.51, 64.81')).toEqual(polygon);
  });

  it('accepts comma decimals and newlines', () => {
    expect(parseCoordinates('39,5 64,8\n39,5 64,81\n39,51 64,81')).toEqual(polygon);
  });

  it('notices lng and lat the other way round for this region', () => {
    expect(parseCoordinates('64.8, 39.5; 64.81, 39.5; 64.81, 39.51')).toEqual(polygon);
  });

  it('keeps an already closed ring as it is', () => {
    const closed = parseCoordinates('39.5, 64.8; 39.5, 64.81; 39.51, 64.81; 39.5, 64.8');
    expect(closed).toEqual(polygon);
  });

  it('reads pasted GeoJSON, including a Feature', () => {
    const geometry = polygon.geometry;
    expect(parseCoordinates(JSON.stringify(geometry))).toEqual({ kind: 'polygon', geometry });
    expect(parseCoordinates(JSON.stringify({ type: 'Feature', geometry }))).toEqual({ kind: 'polygon', geometry });
  });

  it('tells one point apart from a bad value', () => {
    expect(parseCoordinates('39.5, 64.8')).toEqual({ kind: 'point' });
    expect(parseCoordinates('dala yonida')).toEqual({ kind: 'invalid' });
    expect(parseCoordinates('39.5; 64.8')).toEqual({ kind: 'invalid' });
    expect(parseCoordinates('{not json')).toEqual({ kind: 'invalid' });
    expect(parseCoordinates('39.5, 64.8; 39.5, 64.81')).toEqual({ kind: 'invalid' });
  });
});

describe('parseBankDetails', () => {
  it('splits a typical cell', () => {
    expect(parseBankDetails('Agrobank, h/r 20208000900123456001, MFO 00394')).toEqual({
      bankName: 'Agrobank',
      account: '20208000900123456001',
      mfo: '00394',
    });
  });

  it('handles spaces inside the account and Cyrillic labels', () => {
    expect(parseBankDetails('АКБ Агробанк х/р 2020 8000 9001 2345 6001 МФО 00394')).toEqual({
      bankName: 'АКБ Агробанк',
      account: '20208000900123456001',
      mfo: '00394',
    });
  });

  it('keeps a bank name alone, and nothing for an empty cell', () => {
    expect(parseBankDetails('Agrobank')).toEqual({ bankName: 'Agrobank' });
    expect(parseBankDetails('  ')).toBeNull();
  });
});

describe('cellText', () => {
  it('turns any cell into trimmed text', () => {
    expect(cellText(' a ')).toBe('a');
    expect(cellText(12)).toBe('12');
    expect(cellText(null)).toBe('');
    expect(cellText(undefined)).toBe('');
  });
});
