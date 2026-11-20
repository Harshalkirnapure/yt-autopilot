import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { unauthorized } from './utils/errors.js';

export const SESSION_COOKIE = 'yt_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionIdentity {
  /** Shown in the UI and stored as `approved_by` when this session approves a video. */
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionIdentity | null;
  }
}

/** Constant-time comparison that also hides the input length. */
function safeEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

export function verifyToken(token: string): boolean {
  return token.length > 0 && safeEqual(token, config.apiToken);
}

function sign(payload: string): string {
  return createHmac('sha256', config.apiToken).update(payload).digest('base64url');
}

/** Signed cookie: the API token itself never leaves the server. */
function createSessionValue(name: string): string {
  const payload = Buffer.from(JSON.stringify({ name, exp: Date.now() + SESSION_TTL_MS }), 'utf8').toString(
    'base64url',
  );
  return `${payload}.${sign(payload)}`;
}

function decodeSessionValue(raw: string): SessionIdentity | null {
  const [payload, signature] = raw.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      name?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
    const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : config.approverName;
    return { name: name.slice(0, 80) };
  } catch {
    return null;
  }
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/** Bearer token for scripts/curl, or the browser's signed session cookie. */
export function readSession(request: FastifyRequest): SessionIdentity | null {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    if (verifyToken(token)) return { name: config.approverName };
  }

  const raw = readCookie(request.headers.cookie, SESSION_COOKIE);
  return raw ? decodeSessionValue(raw) : null;
}

export function setSessionCookie(reply: FastifyReply, name: string): void {
  reply.header(
    'set-cookie',
    [
      `${SESSION_COOKIE}=${createSessionValue(name)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      ...(config.publicBaseUrl.startsWith('https:') ? ['Secure'] : []),
    ].join('; '),
  );
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/** Reachable without a session: the SPA shell, health checks, sign-in and the OAuth redirect. */
const PUBLIC_ROUTES = new Set([
  '/api/health',
  '/api/login',
  '/api/logout',
  '/api/session',
  '/api/youtube/callback',
]);

/**
 * Every other /api route needs a valid session. This is deliberately an allowlist: a new route
 * is protected by default instead of silently shipping open.
 */
export async function authenticate(request: FastifyRequest): Promise<void> {
  request.session = readSession(request);

  const pathname = (request.url.split('?')[0] ?? '').replace(/\/+$/, '');
  if (!pathname.startsWith('/api/') || PUBLIC_ROUTES.has(pathname)) return;
  if (request.session) return;

  throw unauthorized(
    'Sign in first: POST /api/login with the API token, or send "Authorization: Bearer <token>".',
  );
}
