type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVEL_WEIGHT[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVEL_WEIGHT.info;
const useColor = process.stdout.isTTY === true;

const COLOR: Record<Level, string> = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};
const RESET = '\u001b[0m';

function format(level: Level, scope: string | null, message: string): string {
  const time = new Date().toISOString().slice(11, 23);
  const label = level.toUpperCase().padEnd(5);
  const head = useColor ? `${COLOR[level]}${label}${RESET}` : label;
  const scopePart = scope ? ` [${scope}]` : '';
  return `${time} ${head}${scopePart} ${message}`;
}

function emit(level: Level, scope: string | null, message: string, meta?: unknown): void {
  if (LEVEL_WEIGHT[level] < threshold) return;
  const line = format(level, scope, message);
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (meta === undefined) sink(line);
  else sink(line, meta);
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(scope: string): Logger;
}

function createLogger(scope: string | null): Logger {
  return {
    debug: (message, meta) => emit('debug', scope, message, meta),
    info: (message, meta) => emit('info', scope, message, meta),
    warn: (message, meta) => emit('warn', scope, message, meta),
    error: (message, meta) => emit('error', scope, message, meta),
    child: (childScope) => createLogger(scope ? `${scope}:${childScope}` : childScope),
  };
}

export const logger = createLogger(null);

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
