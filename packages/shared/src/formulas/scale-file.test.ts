import { describe, expect, it } from 'vitest';
import {
  detectDelimiter,
  parseScaleFile,
  planScaleImport,
  readScaleRows,
  readScaleWeight,
  scaleWeightUnit,
  splitRecords,
  type ScaleAnimal,
} from './scale-file';

const rowsOf = (text: string) => readScaleRows(parseScaleFile(text));

describe('detectDelimiter', () => {
  it.each([
    ['Tag,Weight\nUZ-1,45.5\nUZ-2,51', ','],
    ['Tag;Weight\nUZ-1;45,5\nUZ-2;51,2', ';'],
    ['Tag\tWeight\nUZ-1\t45,5\nUZ-2\t51', '\t'],
    ['"UZ-1";"45,5"\n"UZ-2";"51,0"', ';'],
  ])('%j is split by %j', (text, delimiter) => {
    expect(detectDelimiter(text)).toBe(delimiter);
  });
});

describe('splitRecords', () => {
  it('reads quoted cells, doubled quotes and a line break inside quotes', () => {
    const records = splitRecords('a,"b,c","d ""e"""\r\n"line\none",2,3\n', ',');
    expect(records).toEqual([
      { line: 1, cells: ['a', 'b,c', 'd "e"'] },
      { line: 2, cells: ['line\none', '2', '3'] },
    ]);
  });

  it('keeps the file line of each record and drops empty lines', () => {
    const records = splitRecords('﻿Tag;Kg\r\n\r\nUZ-1;45\r\n;\r\nUZ-2;50', ';');
    expect(records.map((r) => r.line)).toEqual([1, 3, 5]);
    expect(records[0].cells).toEqual(['Tag', 'Kg']);
  });

  it('reads old Mac line ends and a number a spreadsheet kept as text', () => {
    const records = splitRecords('EID,Weight\r="982000123456789",45.5\r"=""982000123456790""",50', ',');
    expect(records.map((r) => r.cells[0])).toEqual(['EID', '982000123456789', '982000123456790']);
  });
});

describe('readScaleWeight', () => {
  it.each([
    ['45', 45],
    ['45.5', 45.5],
    ['45,5', 45.5],
    ['45.25', 45.25],
    ['45,250', 45.25],
    ['45.250', 45.25],
    ['045.5', 45.5],
    ['+45.5', 45.5],
    [' 45,5 ', 45.5],
    ['45.5 kg', 45.5],
    ['45,5кг', 45.5],
    ['45.5 KG', 45.5],
    ['0,8', 0.8],
    ['.8', 0.8],
    ['1,234.5', 1234.5],
    ['1.234,5', 1234.5],
    ['1234,5', 1234.5],
    ['612', 612],
  ])('%j is %d kg', (cell, kg) => {
    expect(readScaleWeight(cell)).toEqual({ kg, problem: null });
  });

  it.each([
    ['', 'no_weight'],
    ['   ', 'no_weight'],
    ['err', 'not_a_number'],
    ['-', 'not_a_number'],
    ['45.5 S', 'not_a_number'],
    ['4.55e1', 'not_a_number'],
    ['45..5', 'not_a_number'],
    ['45,5,5', 'not_a_number'],
    ['1.234', 'ambiguous'],
    ['1,234', 'ambiguous'],
    ['2,000', 'ambiguous'],
    ['100 lb', 'unit'],
    ['100lbs', 'unit'],
    ['4500 g', 'unit'],
    ['4500 гр', 'unit'],
    ['0', 'not_positive'],
    ['0,0', 'not_positive'],
    ['-45.5', 'not_positive'],
    ['2000.5', 'too_heavy'],
    ['45000', 'too_heavy'],
    ['1.234.567', 'too_heavy'],
  ])('%j is reported as %s', (cell, problem) => {
    expect(readScaleWeight(cell)).toEqual({ kg: null, problem });
  });

  it('a third decimal is no doubt once the other reading is heavier than any animal', () => {
    expect(readScaleWeight('3.250')).toEqual({ kg: 3.25, problem: null });
    expect(readScaleWeight('3.250', 5000)).toEqual({ kg: null, problem: 'ambiguous' });
  });
});

