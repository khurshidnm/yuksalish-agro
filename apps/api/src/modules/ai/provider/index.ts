import { config } from '../../../config';
import { AppError } from '../../../core/errors';
import { ClaudeProvider } from './claude';
import type { LlmProvider } from './types';

export * from './types';

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
let override: LlmProvider | undefined;

/** Which LLM to use. To add a provider, branch here on an AI_PROVIDER setting. */
export function getProvider(): LlmProvider {
  if (override) return override;
  if (!config.ANTHROPIC_API_KEY) return none;
  claude ??= new ClaudeProvider({
    apiKey: config.ANTHROPIC_API_KEY,
    model: process.env.AI_MODEL,
    effort: process.env.AI_EFFORT,
  });
  return claude;
}

/** Test seam: replace the provider so tests never touch the network. */
export function setProvider(provider: LlmProvider | undefined): void {
  override = provider;
}
