/**
 * Excel, CSV and PDF. Each exporter takes a finished ReportResult, which only holds what the
 * caller may see, so no format can leak a column the engine withheld.
 */
import ExcelJS from 'exceljs';
import { PRODUCT_NAME, todayIso } from '@yap/shared';
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { formatIsoDate, formatIsoMonth, formatNumber, formatPeriod, t } from './i18n';
import { printable, renderPdf } from './pdf';
import type { Lang, ReportResult, ResultColumn, Row } from './types';

export const EXPORT_FORMATS = ['xlsx', 'csv', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** A PDF of this size is unreadable and slow to build. Excel and CSV have no such limit. */
export const PDF_ROW_LIMIT = 5000;

const CONTENT_TYPES: Record<ExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
};

const isNumeric = (column: ResultColumn) => ['integer', 'number', 'money', 'percent'].includes(column.type);

/** Lines shown above the table in every format. */
function headerLines(result: ReportResult): string[] {
  const { lang } = result;
  const compare = result.compareWith && 'from' in result.compareWith ? result.compareWith : null;
  return [
    [result.tenantName, result.farmName].filter(Boolean).join(' — '),
    result.title,
    ...(result.period ? [`${t(lang, 'export.period')}: ${formatPeriod(result.period)}`] : []),
    ...(compare ? [`${t(lang, 'export.compareWith')}: ${formatPeriod(compare)}`] : []),
    ...result.filterSummary.map((f) => `${f.label}: ${f.value}`),
    `${t(lang, 'export.generated')}: ${generatedAt(result)}`,
  ];
}

function generatedAt(result: ReportResult): string {
  const at = new Date(result.generatedAt);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: result.timezone, hour: '2-digit', minute: '2-digit' }).format(at);
  return `${formatIsoDate(todayIso(result.timezone, at))} ${time}`;
}

/** Human-readable cell, for PDF and Telegram. Null is a dash, never 0. */
export function displayCell(column: ResultColumn, value: unknown, lang: Lang): string {
  if (value === null || value === undefined) return '—';
  switch (column.type) {
    case 'money':
      return formatNumber(value as number, 0, lang);
    case 'integer':
      return formatNumber(value as number, 0, lang);
    case 'number':
      return formatNumber(value as number, column.digits ?? 3, lang);
    case 'percent':
      return `${formatNumber(value as number, column.digits ?? 1, lang)}%`;
    case 'date':
      return formatIsoDate(String(value));
    case 'month':
      return formatIsoMonth(String(value));
    case 'boolean':
      return t(lang, value ? 'common.yes' : 'common.no');
    default:
      return String(value);
  }
}

// ─── Excel ─────────────────────────────────────────────────────────────────

function excelFormat(column: ResultColumn): string | undefined {
  switch (column.type) {
    case 'money':
    case 'integer':
      return '#,##0';
    case 'number': {
      const digits = column.digits ?? 3;
      return digits > 0 ? `#,##0.${'0'.repeat(digits)}` : '#,##0';
    }
    case 'percent':
      return '0.0%';
    case 'date':
      return 'dd.mm.yyyy';
    default:
      return undefined;
  }
}

/** Real numbers and dates, so a bookkeeper can sum and filter them. */
function excelValue(column: ResultColumn, value: unknown, lang: Lang): ExcelJS.CellValue {
  if (value === null || value === undefined) return null;
  switch (column.type) {
    case 'percent':
      return (value as number) / 100;
    case 'date':
      return new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
    case 'month':
      return formatIsoMonth(String(value));
    case 'boolean':
      return t(lang, value ? 'common.yes' : 'common.no');
    case 'integer':
    case 'number':
    case 'money':
      return value as number;
    default:
      return String(value);
  }
}

