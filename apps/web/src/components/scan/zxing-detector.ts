/**
 * The code reader in JavaScript, for browsers without one of their own (Safari on iPhone, Firefox).
 * This file is reached only through `import()` in scanner.ts, so the library it pulls in is fetched
 * when a camera is opened on such a browser and never sits in the main bundle.
 *
 * Pure JavaScript on purpose: the site's content policy allows scripts from itself only, and a
 * WebAssembly decoder would need it loosened.
 */
import { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatOneDReader, QRCodeReader, RGBLuminanceSource } from '@zxing/library';
import type { FrameDetector, ScanVideo } from './scanner';

/** The same formats the browser's own reader is asked for. */
const ONE_D_FORMATS = [
  BarcodeFormat.CODE_128,
  BarcodeFormat.EAN_13,
  BarcodeFormat.CODE_39,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.ITF,
];

/** The longer side of the picture handed to the decoder: enough for a tag at arm's length, and quick. */
const MAX_SIDE = 960;

function hints(): Map<DecodeHintType, unknown> {
  return new Map<DecodeHintType, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, ONE_D_FORMATS],
    // More rows are tried, and a bar code lying on its side is read too.
    [DecodeHintType.TRY_HARDER, true],
  ]);
}

/** Grey values, one byte per pixel, from the RGBA bytes a canvas gives. */
export function luminanceOf(rgba: ArrayLike<number>, width: number, height: number): Uint8ClampedArray {
  const grey = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < grey.length; i += 1, p += 4) {
    // Integer weights of the usual 0.299 / 0.587 / 0.114.
    grey[i] = (rgba[p]! * 306 + rgba[p + 1]! * 601 + rgba[p + 2]! * 117) >> 10;
  }
  return grey;
}

/** The text of the code in a grey picture, or null when it holds none that can be read. */
export function decodeLuminance(grey: Uint8ClampedArray, width: number, height: number): string | null {
  if (width <= 0 || height <= 0 || grey.length < width * height) return null;
  const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(grey, width, height)));
  const options = hints();
  for (const reader of [new QRCodeReader(), new MultiFormatOneDReader(options)]) {
    try {
      const text = reader.decode(bitmap, options).getText();
      if (text) return text;
    } catch {
      // No code of this kind in the picture, or one too damaged to trust: both mean "not read".
    }
  }
  return null;
}

/** The size the frame is drawn at: never larger than MAX_SIDE, never stretched. */
export function frameSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function createDetector(): FrameDetector {
  let canvas: HTMLCanvasElement | null = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return {
    kind: 'fallback',
    async detect(video: ScanVideo) {
      const element = video as unknown as HTMLVideoElement;
      if (!canvas || !context || !element.videoWidth || !element.videoHeight) return [];
      const { width, height } = frameSize(element.videoWidth, element.videoHeight);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.drawImage(element, 0, 0, width, height);
      const text = decodeLuminance(luminanceOf(context.getImageData(0, 0, width, height).data, width, height), width, height);
      return text === null ? [] : [text];
    },
    dispose() {
      // A canvas of no size frees its picture memory at once on iOS, which is short of it.
      if (canvas) canvas.width = canvas.height = 0;
      canvas = null;
    },
  };
}
