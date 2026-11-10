/**
 * Pictures of codes for the tests, as the grey bytes a camera frame becomes. No camera and no
 * canvas: a QR is drawn from the same SVG the label sheet prints, and bar codes are drawn bar by bar.
 *
 * Only tests import this file.
 */
import { Code128Reader, Code39Reader, EAN13Reader } from '@zxing/library';

export interface Picture {
  grey: Uint8ClampedArray;
  width: number;
  height: number;
}

const WHITE = 255;
const BLACK = 0;

/**
 * The first QR in a piece of markup rendered by qrcode.react, at `scale` pixels a module. The dark
 * modules are one path of row runs: "M2 2h7v1H2z". The margin (quiet zone) is part of the drawing.
 */
export function qrPicture(markup: string, scale = 6): Picture {
  const side = Number(/viewBox="0 0 (\d+) \d+"/.exec(markup)?.[1]);
  const path = /<path fill="#000000" d="([^"]+)"/.exec(markup)?.[1];
  if (!side || !path) throw new Error('no QR code in the markup');
  const width = side * scale;
  const grey = new Uint8ClampedArray(width * width).fill(WHITE);
  for (const [, x, y, length] of path.matchAll(/M(\d+)[ ,](\d+) ?h(\d+)v1H\d+z/g)) {
    for (let row = Number(y) * scale; row < (Number(y) + 1) * scale; row += 1) {
      grey.fill(BLACK, row * width + Number(x) * scale, row * width + (Number(x) + Number(length)) * scale);
    }
  }
  return { grey, width, height: width };
}

/** Every QR in the markup, in order. */
export function qrPictures(markup: string, scale = 6): Picture[] {
  return markup
    .split('<svg')
    .slice(1)
    .filter((part) => part.includes('fill="#000000"'))
    .map((part) => qrPicture(`<svg${part}`, scale));
}

/** A bar code from the widths of its bars and spaces, starting with a bar, with white on both sides. */
function barPicture(widths: number[], scale = 3, height = 80): Picture {
  const quiet = 12;
  const modules = widths.reduce((sum, width) => sum + width, 0) + quiet * 2;
  const row = new Uint8ClampedArray(modules * scale).fill(WHITE);
  let at = quiet * scale;
  widths.forEach((width, index) => {
    if (index % 2 === 0) row.fill(BLACK, at, at + width * scale);
    at += width * scale;
  });
  const grey = new Uint8ClampedArray(row.length * height);
  for (let y = 0; y < height; y += 1) grey.set(row, y * row.length);
  return { grey, width: row.length, height };
}

/** The library's own tables of bar widths. They are private there, and they are the standards' tables. */
const CODE_128 = (Code128Reader as unknown as { CODE_PATTERNS: Int32Array[] }).CODE_PATTERNS;
const CODE_39 = Code39Reader as unknown as { ALPHABET_STRING: string; CHARACTER_ENCODINGS: number[]; ASTERISK_ENCODING: number };

/** Code 128, set B: start B, the characters, the check character (weighted sum mod 103), stop. */
export function code128Picture(text: string): Picture {
  const START_B = 104;
  const STOP = 106;
  const values = [...text].map((char) => char.charCodeAt(0) - 32);
  if (values.some((value) => value < 0 || value > 95)) throw new Error('not a set B character');
  const check = values.reduce((sum, value, index) => sum + value * (index + 1), START_B) % 103;
  return barPicture([START_B, ...values, check, STOP].flatMap((code) => [...CODE_128[code]!]));
}

/** Code 39: nine elements a character, three of them wide, a narrow gap between characters, "*" at both ends. */
export function code39Picture(text: string): Picture {
  const widthsOf = (encoding: number) => Array.from({ length: 9 }, (_, index) => ((encoding >> (8 - index)) & 1 ? 3 : 1));
  const chars = [...text].map((char) => {
    const at = CODE_39.ALPHABET_STRING.indexOf(char);
    if (at < 0) throw new Error('not a Code 39 character');
    return CODE_39.CHARACTER_ENCODINGS[at]!;
  });
  return barPicture([CODE_39.ASTERISK_ENCODING, ...chars, CODE_39.ASTERISK_ENCODING].flatMap((encoding, index) => (index === 0 ? widthsOf(encoding) : [1, ...widthsOf(encoding)])));
}

/** Which of the left six digits use the "G" drawing, by the first digit of an EAN-13. */
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

export function ean13CheckDigit(first12: string): number {
  const sum = [...first12].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}

/** EAN-13 from its first twelve digits: guard, six digits, middle guard, six digits, guard. */
export function ean13Picture(first12: string): Picture {
  if (!/^\d{12}$/.test(first12)) throw new Error('twelve digits');
  const digits = [...`${first12}${ean13CheckDigit(first12)}`].map(Number);
  const parity = EAN_PARITY[digits[0]!]!;
  const left = digits.slice(1, 7).flatMap((digit, index) => [...EAN13Reader.L_AND_G_PATTERNS[parity[index] === 'G' ? digit + 10 : digit]!]);
  const right = digits.slice(7).flatMap((digit) => [...EAN13Reader.L_PATTERNS[digit]!]);
  // Guards start with a bar; the left digits start with a space, so the widths keep alternating.
  return barPicture([1, 1, 1, ...left, 1, 1, 1, 1, 1, ...right, 1, 1, 1]);
}

/** The same picture as a canvas would give it: four bytes a pixel. */
export function rgbaOf(picture: Picture): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(picture.grey.length * 4);
  picture.grey.forEach((value, index) => rgba.set([value, value, value, 255], index * 4));
  return rgba;
}
