import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import pdfmake from 'pdfmake';
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';

const fontDir = join(dirname(createRequire(import.meta.url).resolve('pdfmake/package.json')), 'fonts', 'Roboto');

// Roboto covers Latin and Cyrillic, including the Uzbek letters ў, қ, ғ and ҳ.
pdfmake.addFonts({
  Roboto: {
    normal: join(fontDir, 'Roboto-Regular.ttf'),
    bold: join(fontDir, 'Roboto-Medium.ttf'),
    italics: join(fontDir, 'Roboto-Italic.ttf'),
    bolditalics: join(fontDir, 'Roboto-MediumItalic.ttf'),
  },
});

// These documents never need the network or the disk beyond the fonts.
const policies = pdfmake as unknown as {
  setUrlAccessPolicy(callback: (url: string) => boolean): void;
  setLocalAccessPolicy(callback: (path: string) => boolean): void;
};
policies.setUrlAccessPolicy(() => false);
policies.setLocalAccessPolicy((path) => path.startsWith(fontDir));

export interface DocumentLayout {
  title: string;
  docNo: string;
  farm: string;
  /** Label and value pairs under the title. */
  details: [string, string][];
  /** First row is the header. */
  table: TableCell[][];
  widths: (string | number)[];
  /** Summary lines under the table. */
  footer?: string[];
  signatures: string[];
}

function signatureBlock(names: string[]): Content {
  return {
    margin: [0, 32, 0, 0],
    columns: names.map((name) => ({
      stack: [
        { text: name, fontSize: 9, color: '#444444' },
        {
          canvas: [{ type: 'line', x1: 0, y1: 24, x2: 150, y2: 24, lineWidth: 0.5, lineColor: '#888888' }],
        },
      ],
    })),
  };
}

/** Roboto has no ʻ or ʼ. Names typed with them would print as empty boxes. */
function withPrintableApostrophes(doc: DocumentLayout): DocumentLayout {
  return JSON.parse(JSON.stringify(doc).replace(/[ʻʼ]/g, "'"));
}

export function renderDocument(source: DocumentLayout): Promise<Buffer> {
  const doc = withPrintableApostrophes(source);
  const definition: TDocumentDefinitions = {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 48],
    defaultStyle: { font: 'Roboto', fontSize: 10 },
    info: { title: `${doc.title} ${doc.docNo}` },
    content: [
      { text: doc.farm, fontSize: 10, color: '#444444' },
      { text: `${doc.title} № ${doc.docNo}`, fontSize: 15, bold: true, margin: [0, 6, 0, 10] },
      {
        table: {
          widths: ['auto', '*'],
          body: doc.details.map(([label, value]) => [{ text: label, color: '#555555' }, value]),
        },
        layout: 'noBorders',
        margin: [0, 0, 0, 12],
      },
      {
        table: { headerRows: 1, widths: doc.widths, body: doc.table },
        layout: {
          fillColor: (row: number) => (row === 0 ? '#EEF2EC' : null),
          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
          hLineColor: () => '#B8BDB5',
          vLineColor: () => '#B8BDB5',
          paddingTop: () => 4,
          paddingBottom: () => 4,
        },
      },
      ...(doc.footer?.length
        ? [{ margin: [0, 10, 0, 0], stack: doc.footer.map((text) => ({ text, bold: true, alignment: 'right' })) } as Content]
        : []),
      signatureBlock(doc.signatures),
    ],
  };
  return pdfmake.createPdf(definition).getBuffer();
}
