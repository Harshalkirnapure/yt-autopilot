export interface AppErrorOptions {
  retryable?: boolean;
  details?: unknown;
}

/** Error carrying an HTTP status so route handlers can answer consistently. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.retryable = options.retryable ?? statusCode >= 500;
    this.details = options.details;
  }
}

export const badRequest = (message: string): AppError => new AppError(400, message);
export const unauthorized = (message: string): AppError => new AppError(401, message);
export const forbidden = (message: string): AppError => new AppError(403, message);
export const notFound = (message: string): AppError => new AppError(404, message);
export const conflict = (message: string): AppError => new AppError(409, message);
export const tooManyRequests = (message: string): AppError => new AppError(429, message);
export const unavailable = (message: string): AppError => new AppError(503, message);
export const upstreamError = (message: string): AppError => new AppError(502, message);
