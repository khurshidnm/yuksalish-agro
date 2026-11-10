import { type ScaleAnimal, parseScaleFile, planScaleImport, readScaleRows } from '@yap/shared/formulas/scale-file';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ScannedItemLine, type ScannedItem } from '@/features/inventory/ScanItem';
import i18n from '@/lib/i18n';
import { ScalePlanView, ScaleResultView } from './ScaleImportDialog';
import { ScannedAnimalLine, type ScannedAnimal } from './ScanAnimal';
import { type CodeMatches, bulkEntries, chosenRows, codesToMatch, matcherOf } from './scale-import';

vi.mock('sonner', () => ({ toast: {} }));

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterAll(async () => {
  await i18n.changeLanguage('uz');
});

const HERD = 'herd-1';
const animal = (id: string, tag: string, more: Partial<ScaleAnimal> = {}): ScaleAnimal => ({
  id,
  tag,
  onFarm: true,
  herdId: HERD,
  speciesKey: 'sheep',
  birthDate: '2024-03-01',
  matchedBy: 'tag',
  ...more,
});

/**
 * A morning at the scale, as the indicator saves it. Line 1 is the heading.
 *  2 YA-001 45,5   ready
 *  3 YA-002 51.2   weighed again on line 9: the later line stands
 *  4 YA-404 40     no such animal
 *  5 (none) 38     no tag on the line
 *  6 YA-003 abc    not a weight
 *  7 YA-TWIN 44    two animals carry the tag
 *  8 YA-SOLD 60    sold last month
 *  9 YA-002 52,0   ready (the correction)
 * 10 982000123456789 47,3  named by its electronic number, and from another herd
 * 11 YA-005 400    heavier than a sheep can be
 */
const FILE = [
  'Tag;Weight kg',
  'YA-001;45,5',
  'YA-002;51.2',
  'YA-404;40',
  ';38',
  'YA-003;abc',
  'YA-TWIN;44',
  'YA-SOLD;60',
  'YA-002;52,0',
  '982000123456789;47,3',
  'YA-005;400',
].join('\r\n');

const SERVER: CodeMatches[] = [
  { code: 'YA-001', matches: [animal('a1', 'YA-001')] },
  { code: 'YA-002', matches: [animal('a2', 'YA-002')] },
  { code: 'YA-404', matches: [] },
  { code: 'YA-TWIN', matches: [animal('t1', 'YA-TWIN'), animal('t2', 'ya-twin')] },
  { code: 'YA-SOLD', matches: [animal('s1', 'YA-SOLD', { onFarm: false })] },
  { code: '982000123456789', matches: [animal('a4', 'YA-004', { matchedBy: 'rfid', herdId: 'herd-2' })] },
  { code: 'YA-005', matches: [animal('a5', 'YA-005')] },
];

const rows = readScaleRows(parseScaleFile(FILE));
const plan = planScaleImport(rows, matcherOf(SERVER), { herdId: HERD, date: '2026-11-10' });
const none = new Set<number>();

