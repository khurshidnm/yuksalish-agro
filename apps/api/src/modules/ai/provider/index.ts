import { config, isProd } from '../../../config';
import { AppError } from '../../../core/errors';
import { ClaudeProvider } from './claude';
import { GeminiProvider } from './gemini';
import type { LlmProvider } from './types';

export * from './types';
export { transcribeAudio } from './transcribe';

/** Stands in when no key is set. Statistical insights keep working; the assistant says so plainly. */
class NotConfiguredProvider implements LlmProvider {
  readonly name = 'none';
  readonly model = null;
  readonly configured = false;

  async complete(): Promise<never> {
    throw notConfigured();
  }
}

export const notConfigured = () =>
  new AppError(503, 'AI_NOT_CONFIGURED', 'The AI assistant is not configured on this server');

const none = new NotConfiguredProvider();
let claude: ClaudeProvider | undefined;
let gemini: GeminiProvider | undefined;
let override: LlmProvider | undefined;
let warnedFreeTier = false;

export type ProviderName = 'gemini' | 'claude';

export interface ProviderSettings {
  AI_PROVIDER?: string;
  GEMINI_API_KEY?: string;
  GEMINI_PAID_TIER?: string;
  ANTHROPIC_API_KEY?: string;
}

/**
 * Which LLM to use, or null. On Google's free tier, prompts and answers may be used to improve its
 * products and may be read by reviewers, which spec 15.2 forbids for farm data. Google offers no
 * way to detect the tier from a key, so production requires the operator to state it is paid.
 */
export function chooseProvider(env: ProviderSettings, production: boolean): ProviderName | null {
  const wanted = env.AI_PROVIDER || (env.GEMINI_API_KEY ? 'gemini' : env.ANTHROPIC_API_KEY ? 'claude' : null);
  if (wanted === 'claude') return env.ANTHROPIC_API_KEY ? 'claude' : null;
  if (wanted !== 'gemini' || !env.GEMINI_API_KEY) return null;
  return production && env.GEMINI_PAID_TIER !== 'true' ? null : 'gemini';
}

/** To add a provider, implement LlmProvider and branch here. */
export function getProvider(): LlmProvider {
  if (override) return override;
  const chosen = chooseProvider(config, isProd);
  if (chosen === 'claude') {
    claude ??= new ClaudeProvider({
      apiKey: config.ANTHROPIC_API_KEY,
      model: process.env.AI_MODEL,
      effort: process.env.AI_EFFORT,
    });
    return claude;
  }
  if (chosen === 'gemini') {
    if (config.GEMINI_PAID_TIER !== 'true' && !warnedFreeTier) {
      warnedFreeTier = true;
      console.warn('Gemini: GEMINI_PAID_TIER is not set. A free-tier key may share data with Google: demo data only.');
    }
    gemini ??= new GeminiProvider({
      apiKey: config.GEMINI_API_KEY,
      model: process.env.AI_MODEL,
      thinkingBudget: Number(process.env.AI_THINKING_BUDGET) || undefined,
    });
    return gemini;
  }
  return none;
}

/** Test seam: replace the provider so tests never touch the network. */
export function setProvider(provider: LlmProvider | undefined): void {
  override = provider;
}
