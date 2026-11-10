import { describe, expect, it, vi } from 'vitest';
import {
  CAMERA_CONSTRAINTS,
  type FrameDetector,
  type NativeDetectorClass,
  REQUIRED_FORMATS,
  type ScanEnv,
  type ScanState,
  createScanner,
  phaseOfCameraError,
  pickDetector,
} from './scanner';

/** A camera, a browser and a clock that exist only here. No real camera is opened by these tests. */
function rig(options: {
  secure?: boolean;
  /** What the camera's track says it can do. */
  capabilities?: unknown;
  /** What the browser's own reader supports; null for a browser without one. */
  nativeFormats?: string[] | null;
  /** What each look at the picture finds, in order; the last answer repeats. */
  frames?: (string[] | Error)[];
  getUserMedia?: () => Promise<unknown>;
  withoutDevices?: boolean;
  fallback?: () => Promise<FrameDetector>;
  readyState?: number;
} = {}) {
  const timers: { run: () => unknown; ms: number }[] = [];
  const track = {
    stop: vi.fn(),
    getCapabilities: () => options.capabilities ?? {},
    applyConstraints: vi.fn(async (_constraints: unknown) => {}),
  };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const getUserMedia = vi.fn(options.getUserMedia ?? (async () => stream));
  const video = { srcObject: null as unknown, readyState: options.readyState ?? 4, play: vi.fn(async () => {}) };

  const frames = [...(options.frames ?? [[]])];
  const next = () => {
    const frame = frames.length > 1 ? frames.shift()! : frames[0]!;
    if (frame instanceof Error) throw frame;
    return frame;
  };
  const nativeDetect = vi.fn(async () => next().map((rawValue) => ({ rawValue })));
  const asked: (string[] | undefined)[] = [];
  const formats = options.nativeFormats === undefined ? [...REQUIRED_FORMATS] : options.nativeFormats;
  const Native =
    formats === null
      ? undefined
      : (class {
          static getSupportedFormats = vi.fn(async () => formats);
          constructor(given?: { formats?: string[] }) {
            asked.push(given?.formats);
          }
          detect = nativeDetect;
        } as unknown as NativeDetectorClass);

  const fallbackDetect = vi.fn(async () => next());
  const dispose = vi.fn();
  const loadFallback = vi.fn(options.fallback ?? (async (): Promise<FrameDetector> => ({ kind: 'fallback', detect: fallbackDetect, dispose })));

  const env: ScanEnv = {
    secure: options.secure ?? true,
    mediaDevices: options.withoutDevices ? undefined : ({ getUserMedia } as unknown as ScanEnv['mediaDevices']),
    BarcodeDetector: Native,
    loadFallback,
    setTimer: (run, ms) => {
      const timer = { run, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      const at = timers.indexOf(handle as (typeof timers)[number]);
      if (at >= 0) timers.splice(at, 1);
    },
  };

  const states: ScanState[] = [];
  const results: string[] = [];
  /** How many times the track had been stopped at the moment each code was handed over. */
  const stopsAtResult: number[] = [];
  const scanner = createScanner({
    env,
    video: () => video,
    onState: (state) => states.push(state),
    onResult: (code) => {
      stopsAtResult.push(track.stop.mock.calls.length);
      results.push(code);
    },
  });

  return {
    scanner,
    track,
    video,
    getUserMedia,
    nativeDetect,
    fallbackDetect,
    loadFallback,
    dispose,
    asked,
    states,
    results,
    stopsAtResult,
    timers,
    phases: () => states.map((state) => state.phase),
    /** Lets the next look at the picture happen. */
    async look() {
      const timer = timers.shift();
      if (!timer) throw new Error('the scanner is not waiting to look');
      await timer.run();
    },
  };
}

const named = (name: string) => Object.assign(new Error(name), { name });

describe('opening the camera', () => {
  it('asks for the camera on the back of the phone, without sound', async () => {
    const r = rig();
    await r.scanner.start();
    expect(CAMERA_CONSTRAINTS).toEqual({ video: { facingMode: 'environment' }, audio: false });
    expect(r.getUserMedia).toHaveBeenCalledExactlyOnceWith(CAMERA_CONSTRAINTS);
    expect(r.phases()).toEqual(['asking', 'searching']);
    expect(r.video.srcObject).not.toBeNull();
    expect(r.video.play).toHaveBeenCalledOnce();
  });

  it('says the page needs HTTPS and does not ask for a camera', async () => {
    const r = rig({ secure: false });
    await r.scanner.start();
    expect(r.phases()).toEqual(['insecure']);
    expect(r.getUserMedia).not.toHaveBeenCalled();
  });

  it('says there is no camera where the browser offers none', async () => {
    const r = rig({ withoutDevices: true });
    await r.scanner.start();
    expect(r.phases()).toEqual(['no_camera']);
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'no_camera'],
    ['OverconstrainedError', 'no_camera'],
    ['NotReadableError', 'busy'],
    ['AbortError', 'busy'],
    ['SomethingElse', 'failed'],
  ])('a camera refused with %s is shown as "%s"', async (name, phase) => {
    expect(phaseOfCameraError(named(name))).toBe(phase);
    const r = rig({ getUserMedia: () => Promise.reject(named(name)) });
    await r.scanner.start();
    expect(r.phases()).toEqual(['asking', phase]);
    expect(r.timers).toHaveLength(0);
    expect(r.results).toEqual([]);
  });

  it('a refusal that is not an error object is a failure, not a crash', () => {
    expect(phaseOfCameraError('no')).toBe('failed');
    expect(phaseOfCameraError(null)).toBe('failed');
  });

  it('a second try after a refusal can succeed', async () => {
    let refused = true;
    const r = rig();
    r.getUserMedia.mockImplementation(async () => {
      if (refused) throw named('NotAllowedError');
      return { getTracks: () => [r.track], getVideoTracks: () => [r.track] };
    });
    await r.scanner.start();
    refused = false;
    await r.scanner.start();
    expect(r.phases()).toEqual(['asking', 'denied', 'asking', 'searching']);
  });
});

