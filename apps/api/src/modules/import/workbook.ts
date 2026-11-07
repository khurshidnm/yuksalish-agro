/** Files the module hands out: blank templates, rows to fix, and data exports. */
import ExcelJS from 'exceljs';
import { PRODUCT_NAME } from '@yap/shared';
import type { Column, Template } from './check';
import { LISTS_SHEET } from './reader';
import { tr, trOptional, type LanguageCode } from './i18n';
import type { Cell } from './values';

/** Rows of a template that carry formats and dropdowns. Beyond this they still import. */
const PREPARED_ROWS = 2000;

const FORMATS: Record<Column['type'], string> = {
  text: '@',
  month: '@',
  any: 'General',
  date: 'dd.mm.yyyy',
  number: '#,##0.###',
  money: '#,##0',
};

/** Starts the note beside the example row in every language, which is how that row is recognised. */
export const EXAMPLE_MARK = '←';

const asDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

export function exampleValue(template: Template, column: Column, lang: LanguageCode): string | number | null {
  if (column.example !== undefined) return column.example;
  return trOptional(lang, `templates.${template.key}.columns.${column.key}.example`) ?? null;
}

const columnLabel = (template: Template, column: Column, lang: LanguageCode) =>
  tr(lang, `templates.${template.key}.columns.${column.key}.label`);

const headerText = (template: Template, column: Column, lang: LanguageCode) =>
  `${columnLabel(template, column, lang)}${column.required ? ' *' : ''}`;

function styleHeader(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5D3A' } };
  row.alignment = { vertical: 'middle', wrapText: true };
  row.height = 32;
}

const toBuffer = async (workbook: ExcelJS.Workbook) => Buffer.from(await workbook.xlsx.writeBuffer());

/** ExcelJS implements range validations but leaves them out of its type declarations. */
interface WithValidations {
  dataValidations: { add(address: string, validation: ExcelJS.DataValidation): void };
}

function addInstructions(workbook: ExcelJS.Workbook, template: Template, columns: Column[], lang: LanguageCode): void {
  const sheet = workbook.addWorksheet(tr(lang, 'workbook.instructionsSheet').slice(0, 31));
  sheet.columns = [{ width: 30 }, { width: 14 }, { width: 70 }];

  const title = sheet.addRow([tr(lang, `templates.${template.key}.title`)]);
  title.font = { bold: true, size: 14 };
  sheet.addRow([]);
  for (const n of [1, 2, 3, 4, 5]) sheet.addRow([tr(lang, `workbook.step${n}`)]);
  const note = trOptional(lang, `templates.${template.key}.note`);
  if (note) {
    sheet.addRow([]);
    sheet.addRow([note]);
  }
  sheet.addRow([]);

  styleHeader(sheet.addRow([tr(lang, 'workbook.column'), tr(lang, 'workbook.required'), tr(lang, 'workbook.description')]));
  for (const column of columns) {
    const row = sheet.addRow([
      columnLabel(template, column, lang),
      column.required ? tr(lang, 'workbook.yes') : tr(lang, 'workbook.no'),
      trOptional(lang, `templates.${template.key}.columns.${column.key}.hint`) ?? '',
    ]);
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
  }
}