describe('from the file to what is sent', () => {
  it('asks the server about each usable code once, and not about lines that cannot be used', () => {
    expect(codesToMatch(rows)).toEqual(['YA-001', 'YA-002', 'YA-404', 'YA-TWIN', 'YA-SOLD', '982000123456789', 'YA-005']);
  });

  it('a code the server said nothing about matches no animal', () => {
    expect(matcherOf(SERVER)('YA-999')).toEqual([]);
    expect(matcherOf([])('YA-001')).toEqual([]);
  });

  it('decides every line', () => {
    expect(plan.map((row) => [row.line, row.status])).toEqual([
      [2, 'ready'],
      [3, 'duplicate'],
      [4, 'unmatched'],
      [5, 'unreadable'],
      [6, 'unreadable'],
      [7, 'several'],
      [8, 'not_on_farm'],
      [9, 'ready'],
      [10, 'ready'],
      [11, 'implausible'],
    ]);
  });

  it('sends only the ready lines, each naming its animal by id, the later weight for an animal weighed twice', () => {
    expect(bulkEntries(plan, none)).toEqual([
      { code: 'YA-001', animalId: 'a1', weightKg: 45.5, method: 'scale' },
      { code: 'YA-002', animalId: 'a2', weightKg: 52, method: 'scale' },
      // Named by its electronic number in the file: the weight is recorded as read by RFID.
      { code: '982000123456789', animalId: 'a4', weightKg: 47.3, method: 'rfid' },
    ]);
  });

  it('leaves out a line the person unticked, and never sends one that is not ready', () => {
    expect(bulkEntries(plan, new Set([2, 10])).map((entry) => entry.animalId)).toEqual(['a2']);
    // Unticking is by line number: a line that was never ready stays out whatever the set holds.
    expect(chosenRows(plan, new Set([4, 7, 11])).map((row) => row.line)).toEqual([2, 9, 10]);
    expect(bulkEntries(plan, new Set([2, 9, 10]))).toEqual([]);
  });

  it('sends nothing when no animal was matched', () => {
    const unmatched = planScaleImport(rows, matcherOf([]), { herdId: HERD, date: '2026-11-10' });
    expect(bulkEntries(unmatched, none)).toEqual([]);
  });
});

