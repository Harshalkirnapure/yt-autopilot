import type { FastifyInstance } from 'fastify';
import { clearSessionCookie, setSessionCookie, verifyToken } from '../auth.js';
import { config } from '../config.js';
import { unauthorized } from '../utils/errors.js';
import { optionalString, requireString } from '../utils/validate.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** Sign in with the API token; the response sets the signed session cookie. */
  app.post('/api/login', async (request, reply) => {
    const body = request.body;
    const token = requireString(body, 'token', { maxLength: 200, label: 'token' });
    if (!verifyToken(token)) throw unauthorized('That API token is not valid.');

    const name = optionalString(body, 'name', { maxLength: 80 }) ?? config.approverName;
    setSessionCookie(reply, name);
    return { authenticated: true, approver: name };
  });

  app.post('/api/logout', async (_request, reply) => {
    clearSessionCookie(reply);
    return { authenticated: false };
  });

  /** Lets the SPA decide whether to show the sign-in screen. */
  app.get('/api/session', async (request) => ({
    authenticated: Boolean(request.session),
    approver: request.session?.name ?? null,
  }));
}
