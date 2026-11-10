/**
 * The camera scanner without React: it asks for the back camera, looks at frames until one holds a
 * code, hands that code over once, and switches the camera off. Everything it needs from the browser
 * comes in through `ScanEnv`, so tests drive it with a made-up camera and a made-up detector.
 *
 * The camera is released on every way out: a code found, `stop()`, a refusal, a failure, or a
 * permission answer that arrives after the dialog was already closed.
 */
import { normalizeScan } from '@yap/shared/formulas/scan-code';

/** What the dialog must read: the QR on our own tags, and the 1-D codes on bought tags and goods. */
export const REQUIRED_FORMATS = ['qr_code', 'code_128', 'ean_13', 'code_39'] as const;
/** Read as well where the browser can: the other codes found on packaging. */
export const EXTRA_FORMATS = ['ean_8', 'upc_a', 'upc_e', 'itf'] as const;

export type ScanPhase =
  /** Nothing asked yet. */
  | 'idle'
  /** The page is not on HTTPS, so the browser gives no camera at all. */
  | 'insecure'
  /** This device or browser has no camera to give. */
  | 'no_camera'
  /** The browser is asking the person. */
  | 'asking'
  /** The person, or a browser setting, said no. */
  | 'denied'
  /** Another app holds the camera. */
  | 'busy'
  /** The camera or the decoder could not start. */
  | 'failed'
  | 'searching'
  | 'found';

export interface ScanState {
  phase: ScanPhase;
  /** The lamp: on, off, or null when this camera has none to switch. */
  torch: boolean | null;
  /** The code read, once found. */
  code: string | null;
}

export const IDLE: ScanState = { phase: 'idle', torch: null, code: null };

/** The part of a <video> the scanner touches. */
export interface ScanVideo {
  srcObject: unknown;
  readyState: number;
  play(): Promise<void>;
}

/** Looks at the current frame and returns the text of every code in it. */
export interface FrameDetector {
  kind: 'native' | 'fallback';
  detect(video: ScanVideo): Promise<string[]>;
  dispose?(): void;
}

interface NativeDetector {
  detect(source: unknown): Promise<{ rawValue: string }[]>;
}