describe('reading a code', () => {
  it('hands the code over once, normalised, with the camera already off', async () => {
    const r = rig({ frames: [[], [' ya-0042\r\n']] });
    await r.scanner.start();
    await r.look();
    expect(r.results).toEqual([]);
    expect(r.track.stop).not.toHaveBeenCalled();

    await r.look();
    expect(r.results).toEqual(['ya-0042']);
    expect(r.stopsAtResult).toEqual([1]);
    expect(r.track.stop).toHaveBeenCalledOnce();
    expect(r.video.srcObject).toBeNull();
    expect(r.scanner.state()).toEqual({ phase: 'found', torch: null, code: 'ya-0042' });
    // Nothing is left looking at a camera that is off.
    expect(r.timers).toHaveLength(0);
  });

  it('takes the code out of a web address on a bought tag', async () => {
    const r = rig({ frames: [['https://tags.example.uz/t/UZ-0042?src=qr']] });
    await r.scanner.start();
    await r.look();
    expect(r.results).toEqual(['UZ-0042']);
  });

  it('keeps looking past something that is not a code we can use', async () => {
    const r = rig({ frames: [['x'.repeat(200)], ['   '], ['4780012345678']] });
    await r.scanner.start();
    await r.look();
    await r.look();
    expect(r.results).toEqual([]);
    expect(r.scanner.state().phase).toBe('searching');
    await r.look();
    expect(r.results).toEqual(['4780012345678']);
  });

  it('does not look at a picture that has no frame yet', async () => {
    const r = rig({ readyState: 0, frames: [['YA-1']] });
    await r.scanner.start();
    await r.look();
    expect(r.nativeDetect).not.toHaveBeenCalled();
    r.video.readyState = 2;
    await r.look();
    expect(r.results).toEqual(['YA-1']);
  });

  it('starting again after a code reads one more, and only one', async () => {
    const r = rig({ frames: [['A-1'], ['A-2']] });
    await r.scanner.start();
    await r.look();
    await r.scanner.start();
    await r.look();
    expect(r.results).toEqual(['A-1', 'A-2']);
    expect(r.track.stop).toHaveBeenCalledTimes(2);
    expect(r.timers).toHaveLength(0);
  });
});

