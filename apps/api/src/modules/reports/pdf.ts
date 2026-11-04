import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import pdfmake from 'pdfmake';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';

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

// Reports never need the network, or the disk beyond the fonts.
const policies = pdfmake as unknown as {
  setUrlAccessPolicy(callback: (url: string) => boolean): void;
  setLocalAccessPolicy(callback: (path: string) => boolean): void;
};
policies.setUrlAccessPolicy(() => false);
policies.setLocalAccessPolicy((path) => path.startsWith(fontDir));

/** Roboto has no ʻ or ʼ. Names typed with them would print as empty boxes. */
export const printable = (text: string): string => text.replace(/[ʻʼ]/g, "'");

export function renderPdf(definition: TDocumentDefinitions): Promise<Buffer> {
  return pdfmake.createPdf(definition).getBuffer();
}