describe('parseScaleFile', () => {
  it('finds the heading and its columns in three languages', () => {
    for (const heading of ['Tag;Weight', 'VID;Weight (kg)', 'Бирка;Вес, кг', "Raqam;Vazn (kg)", 'Animal ID;LWT']) {
      const file = parseScaleFile(`${heading}\nUZ-1;45,5`);
      expect(file.header, heading).not.toBeNull();
      expect(file.columns, heading).toEqual({ code: 0, weight: 1 });
      expect(file.records).toHaveLength(1);
    }
  });

  it('reads a file with no heading at all', () => {
    const file = parseScaleFile('UZ-1;45,5\nUZ-2;51,2\nUZ-3;48');
    expect(file.header).toBeNull();
    expect(file.columns).toEqual({ code: 0, weight: 1 });
    expect(readScaleRows(file).map((r) => [r.code, r.weightKg])).toEqual([
      ['UZ-1', 45.5],
      ['UZ-2', 51.2],
      ['UZ-3', 48],
    ]);
  });

  it('tells a numeric tag from the weight when there is no heading', () => {
    const file = parseScaleFile('0041,45.5\n0042,51.2\n0043,48.0');
    expect(file.columns).toEqual({ code: 0, weight: 1 });
  });

  it('never takes an unreadable first line for a heading', () => {
    const rows = rowsOf('UZ-1;err\nUZ-2;51,2');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ line: 1, code: 'UZ-1', weightKg: null, problem: 'not_a_number' });
  });

  it('skips session details above the heading and says which lines', () => {
    const file = parseScaleFile('Session,Kuzgi tortish\nDate,10.11.2026\n\nEID,VID,Weight,Draft\n982000123456789,UZ-1,45.5,1\n');
    expect(file.skippedLines).toEqual([1, 2]);
    expect(file.header).toEqual(['EID', 'VID', 'Weight', 'Draft']);
    expect(file.records.map((r) => r.line)).toEqual([5]);
  });

  it('names the animal by its electronic number when the file has one on every line', () => {
    const file = parseScaleFile('EID,VID,Weight\n982000123456789,UZ-1,45.5\n982000123456790,,50');
    expect(file.columns).toEqual({ code: 0, weight: 2 });
  });

  it('falls back to the tag when the electronic number is mostly missing', () => {
    const file = parseScaleFile('EID,VID,Weight\n,UZ-1,45.5\n,UZ-2,50\n982000123456790,UZ-3,50');
    expect(file.columns).toEqual({ code: 1, weight: 2 });
  });

  it('does not take a line counter for the tag', () => {
    const file = parseScaleFile('No;Tag;Weight\n1;UZ-1;45,5\n2;UZ-2;50');
    expect(file.columns).toEqual({ code: 1, weight: 2 });
    expect(parseScaleFile('ID;Kg\nUZ-1;45,5').columns).toEqual({ code: 0, weight: 1 });
  });

  it('does not take the daily gain for the weight', () => {
    const file = parseScaleFile('Tag,Weight gain,ADG,Weight\nUZ-1,2.1,0.15,45.5');
    expect(file.columns).toEqual({ code: 0, weight: 3 });
  });

  it('lets a person say the first row is a heading, or is not', () => {
    expect(parseScaleFile('Qo\'y;Tosh\nUZ-1;45', { header: true }).records).toHaveLength(1);
    expect(parseScaleFile('Tag;Weight\nUZ-1;45', { header: false }).records).toHaveLength(2);
  });

  it('reports every line of a column in pounds rather than converting it', () => {
    const file = parseScaleFile('Tag,Weight (lb)\nUZ-1,100\nUZ-2,110');
    expect(scaleWeightUnit(file, file.columns.weight)).toBe('lb');
    expect(readScaleRows(file).map((r) => r.problem)).toEqual(['unit', 'unit']);
    expect(readScaleRows(file).every((r) => r.weightKg === null)).toBe(true);
  });

  it('an empty file has no rows and no columns', () => {
    const file = parseScaleFile('﻿\r\n\r\n');
    expect(file.records).toEqual([]);
    expect(file.columns).toEqual({ code: null, weight: null });
  });
});

