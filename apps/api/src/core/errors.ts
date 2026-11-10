import { config } from '../config';

const LOGGED_TEXT_LIMIT = 2000;

/**
 * Errors carry a stable UPPER_SNAKE code. `message` is an English fallback; the web app shows
 * the text from `<module>:errors.<CODE>` in i18n when it exists.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (code = 'UNAUTHORIZED', message = 'Authentication required') =>
  new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to do this', code = 'FORBIDDEN', details?: unknown) =>
  new AppError(403, code, message, details);
export const notFound = (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

/**
 * The name of the unique index a failed write ran into, or null for any other error. Drizzle wraps
 * the driver's error, so the cause is looked at too. Catch it around a savepoint: the statement
 * that failed has already spoiled the transaction it ran in.
 */
export function uniqueViolation(error: unknown): string | null {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    const pg = candidate as { code?: unknown; constraint?: unknown } | null | undefined;
    if (pg?.code === '23505') return typeof pg.constraint === 'string' ? pg.constraint : '';
  }
  return null;
}

function redact(text: string): string {
  const secrets = [process.env.TELEGRAM_BOT_TOKEN, config.TELEGRAM_BOT_TOKEN, config.GEMINI_API_KEY, config.ANTHROPIC_API_KEY];
  return secrets.reduce<string>((clean, secret) => (secret ? clean.replaceAll(secret, '[redacted]') : clean), text);
}

/**
 * The real cause, safe for the log. Drizzle puts a failed query's parameters in its own message,
 * and those can be the person's text, so the driver's error underneath is what gets logged.
 */
export function safeError(error: unknown): Record<string, unknown> {
  let root = error;
  while (root instanceof Error && root.cause instanceof Error) root = root.cause;
  if (!(root instanceof Error)) return { message: 'non-error thrown' };
  const { code, status } = root as Error & { code?: unknown; status?: unknown };
  return { name: root.name, code, status, stack: redact(root.stack ?? root.message).slice(0, LOGGED_TEXT_LIMIT) };
}