describe('the preview', () => {
  // Rendered inside each test: the language is set only once the tests run.
  const render = () => renderToStaticMarkup(<ScalePlanView plan={plan} excluded={new Set([9])} />);
  /** A sentence as React writes it into markup. */
  const said = (key: string, values?: Record<string, unknown>) => i18n.t(key, values).replace(/&/g, '&amp;').replace(/'/g, '&#x27;');

  it('counts what will be recorded and what is left out', () => {
    const markup = render();
    expect(markup).toContain(said('scan:scale.ready', { n: '2', of: '3' }));
    expect(markup).toContain(said('scan:scale.left', { n: '7' }));
  });

  it('has a tick for every ready line, off for the one the person unticked', () => {
    const markup = render();
    expect(markup.match(/role="checkbox"/g)).toHaveLength(3);
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(2);
    expect(markup.match(/aria-checked="false"/g)).toHaveLength(1);
  });

  it('marks a weight read by electronic number and an animal from another herd', () => {
    const markup = render();
    expect(markup).toContain(said('scan:scale.byRfid'));
    expect(markup).toContain(said('scan:scale.otherHerd'));
    // The animal is shown by its tag, not by the long number the file carried.
    expect(markup).toContain('YA-004');
  });

  it('lists every line left out, each with its own reason', () => {
    const markup = render();
    const statuses = [...markup.matchAll(/data-scale-status="([a-z_]+)"/g)].map((match) => match[1]);
    expect(statuses).toEqual(['duplicate', 'unmatched', 'unreadable', 'unreadable', 'several', 'not_on_farm', 'implausible']);
    expect(markup).toContain(said('scan:scale.status.duplicate', { line: 9 }));
    expect(markup).toContain(said('scan:scale.status.unmatched'));
    expect(markup).toContain(said('scan:scale.problem.no_code'));
    expect(markup).toContain(said('scan:scale.problem.not_a_number'));
    // Both animals that share the tag are named, so the person can tell which to fix.
    expect(markup).toContain(said('scan:scale.status.several', { tags: 'YA-TWIN, ya-twin' }));
    expect(markup).toContain(said('scan:scale.status.not_on_farm', { tag: 'YA-SOLD' }));
    expect(markup).toContain(said('scan:scale.status.implausible', { max: '250' }));
  });

  it('says so when no line can be recorded', () => {
    const unmatched = planScaleImport(rows, matcherOf([]), { herdId: HERD, date: '2026-11-10' });
    const empty = renderToStaticMarkup(<ScalePlanView plan={unmatched} excluded={none} />);
    expect(empty).toContain(i18n.t('scan:scale.none'));
    expect(empty).not.toContain('role="checkbox"');
  });

  it.each(['uz', 'ru', 'en'])('words every reason in %s', (lng) => {
    const t = i18n.getFixedT(lng, 'scan');
    for (const status of ['unmatched', 'several', 'not_on_farm', 'implausible', 'before_birth', 'duplicate']) {
      expect(t(`scale.status.${status}`, { tags: 'A', tag: 'A', max: '1', line: 1 })).not.toContain('scale.status');
    }
    for (const problem of ['no_code', 'code_damaged', 'no_weight', 'not_a_number', 'ambiguous', 'unit', 'not_positive', 'too_heavy']) {
      expect(t(`scale.problem.${problem}`)).not.toContain('scale.problem');
    }
  });
});

describe('after sending', () => {
  it('says how many weights were recorded', () => {
    const markup = renderToStaticMarkup(<ScaleResultView result={{ applied: 3, failed: [] }} />);
    expect(markup).toContain(i18n.t('scan:scale.done.applied', { n: '3' }));
    expect(markup).not.toContain('<ul');
  });

  it('names each line the server refused, with the reason in words and no raw code', () => {
    const markup = renderToStaticMarkup(
      <ScaleResultView
        result={{
          applied: 1,
          failed: [
            { code: 'YA-SOLD', error: 'ANIMAL_NOT_ON_FARM' },
            { code: 'YA-005', error: 'WEIGHT_NOT_PLAUSIBLE' },
            { code: 'YA-009', error: 'ANIMAL_NOT_FOUND' },
          ],
        }}
      />,
    );
    expect(markup).toContain(i18n.t('scan:scale.done.failed', { n: '3' }));
    expect(markup).toContain('YA-SOLD');
    expect(markup).not.toMatch(/ANIMAL_NOT_ON_FARM|WEIGHT_NOT_PLAUSIBLE|ANIMAL_NOT_FOUND/);
    // No sentence is shown with a hole where a number should be.
    expect(markup).not.toMatch(/\{\{|\}\}/);
  });
});

describe('the "which one?" lines of a scan', () => {
  const ewe: ScannedAnimal = {
    id: 'a1',
    tag: 'YA-0042',
    status: 'active',
    onFarm: true,
    herdId: HERD,
    herdName: 'Ewes 1',
    category: 'ewe',
    sex: 'female',
    speciesKey: 'sheep',
    birthDate: '2024-03-01',
    matchedBy: 'tag',
    exact: true,
  };

  it('an animal is shown by tag, kind and herd', () => {
    const markup = renderToStaticMarkup(<ScannedAnimalLine animal={ewe} />);
    expect(markup).toContain('YA-0042');
    expect(markup).toContain(`${i18n.t('enums:animalCategory.ewe')} · Ewes 1`);
  });

  it('an animal that has left the farm says so', () => {
    const sold = renderToStaticMarkup(<ScannedAnimalLine animal={{ ...ewe, status: 'sold', onFarm: false }} />);
    expect(sold).toContain(i18n.t('enums:animalStatus.sold'));
    expect(renderToStaticMarkup(<ScannedAnimalLine animal={ewe} />)).not.toContain(i18n.t('enums:animalStatus.sold'));
  });

  it('an item is shown by name, category and its own code, and a switched-off one says so', () => {
    const barley: ScannedItem = { id: 'i1', name: 'Barley', category: 'feed', unit: 'kg', defaultWarehouseId: null, sku: 'FD-01', barcode: '4780012345678', active: true, matchedBy: 'barcode', exact: true };
    const markup = renderToStaticMarkup(<ScannedItemLine item={barley} />);
    expect(markup).toContain('Barley');
    expect(markup).toContain(`${i18n.t('enums:itemCategory.feed')} · FD-01`);
    expect(markup).not.toContain(i18n.t('scan:item.switchedOff'));
    expect(renderToStaticMarkup(<ScannedItemLine item={{ ...barley, active: false }} />)).toContain(i18n.t('scan:item.switchedOff'));
  });
});
