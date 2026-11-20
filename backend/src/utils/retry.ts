import { AppError } from './errors.js';
import { errorMessage, logger } from './logger.js';

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  label?: string;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rejects when `promise` does not settle in time (used for network calls that can hang). */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AppError(504, message, { retryable: false }));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Exponential backoff with jitter. Non-retryable AppErrors bubble up immediately. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelay = options.baseDelayMs ?? 800;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (error instanceof AppError && !error.retryable) throw error;
      if (attempt >= attempts) break;
      const delayMs = Math.min(baseDelay * 2 ** (attempt - 1), 15_000) + Math.floor(Math.random() * 250);
      logger.warn(
        `Retrying ${options.label ?? 'operation'} (attempt ${attempt}/${attempts}) in ${delayMs}ms — ${errorMessage(error)}`,
      );
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
