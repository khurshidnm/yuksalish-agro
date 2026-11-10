import { SCAN_CODE_MAX } from '@yap/shared/formulas/scan-code';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import { ScanOutcome } from './ScanLookup';
import { ScanView } from './ScanView';
import type { ScanPhase, ScanState } from './scanner';

vi.mock('sonner', () => ({ toast: {} }));

const PHASES: ScanPhase[] = ['idle', 'insecure', 'no_camera', 'asking', 'denied', 'busy', 'failed', 'searching', 'found'];
const LANGUAGES = ['uz', 'ru', 'en'] as const;

/** Text as React writes it into markup. */
const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

const stateOf = (phase: ScanPhase, more: Partial<ScanState> = {}): ScanState => ({ phase, torch: null, code: phase === 'found' ? 'YA-0042' : null, ...more });
const view = (state: ScanState, props: Partial<Parameters<typeof ScanView>[0]> = {}) =>
  renderToStaticMarkup(<ScanView state={state} onManual={() => {}} onRetry={() => {}} onTorch={() => {}} {...props} />);

afterAll(async () => {
  await i18n.changeLanguage('uz');
});

describe.each(LANGUAGES)('the scan dialog in %s', (lng) => {
  it.each(PHASES)('says what is happening while "%s", and always leaves a field to type the code', async (phase) => {
    await i18n.changeLanguage(lng);
    const t = i18n.getFixedT(lng, 'scan');
    const markup = view(stateOf(phase));
    expect(markup).toContain(`data-scan-phase="${phase}"`);
    expect(markup).toContain(html(t(`state.${phase}.title`)));
    expect(markup).toContain(html(t(`state.${phase}.body`)));
    // The words are this language's own, not a key shown raw.
    expect(t(`state.${phase}.title`)).not.toContain('state.');
    // Typing instead: there in every state, a refused camera included.
    expect(markup).toContain(html(t('manual.label')));
    expect(markup).toMatch(new RegExp(`<input[^>]*maxLength="${SCAN_CODE_MAX}"`));
    expect(markup).toContain(html(t('manual.submit')));
  });

  it('a refused camera is told how to allow it, in words that differ from "no camera"', () => {
    const t = i18n.getFixedT(lng, 'scan');
    expect(t('state.denied.body')).not.toBe(t('state.no_camera.body'));
    expect(t('state.insecure.body')).toMatch(/https/i);
  });
});

describe('what the scan dialog offers in each state', () => {
  it('offers another try only where one can help', async () => {
    await i18n.changeLanguage('en');
    const retry = i18n.t('scan:retry');
    for (const phase of PHASES) {
      const offered = view(stateOf(phase)).includes(`>${retry}</button>`);
      expect([phase, offered]).toEqual([phase, ['denied', 'no_camera', 'busy', 'failed'].includes(phase)]);
    }
  });

  it('shows the lamp button only while looking, and only when the camera has a lamp', () => {
    expect(view(stateOf('searching'))).not.toContain('aria-pressed');
    expect(view(stateOf('searching', { torch: false }))).toContain(`aria-pressed="false" aria-label="${i18n.t('scan:torchOn')}"`);
    expect(view(stateOf('searching', { torch: true }))).toContain(`aria-pressed="true" aria-label="${i18n.t('scan:torchOff')}"`);
    expect(view(stateOf('denied', { torch: false }))).not.toContain('aria-pressed');
  });

  it('the lamp button is large enough for a gloved thumb', () => {
    expect(view(stateOf('searching', { torch: false }))).toMatch(/<button[^>]*aria-pressed="false"[^>]*class="[^"]*size-12/);
  });

  it('shows the code that was read', () => {
    expect(view(stateOf('found'))).toContain('YA-0042');
    expect(view(stateOf('searching'))).not.toContain('YA-0042');
  });

  it('says what to point at while looking, where the place of use knows', () => {
    expect(view(stateOf('searching'), { hint: 'The tag on the ear' })).toContain('The tag on the ear');
    // A refusal is never replaced by the hint.
    expect(view(stateOf('denied'), { hint: 'The tag on the ear' })).not.toContain('The tag on the ear');
  });

  it('plays the picture inside the page, without sound: iOS needs both', () => {
    expect(view(stateOf('searching'))).toMatch(/<video[^>]*playsInline=""[^>]*muted=""/);
  });
});

describe('what a scan found', () => {
  const outcome = (matches: { id: string; tag: string }[]) =>
    renderToStaticMarkup(
      <ScanOutcome
        code="YA-0042"
        matches={matches}
        matchKey={(match) => match.id}
        renderMatch={(match) => <span>{match.tag}</span>}
        onPick={() => {
          throw new Error('nothing is picked without a tap');
        }}
        noneBody="No animal carries this code"
        severalBody="Two animals carry this code"
      />,
    );

  it('an unknown code is said to be unknown, with the code shown and nothing to pick', () => {
    const markup = outcome([]);
    expect(markup).toContain('YA-0042');
    expect(markup).toContain('No animal carries this code');
    expect(markup).not.toContain('<button');
  });

  it('a code two records carry shows both to choose from', () => {
    const markup = outcome([
      { id: 'a', tag: 'YA-0042' },
      { id: 'b', tag: 'ya-0042' },
    ]);
    expect(markup).toContain('Two animals carry this code');
    expect(markup.match(/<button/g)).toHaveLength(2);
    expect(markup).toContain('<span>YA-0042</span>');
    expect(markup).toContain('<span>ya-0042</span>');
    // Each choice is tall enough to tap with gloves on.
    expect(markup.match(/min-h-14/g)).toHaveLength(2);
  });
});