describe('switching the camera off', () => {
  it('stop() releases every track and nothing is read afterwards', async () => {
    const r = rig({ frames: [['YA-1']] });
    await r.scanner.start();
    r.scanner.stop();
    expect(r.track.stop).toHaveBeenCalledOnce();
    expect(r.video.srcObject).toBeNull();
    expect(r.timers).toHaveLength(0);
    expect(r.results).toEqual([]);
    // Safe to call again, as an unmount after a close does.
    r.scanner.stop();
  });

  it('a look already under way when the dialog closes gives no result', async () => {
    let finish: (values: string[]) => void = () => {};
    const r = rig({ nativeFormats: null, fallback: async () => ({ kind: 'fallback', detect: () => new Promise<string[]>((resolve) => (finish = resolve)) }) });
    await r.scanner.start();
    const looking = r.look();
    r.scanner.stop();
    finish(['YA-1']);
    await looking;
    expect(r.results).toEqual([]);
    expect(r.timers).toHaveLength(0);
  });

  it('a permission given after the dialog was closed switches the camera straight off', async () => {
    let grant: (stream: unknown) => void = () => {};
    const r = rig({ getUserMedia: () => new Promise((resolve) => (grant = resolve)) });
    const starting = r.scanner.start();
    r.scanner.stop();
    grant({ getTracks: () => [r.track], getVideoTracks: () => [r.track] });
    await starting;
    expect(r.track.stop).toHaveBeenCalledOnce();
    expect(r.phases()).toEqual(['asking']);
    expect(r.video.srcObject).toBeNull();
    expect(r.loadFallback).not.toHaveBeenCalled();
    expect(r.timers).toHaveLength(0);
  });

  it('a track that throws when stopped does not keep the others on', async () => {
    const r = rig();
    const second = { stop: vi.fn() };
    r.track.stop.mockImplementation(() => {
      throw new Error('already ended');
    });
    r.getUserMedia.mockImplementation(async () => ({ getTracks: () => [r.track, second], getVideoTracks: () => [r.track] }));
    await r.scanner.start();
    r.scanner.stop();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it('gives the JavaScript reader its memory back', async () => {
    const r = rig({ nativeFormats: null });
    await r.scanner.start();
    r.scanner.stop();
    expect(r.dispose).toHaveBeenCalledOnce();
  });
});

describe('which reader looks at the picture', () => {
  it("uses the browser's own when it reads every format we need", async () => {
    const r = rig({ nativeFormats: [...REQUIRED_FORMATS, 'ean_8', 'aztec'], frames: [['YA-1']] });
    await r.scanner.start();
    await r.look();
    expect(r.loadFallback).not.toHaveBeenCalled();
    expect(r.nativeDetect).toHaveBeenCalledOnce();
    // QR and the three 1-D codes always; the extra ones only where the browser has them.
    expect(r.asked).toEqual([['qr_code', 'code_128', 'ean_13', 'code_39', 'ean_8']]);
  });

  it('loads the JavaScript reader when the browser has none', async () => {
    const r = rig({ nativeFormats: null, frames: [['YA-1']] });
    await r.scanner.start();
    await r.look();
    expect(r.loadFallback).toHaveBeenCalledOnce();
    expect(r.fallbackDetect).toHaveBeenCalledOnce();
    expect(r.results).toEqual(['YA-1']);
  });

  it.each(REQUIRED_FORMATS)('loads the JavaScript reader when the browser cannot read %s', async (missing) => {
    const r = rig({ nativeFormats: REQUIRED_FORMATS.filter((format) => format !== missing) });
    await r.scanner.start();
    expect(r.loadFallback).toHaveBeenCalledOnce();
    expect(r.asked).toEqual([]);
  });

  it('loads the JavaScript reader when the browser cannot say what it reads', async () => {
    const Broken = class {
      static getSupportedFormats = async () => {
        throw new Error('service missing');
      };
      detect = async () => [];
    } as unknown as NativeDetectorClass;
    const fallback: FrameDetector = { kind: 'fallback', detect: async () => [] };
    expect(await pickDetector({ BarcodeDetector: Broken, loadFallback: async () => fallback })).toBe(fallback);
  });

  it("goes over to the JavaScript reader when the browser's own stops working", async () => {
    const r = rig({ frames: [new Error('barcode service unavailable'), ['YA-7']] });
    await r.scanner.start();
    await r.look();
    expect(r.loadFallback).toHaveBeenCalledOnce();
    expect(r.scanner.state().phase).toBe('searching');
    await r.look();
    expect(r.fallbackDetect).toHaveBeenCalledOnce();
    expect(r.results).toEqual(['YA-7']);
  });

  it('a frame the JavaScript reader chokes on is skipped', async () => {
    const r = rig({ nativeFormats: null, frames: [new Error('bad frame'), ['YA-8']] });
    await r.scanner.start();
    await r.look();
    expect(r.scanner.state().phase).toBe('searching');
    await r.look();
    expect(r.results).toEqual(['YA-8']);
  });

  it('says the scanner failed, with the camera off, when no reader can be loaded', async () => {
    const r = rig({ nativeFormats: null, fallback: () => Promise.reject(new Error('offline')) });
    await r.scanner.start();
    expect(r.phases()).toEqual(['asking', 'failed']);
    expect(r.track.stop).toHaveBeenCalledOnce();
    expect(r.timers).toHaveLength(0);
  });
});

describe('the lamp', () => {
  it('is offered only when the camera has one', async () => {
    const without = rig();
    await without.scanner.start();
    expect(without.scanner.state().torch).toBeNull();
    await without.scanner.setTorch(true);
    expect(without.track.applyConstraints).not.toHaveBeenCalled();

    const withLamp = rig({ capabilities: { torch: true } });
    await withLamp.scanner.start();
    expect(withLamp.scanner.state().torch).toBe(false);
  });

  it('switches on and off', async () => {
    const r = rig({ capabilities: { torch: true } });
    await r.scanner.start();
    await r.scanner.setTorch(true);
    expect(r.track.applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ torch: true }] });
    expect(r.scanner.state()).toEqual({ phase: 'searching', torch: true, code: null });
    await r.scanner.setTorch(false);
    expect(r.track.applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ torch: false }] });
    expect(r.scanner.state().torch).toBe(false);
  });

  it('a lamp that will not switch is taken away', async () => {
    const r = rig({ capabilities: { torch: true } });
    r.track.applyConstraints.mockRejectedValue(new Error('not supported'));
    await r.scanner.start();
    await r.scanner.setTorch(true);
    expect(r.scanner.state().torch).toBeNull();
  });

  it('is off again once a code is read, because the camera is off', async () => {
    const r = rig({ capabilities: { torch: true }, frames: [['YA-1']] });
    await r.scanner.start();
    await r.scanner.setTorch(true);
    await r.look();
    expect(r.scanner.state()).toEqual({ phase: 'found', torch: null, code: 'YA-1' });
    await r.scanner.setTorch(true);
    expect(r.track.applyConstraints).toHaveBeenCalledOnce();
  });
});
