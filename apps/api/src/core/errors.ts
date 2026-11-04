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
