import { matchScan, normalizeScan, scanKeyVariants } from '@yap/shared/formulas/scan-code';
import { QRCodeSVG } from 'qrcode.react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScanVideo } from './scanner';
import { type Picture, code128Picture, code39Picture, ean13CheckDigit, ean13Picture, qrPicture, rgbaOf } from './test-pictures';
import { createDetector, decodeLuminance, frameSize, luminanceOf } from './zxing-detector';

const read = (picture: Picture) => decodeLuminance(picture.grey, picture.width, picture.height);
const qrOf = (value: string, scale?: number) => qrPicture(renderToStaticMarkup(createElement(QRCodeSVG, { value, level: 'M', marginSize: 2 })), scale);

describe('the JavaScript reader: every format the scan dialog promises', () => {
  it.each(['YA-0042', 'UZ 860 000123', '4780012345678', 'Qo\'y-17', '018f3c2e-7d4a-7b1c-9e55-0a1b2c3d4e5f'])('reads a QR code holding "%s"', (value) => {
    expect(read(qrOf(value))).toBe(value);
  });

  it('reads a QR code drawn small, as on a tag held at arm\'s length', () => {
    expect(read(qrOf('YA-0042', 3))).toBe('YA-0042');
  });

  it.each(['YA-0042', 'Item 12/b', '860000123456'])('reads Code 128 holding "%s"', (value) => {
    expect(read(code128Picture(value))).toBe(value);
  });

  it.each(['YA-0042', 'UZ 1234', 'A.B/C+D'])('reads Code 39 holding "%s"', (value) => {
    expect(read(code39Picture(value))).toBe(value);
  });

  it.each(['478001234567', '590123412345'])('reads EAN-13 starting %s', (first12) => {
    expect(ean13CheckDigit('590123412345')).toBe(7);
    expect(read(ean13Picture(first12))).toBe(`${first12}${ean13CheckDigit(first12)}`);
  });

  it('reads an EAN-13 that starts with zero as the 12-digit UPC-A it also is, and both find the same item', () => {
    const text = read(ean13Picture('012345678905'));
    expect(text).toBe('123456789050');
    // The item may be stored under either form: the lookup tries both.
    expect(scanKeyVariants(text!)).toEqual(['123456789050', '0123456789050']);
    expect(matchScan(text!, [{ value: '0123456789050', item: 'salt' }]).map((match) => match.item)).toEqual(['salt']);
  });

  it('reads nothing from a blank picture, a grey one, or one of no size', () => {
    expect(decodeLuminance(new Uint8ClampedArray(200 * 200).fill(255), 200, 200)).toBeNull();
    expect(decodeLuminance(new Uint8ClampedArray(200 * 200).fill(128), 200, 200)).toBeNull();
    expect(decodeLuminance(new Uint8ClampedArray(0), 0, 0)).toBeNull();
    // Fewer bytes than the size says: refused, not read past the end.
    expect(decodeLuminance(new Uint8ClampedArray(10), 200, 200)).toBeNull();
  });

  it('what it reads goes through the same normaliser as a typed code', () => {
    expect(normalizeScan(read(code128Picture('YA-0042')))).toBe('YA-0042');
    expect(normalizeScan(read(qrOf('https://tags.example.uz/t/UZ-0042')))).toBe('UZ-0042');
  });
});

describe('turning a camera frame into a grey picture', () => {
  it('weighs red, green and blue as the eye does', () => {
    const grey = luminanceOf([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255], 5, 1);
    expect([...grey]).toEqual([255, 0, 76, 149, 29]);
  });

  it('shrinks a large frame without stretching it, and leaves a small one alone', () => {
    expect(frameSize(1920, 1080)).toEqual({ width: 960, height: 540 });
    expect(frameSize(1080, 1920)).toEqual({ width: 540, height: 960 });
    expect(frameSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(frameSize(0, 0)).toEqual({ width: 1, height: 1 });
  });
});

describe('the reader on a video frame', () => {
  const real = globalThis.document;
  afterEach(() => {
    Object.assign(globalThis, { document: real });
  });

  /** A canvas that "draws" the given picture, whatever it is handed. */
  function fakeCanvas(picture: Picture) {
    const canvas = {
      width: 0,
      height: 0,
      drawImage: vi.fn(),
      getContext: () => ({
        drawImage: canvas.drawImage,
        getImageData: () => ({ data: rgbaOf(picture) }),
      }),
    };
    Object.assign(globalThis, { document: { ...real, createElement: () => canvas } });
    return canvas;
  }

  const frame = (picture: Picture) => ({ srcObject: null, readyState: 4, play: async () => {}, videoWidth: picture.width, videoHeight: picture.height }) as ScanVideo;

  it('draws the frame, reads the code in it and reports it', async () => {
    const picture = qrOf('YA-0042');
    const canvas = fakeCanvas(picture);
    const detector = createDetector();
    expect(detector.kind).toBe('fallback');
    expect(await detector.detect(frame(picture))).toEqual(['YA-0042']);
    expect(canvas.drawImage).toHaveBeenCalledOnce();
    expect([canvas.width, canvas.height]).toEqual([picture.width, picture.height]);
  });

  it('reports nothing for a frame without a code, or a video that has no picture yet', async () => {
    const blank: Picture = { grey: new Uint8ClampedArray(120 * 90).fill(255), width: 120, height: 90 };
    const canvas = fakeCanvas(blank);
    const detector = createDetector();
    expect(await detector.detect(frame(blank))).toEqual([]);
    expect(await detector.detect({ ...frame(blank), videoWidth: 0 } as ScanVideo)).toEqual([]);
    expect(canvas.drawImage).toHaveBeenCalledOnce();
  });

  it('gives its picture memory back when disposed, and reads nothing afterwards', async () => {
    const picture = qrOf('YA-0042');
    const canvas = fakeCanvas(picture);
    const detector = createDetector();
    await detector.detect(frame(picture));
    detector.dispose?.();
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect(await detector.detect(frame(picture))).toEqual([]);
  });
});