function sheetName(title: string): string {
  return title.replace(/[\\/*?:[\]]/g, ' ').slice(0, 31).trim() || 'Report';
}

function columnWidth(column: ResultColumn, rows: Row[], lang: Lang): number {
  const longest = rows
    .slice(0, 200)
    .reduce((max, row) => Math.max(max, displayCell(column, row[column.key], lang).length), column.label.length);
  return Math.min(Math.max(longest + 2, 10), 42);
}

export async function toXlsx(result: ReportResult): Promise<Buffer> {
  const { lang, columns, rows, totals } = result;
  const book = new ExcelJS.Workbook();
  book.creator = PRODUCT_NAME;
  book.created = new Date(result.generatedAt);
  const sheet = book.addWorksheet(sheetName(result.title));

  headerLines(result).forEach((line, index) => {
    const row = sheet.addRow([line]);
    row.getCell(1).font = index === 1 ? { bold: true, size: 14 } : { size: 10, color: { argb: 'FF555555' } };
  });
  for (const note of result.notes) sheet.addRow([note]).getCell(1).font = { size: 10, italic: true };
  sheet.addRow([]);

  const header = sheet.addRow(columns.map((c) => c.label));
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6ECE3' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF9AA596' } } };
  });

  const write = (values: Row, bold: boolean) => {
    const row = sheet.addRow(columns.map((c) => excelValue(c, values[c.key], lang)));
    columns.forEach((column, index) => {
      const format = excelFormat(column);
      const cell = row.getCell(index + 1);
      if (format) cell.numFmt = format;
      if (bold) cell.font = { bold: true };
    });
    return row;
  };
  for (const row of rows) write(row, false);

  if (totals) {
    const row = write(totals, true);
    const first = columns.findIndex((c) => !isNumeric(c));
    if (first >= 0 && totals[columns[first].key] === undefined) row.getCell(first + 1).value = t(lang, 'export.total');
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = { top: { style: 'thin', color: { argb: 'FF9AA596' } } };
    });
  }

  columns.forEach((column, index) => {
    sheet.getColumn(index + 1).width = columnWidth(column, rows, lang);
  });
  sheet.views = [{ state: 'frozen', ySplit: header.number }];
  if (rows.length) {
    sheet.autoFilter = { from: { row: header.number, column: 1 }, to: { row: header.number, column: columns.length } };
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

// ─── CSV ───────────────────────────────────────────────────────────────────

/** A text cell starting like this would run as a formula when the file opens in a spreadsheet. */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string, isText: boolean): string {
  const safe = isText && FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function csvValue(column: ResultColumn, value: unknown, lang: Lang): string {
  if (value === null || value === undefined) return '';
  if (isNumeric(column)) return csvCell(String(value), false);
  if (column.type === 'date') return csvCell(String(value).slice(0, 10), false);
  if (column.type === 'month') return csvCell(String(value), false);
  if (column.type === 'boolean') return csvCell(t(lang, value ? 'common.yes' : 'common.no'), true);
  return csvCell(String(value), true);
}

export function toCsv(result: ReportResult): Buffer {
  const { lang, columns, rows, totals } = result;
  const lines = [...headerLines(result).map((line) => csvCell(line, true)), ...result.notes.map((n) => csvCell(n, true)), ''];
  lines.push(columns.map((c) => csvCell(c.label, true)).join(','));
  for (const row of rows) lines.push(columns.map((c) => csvValue(c, row[c.key], lang)).join(','));
  if (totals) {
    const first = columns.findIndex((c) => !isNumeric(c));
    lines.push(
      columns
        .map((c, index) =>
          index === first && totals[c.key] === undefined ? csvCell(t(lang, 'export.total'), true) : csvValue(c, totals[c.key], lang),
        )
        .join(','),
    );
  }
  // The byte order mark tells Excel this is UTF-8, otherwise Uzbek and Russian text is garbled.
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

// ─── PDF ───────────────────────────────────────────────────────────────────

function pdfFontSize(columnCount: number): number {
  if (columnCount <= 6) return 9;
  return columnCount <= 10 ? 8 : 7;
}

/** The document model, kept separate from rendering because PDF text cannot be read back. */
export function reportPdfDefinition(result: ReportResult): TDocumentDefinitions {
  const { lang, columns, totals } = result;
  const rows = result.rows.slice(0, PDF_ROW_LIMIT);
  const size = pdfFontSize(columns.length);

  const cell = (column: ResultColumn, value: unknown, bold = false): TableCell => ({
    text: printable(displayCell(column, value, lang)),
    alignment: isNumeric(column) ? 'right' : 'left',
    bold,
  });

  const body: TableCell[][] = [
    columns.map((c) => ({ text: printable(c.label), bold: true, alignment: isNumeric(c) ? 'right' : 'left' })),
    ...rows.map((row) => columns.map((c) => cell(c, row[c.key]))),
  ];
  if (totals) {
    const first = columns.findIndex((c) => !isNumeric(c));
    body.push(
      columns.map((c, index) =>
        index === first && totals[c.key] === undefined
          ? { text: t(lang, 'export.total'), bold: true }
          : c.key in totals
            ? cell(c, totals[c.key], true)
            : { text: '' },
      ),
    );
  }

  const [farm, title, ...details] = headerLines(result).map(printable);
  const firstText = columns.findIndex((c) => !isNumeric(c) && c.type !== 'date' && c.type !== 'month');
  const notes = [
    ...result.notes,
    ...(result.rowCount > PDF_ROW_LIMIT ? [t(lang, 'export.pdfTruncated', { shown: PDF_ROW_LIMIT, total: result.rowCount })] : []),
  ];
  const content: Content[] = [
    { text: farm, fontSize: 10, color: '#444444' },
    { text: title, fontSize: 15, bold: true, margin: [0, 4, 0, 6] },
    ...details.map((line): Content => ({ text: line, fontSize: 9, color: '#555555' })),
    ...notes.map((line): Content => ({ text: printable(line), fontSize: 9, italics: true, margin: [0, 2, 0, 0] })),
    {
      margin: [0, 10, 0, 0],
      table: {
        headerRows: 1,
        dontBreakRows: true,
        widths: columns.map((_, index) => (index === (firstText < 0 ? 0 : firstText) ? '*' : 'auto')),
        body,
      },
      layout: {
        fillColor: (row: number) => (row === 0 ? '#E6ECE3' : totals && row === body.length - 1 ? '#F2F4F0' : null),
        hLineWidth: () => 0.4,
        vLineWidth: () => 0,
        hLineColor: () => '#B8BDB5',
        paddingTop: () => 3,
        paddingBottom: () => 3,
        paddingLeft: () => 4,
        paddingRight: () => 4,
      },
    },
  ];

  return {
    pageSize: 'A4',
    pageOrientation: columns.length > 6 ? 'landscape' : 'portrait',
    pageMargins: [32, 32, 32, 40],
    defaultStyle: { font: 'Roboto', fontSize: size },
    info: { title: printable(result.title) },
    footer: (page: number, pages: number) => ({
      text: `${page} / ${pages}`,
      alignment: 'right',
      fontSize: 8,
      color: '#777777',
      margin: [0, 12, 32, 0],
    }),
    content,
  };
}

export const toPdf = (result: ReportResult): Promise<Buffer> => renderPdf(reportPdfDefinition(result));

export async function exportReport(result: ReportResult, format: ExportFormat) {
  const body = format === 'xlsx' ? await toXlsx(result) : format === 'csv' ? toCsv(result) : await toPdf(result);
  const stamp = result.period ? `_${result.period.from}_${result.period.to}` : '';
  return { body, contentType: CONTENT_TYPES[format], filename: `${result.key.replace('.', '_')}${stamp}.${format}` };
}
