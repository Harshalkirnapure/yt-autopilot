import { badRequest } from './errors.js';

function asRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

export interface StringRule {
  maxLength?: number;
  minLength?: number;
  label?: string;
}

export function optionalString(body: unknown, key: string, rule: StringRule = {}): string | undefined {
  const value = asRecord(body)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`"${key}" must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const max = rule.maxLength ?? 20_000;
  if (trimmed.length > max) throw badRequest(`${rule.label ?? key} is too long (max ${max} characters).`);
  return trimmed;
}

export function requireString(body: unknown, key: string, rule: StringRule = {}): string {
  const value = optionalString(body, key, rule);
  const min = rule.minLength ?? 1;
  if (value === undefined || value.length < min) {
    throw badRequest(`${rule.label ?? key} is required.`);
  }
  return value;
}

export function optionalBoolean(body: unknown, key: string): boolean | undefined {
  const value = asRecord(body)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw badRequest(`"${key}" must be a boolean.`);
}

export function optionalNumber(body: unknown, key: string, rule: { min?: number; max?: number } = {}): number | undefined {
  const raw = asRecord(body)[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) throw badRequest(`"${key}" must be a number.`);
  if (rule.min !== undefined && value < rule.min) throw badRequest(`"${key}" must be at least ${rule.min}.`);
  if (rule.max !== undefined && value > rule.max) throw badRequest(`"${key}" must be at most ${rule.max}.`);
  return value;
}

export function optionalEnum<T extends string>(body: unknown, key: string, allowed: readonly T[]): T | undefined {
  const value = optionalString(body, key);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw badRequest(`"${key}" must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}