describe('readScaleRows', () => {
  it('reads decimal commas between semicolons, with a byte order mark and quotes', () => {
    const rows = rowsOf('﻿"Tag";"Weight"\r\n"UZ-1";"45,5"\r\n"UZ-2";"51,25"\r\n');
    expect(rows).toEqual([
      { line: 2, code: 'UZ-1', weightText: '45,5', weightKg: 45.5, problem: null },
      { line: 3, code: 'UZ-2', weightText: '51,25', weightKg: 51.25, problem: null },
    ]);
  });

  it('reads decimal commas in a comma file when the cells are quoted', () => {
    expect(rowsOf('Tag,Weight\nUZ-1,"45,5"').map((r) => r.weightKg)).toEqual([45.5]);
  });

  it('reports the lines it cannot use, each with its reason, and guesses none', () => {
    const rows = rowsOf(
      ['Tag;Weight', 'UZ-1;45,5', ';50', 'UZ-3;', 'UZ-4;abc', 'UZ-5;1.234', 'UZ-6;0', 'UZ-7;100 lb', 'UZ-8;4500', '9.82E+14;45'].join('\n'),
    );
    expect(rows.map((r) => [r.line, r.problem, r.weightKg])).toEqual([
      [2, null, 45.5],
      [3, 'no_code', null],
      [4, 'no_weight', null],
      [5, 'not_a_number', null],
      [6, 'ambiguous', null],
      [7, 'not_positive', null],
      [8, 'unit', null],
      [9, 'too_heavy', null],
      [10, 'code_damaged', null],
    ]);
  });

  it('reads other columns when a person picks them', () => {
    const file = parseScaleFile('EID,VID,Weight\n982000123456789,UZ-1,45.5');
    expect(readScaleRows(file, { code: 1, weight: 2 })[0].code).toBe('UZ-1');
    expect(readScaleRows(file, { code: null, weight: 2 })[0].problem).toBe('no_code');
    expect(readScaleRows(file, { code: 1, weight: null })[0].problem).toBe('no_weight');
  });
});

describe('planScaleImport', () => {
  const animal = (over: Partial<ScaleAnimal>): ScaleAnimal => ({
    id: 'a1',
    tag: 'UZ-1',
    onFarm: true,
    herdId: 'h1',
    speciesKey: 'sheep',
    birthDate: '2024-03-01',
    matchedBy: 'tag',
    ...over,
  });
  const registry: Record<string, ScaleAnimal[]> = {
    'UZ-1': [animal({})],
    'UZ-2': [animal({ id: 'a2', tag: 'UZ-2', herdId: 'h2' })],
    'UZ-3': [animal({ id: 'a3', tag: 'UZ-3', onFarm: false })],
    '77': [animal({ id: 'a4', tag: '77' }), animal({ id: 'a5', tag: 'UZ-5', matchedBy: 'rfid' })],
    '982000123456789': [animal({ id: 'a6', tag: 'UZ-6', matchedBy: 'rfid' })],
    'UZ-7': [animal({ id: 'a7', tag: 'UZ-7', birthDate: '2026-12-01' })],
  };
  const campaign = { herdId: 'h1', date: '2026-11-10' };
  const plan = (text: string) => planScaleImport(rowsOf(text), (code) => registry[code] ?? [], campaign);

  it('sorts every line into what will happen to it', () => {
    const result = plan(
      ['Tag;Weight', 'UZ-1;45,5', 'UZ-2;50', 'UZ-3;48', '77;47', 'NOPE;44', 'UZ-1;abc', '982000123456789;52', 'UZ-7;4', 'UZ-1;300'].join('\n'),
    );
    expect(result.map((r) => [r.line, r.status])).toEqual([
      [2, 'ready'],
      [3, 'ready'],
      [4, 'not_on_farm'],
      [5, 'several'],
      [6, 'unmatched'],
      [7, 'unreadable'],
      [8, 'ready'],
      [9, 'before_birth'],
      [10, 'implausible'],
    ]);
    expect(result[1].otherHerd).toBe(true);
    expect(result[0].otherHerd).toBe(false);
    expect(result[3].candidates.map((a) => a.id)).toEqual(['a4', 'a5']);
    expect(result[8].maxKg).toBe(250);
  });

  it('marks a weight as read by electronic number only when the chip matched', () => {
    const result = plan('EID;Weight\n982000123456789;52\nUZ-1;45');
    expect(result.map((r) => r.method)).toEqual(['rfid', 'scale']);
  });

  it('keeps the later of two lines for one animal and lists the earlier as a duplicate', () => {
    const result = plan('Tag;Weight\nUZ-1;45\nUZ-2;50\nUZ-1;46,5');
    expect(result.map((r) => [r.line, r.status, r.replacedByLine])).toEqual([
      [2, 'duplicate', 4],
      [3, 'ready', null],
      [4, 'ready', null],
    ]);
    expect(result.filter((r) => r.status === 'ready').map((r) => r.weightKg)).toEqual([50, 46.5]);
  });

  it('an unreadable repeat does not replace a good line', () => {
    const result = plan('Tag;Weight\nUZ-1;45\nUZ-1;abc');
    expect(result.map((r) => r.status)).toEqual(['ready', 'unreadable']);
  });
});