export async function buildTemplate(
  template: Template,
  columns: Column[],
  lists: Record<string, string[]>,
  lang: LanguageCode,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = PRODUCT_NAME;
  const sheet = workbook.addWorksheet(tr(lang, `templates.${template.key}.sheet`).slice(0, 31), {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = columns.map((column) => ({
    header: headerText(template, column, lang),
    width: column.width ?? 16,
    style: { numFmt: FORMATS[column.type] },
  }));
  styleHeader(sheet.getRow(1));

  const example = sheet.getRow(2);
  columns.forEach((column, index) => {
    const value = exampleValue(template, column, lang);
    if (value === null) return;
    const isDate = (column.type === 'date' || column.type === 'any') && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    const cell = example.getCell(index + 1);
    cell.value = isDate ? asDate(value as string) : value;
    if (isDate) cell.numFmt = FORMATS.date;
  });
  example.font = { italic: true, color: { argb: 'FF6B6B6B' } };
  example.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5EFD9' } };
  // Outside the table, so it has no header and is never read as data.
  example.getCell(columns.length + 1).value = tr(lang, 'workbook.exampleMark');

  const listSheet = workbook.addWorksheet(LISTS_SHEET, { state: 'hidden' });
  let listColumn = 0;
  columns.forEach((column, index) => {
    const values = column.list ? lists[column.list] : undefined;
    if (!values?.length) return;
    listColumn += 1;
    values.forEach((value, row) => {
      listSheet.getCell(row + 1, listColumn).value = value;
    });
    const letter = listSheet.getColumn(listColumn).letter;
    const target = sheet.getColumn(index + 1).letter;
    (sheet as unknown as WithValidations).dataValidations.add(`${target}2:${target}${PREPARED_ROWS + 1}`, {
      type: 'list',
      allowBlank: true,
      formulae: [`${LISTS_SHEET}!$${letter}$1:$${letter}$${values.length}`],
      // A warning, not a block: Cyrillic or Russian spellings are accepted on upload.
      showErrorMessage: true,
      errorStyle: 'warning',
      errorTitle: tr(lang, 'workbook.notInListTitle'),
      error: tr(lang, 'workbook.notInList'),
    });
  });

  addInstructions(workbook, template, columns, lang);
  return toBuffer(workbook);
}

/** The rows that failed, with the same headers, so the file can be fixed and uploaded again. */
export async function buildErrorWorkbook(
  template: Template,
  columns: Column[],
  rows: { row: number; values: Record<string, Cell>; reasons: string[] }[],
  lang: LanguageCode,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(tr(lang, `templates.${template.key}.sheet`).slice(0, 31), {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = [
    ...columns.map((column) => ({ header: headerText(template, column, lang), width: column.width ?? 16 })),
    { header: tr(lang, 'workbook.errorColumn'), width: 60 },
  ];
  styleHeader(sheet.getRow(1));
  for (const row of rows) {
    const added = sheet.addRow([...columns.map((c) => row.values[c.key] ?? null), row.reasons.join('; ')]);
    const reason = added.getCell(columns.length + 1);
    reason.font = { color: { argb: 'FFB3261E' } };
    reason.alignment = { wrapText: true, vertical: 'top' };
  }
  return toBuffer(workbook);
}

export interface ExportColumn {
  header: string;
  kind?: 'date' | 'number';
}

export async function exportXlsx(sheetName: string, columns: ExportColumn[], rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map((column) => ({
    header: column.header,
    width: Math.max(14, column.header.length + 4),
    style: column.kind === 'date' ? { numFmt: FORMATS.date } : {},
  }));
  styleHeader(sheet.getRow(1));
  for (const row of rows) {
    sheet.addRow(row.map((value, i) => (columns[i].kind === 'date' && typeof value === 'string' ? asDate(value) : (value ?? null))));
  }
  return toBuffer(workbook);
}

/**
 * A cell starting with = + - @ runs as a formula when a CSV is opened in Excel, and these values
 * were typed by other people (CSV injection). Plain numbers and phones are harmless and stay as
 * they are. An apostrophe disarms the rest; our CSV reader removes it again.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^[+-]?\d[\d\s.,]*$/.test(text)) text = `'${text}`;
  return /[";\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Semicolons, and a BOM so Cyrillic survives: Excel with Russian or Uzbek settings needs both. */
export function exportCsv(columns: ExportColumn[], rows: unknown[][]): Buffer {
  const lines = [columns.map((c) => csvCell(c.header)), ...rows.map((row) => row.map(csvCell))].map((cells) => cells.join(';'));
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}