export interface NativeDetectorClass {
  new (options?: { formats?: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
}

interface Track {
  stop(): void;
  getCapabilities?(): unknown;
  applyConstraints?(constraints: unknown): Promise<void>;
}

/** The part of a MediaStream the scanner touches. */
export interface ScanStream {
  getTracks(): Track[];
  getVideoTracks(): Track[];
}

export interface ScanEnv {
  /** `window.isSecureContext`: cameras exist only on HTTPS and on localhost. */
  secure: boolean;
  mediaDevices?: { getUserMedia?(constraints: MediaStreamConstraints): Promise<ScanStream> } | null;
  /** The browser's own reader, where it has one (Chrome on Android; not Safari, not Firefox). */
  BarcodeDetector?: NativeDetectorClass;
  /** The decoder in JavaScript, fetched only when the browser has none of its own. */
  loadFallback(): Promise<FrameDetector>;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** The camera asked for: the one on the back of the phone, and no sound. */
export const CAMERA_CONSTRAINTS = { video: { facingMode: 'environment' }, audio: false } as const;

/** Pause between two looks at the picture. The browser's reader is cheap; the JavaScript one is not. */
const INTERVAL_MS = { native: 80, fallback: 160 };

/** HTMLMediaElement.HAVE_CURRENT_DATA: there is a frame to look at. */
const HAVE_FRAME = 2;

export function browserEnv(): ScanEnv {
  const scope = globalThis as unknown as {
    isSecureContext?: boolean;
    navigator?: { mediaDevices?: ScanEnv['mediaDevices'] };
    BarcodeDetector?: NativeDetectorClass;
  };
  return {
    secure: scope.isSecureContext === true,
    mediaDevices: scope.navigator?.mediaDevices,
    BarcodeDetector: scope.BarcodeDetector,
    loadFallback: async () => (await import('./zxing-detector')).createDetector(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/** Why the camera did not open, from the name of the browser's error. */
export function phaseOfCameraError(error: unknown): ScanPhase {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'no_camera';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  return 'failed';
}

/** The browser's reader when it reads every format we need, otherwise the JavaScript one. */
export async function pickDetector(env: Pick<ScanEnv, 'BarcodeDetector' | 'loadFallback'>): Promise<FrameDetector> {
  const Native = env.BarcodeDetector;
  if (Native) {
    try {
      const supported = await Native.getSupportedFormats();
      if (REQUIRED_FORMATS.every((format) => supported.includes(format))) {
        const native = new Native({ formats: [...REQUIRED_FORMATS, ...EXTRA_FORMATS.filter((format) => supported.includes(format))] });
        return { kind: 'native', detect: async (video) => (await native.detect(video)).map((found) => found.rawValue) };
      }
    } catch {
      // A reader that cannot even list its formats is not one to rely on.
    }
  }
  return env.loadFallback();
}

function stopTracks(stream: ScanStream | null) {
  for (const track of stream?.getTracks() ?? []) {
    try {
      track.stop();
    } catch {
      // A track that is already gone needs no stopping.
    }
  }
}

function hasTorch(stream: ScanStream): boolean {
  try {
    const capabilities = stream.getVideoTracks()[0]?.getCapabilities?.() as { torch?: unknown } | undefined;
    return Boolean(capabilities?.torch);
  } catch {
    return false;
  }
}

export interface Scanner {
  /** Asks for the camera and starts looking. Calling it again starts over. */
  start(): Promise<void>;
  /** Switches the camera off. Safe to call at any moment, any number of times. */
  stop(): void;
  setTorch(on: boolean): Promise<void>;
  state(): ScanState;
}

export function createScanner(options: {
  env: ScanEnv;
  /** The element showing the picture; asked for each time, because React may not have made it yet. */
  video: () => ScanVideo | null;
  onState: (state: ScanState) => void;
  /** Called once per `start()`, with a normalised code, after the camera is already off. */
  onResult: (code: string) => void;
}): Scanner {
  const { env } = options;
  let stream: ScanStream | null = null;
  let detector: FrameDetector | null = null;
  let timer: unknown = null;
  let current: ScanState = IDLE;
  // Every start and every stop begins a new run. Whatever an older run was waiting for is stale
  // when it arrives, and must give back what it holds instead of using it.
  let run = 0;

  const set = (next: ScanState) => {
    current = next;
    options.onState(next);
  };

  const release = () => {
    if (timer !== null) env.clearTimer(timer);
    timer = null;
    stopTracks(stream);
    stream = null;
    const video = options.video();
    if (video) video.srcObject = null;
    detector?.dispose?.();
    detector = null;
  };

  const fail = (phase: ScanPhase) => {
    release();
    set({ phase, torch: null, code: null });
  };

  const look = (mine: number) => {
    timer = env.setTimer(async () => {
      timer = null;
      if (mine !== run || !detector) return;
      let values: string[] = [];
      try {
        const video = options.video();
        if (video && video.readyState >= HAVE_FRAME) values = await detector.detect(video);
      } catch {
        if (mine !== run) return;
        // The browser's reader can exist and still not work (its service is missing on some
        // phones). The JavaScript one takes over; a frame it cannot read is simply skipped.
        if (detector?.kind === 'native') {
          try {
            const fallback = await env.loadFallback();
            if (mine !== run) return fallback.dispose?.();
            detector = fallback;
          } catch {
            if (mine === run) fail('failed');
            return;
          }
        }
      }
      if (mine !== run) return;
      const code = values.map((value) => normalizeScan(value)).find((value) => value !== null) ?? null;
      if (code === null) return look(mine);
      run += 1;
      release();
      set({ phase: 'found', torch: null, code });
      options.onResult(code);
    }, INTERVAL_MS[detector?.kind ?? 'fallback']);
  };

  return {
    state: () => current,

    stop() {
      run += 1;
      release();
    },

    async start() {
      run += 1;
      const mine = run;
      release();
      if (!env.secure) return set({ phase: 'insecure', torch: null, code: null });
      const devices = env.mediaDevices;
      if (!devices?.getUserMedia) return set({ phase: 'no_camera', torch: null, code: null });

      set({ phase: 'asking', torch: null, code: null });
      let granted: ScanStream;
      try {
        granted = await devices.getUserMedia(CAMERA_CONSTRAINTS);
      } catch (error) {
        if (mine === run) fail(phaseOfCameraError(error));
        return;
      }
      // The person closed the dialog while the browser was still asking: the camera that has just
      // been granted is switched off at once.
      if (mine !== run) return stopTracks(granted);
      stream = granted;

      const video = options.video();
      if (video) {
        video.srcObject = granted;
        try {
          await video.play();
        } catch {
          // Autoplay may be refused; the frames still arrive once the element shows them.
        }
        if (mine !== run) return;
      }

      let chosen: FrameDetector;
      try {
        chosen = await pickDetector(env);
      } catch {
        if (mine === run) fail('failed');
        return;
      }
      if (mine !== run) return chosen.dispose?.();
      detector = chosen;
      set({ phase: 'searching', torch: hasTorch(granted) ? false : null, code: null });
      look(mine);
    },

    async setTorch(on) {
      const mine = run;
      const track = stream?.getVideoTracks()[0];
      if (!track?.applyConstraints || current.phase !== 'searching' || current.torch === null) return;
      try {
        await track.applyConstraints({ advanced: [{ torch: on }] });
        if (mine === run && current.phase === 'searching') set({ ...current, torch: on });
      } catch {
        // A lamp that will not switch is treated as no lamp: the button goes away.
        if (mine === run && current.phase === 'searching') set({ ...current, torch: null });
      }
    },
  };
}
