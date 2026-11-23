import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { authenticate } from './auth.js';
import { config, configStatus, inlineRenderWarning, paths } from './config.js';
import { closeStore, initStore } from './db/index.js';
import { registerRoutes, type RouteOptions } from './routes/index.js';
import { reconcileOnBoot } from './services/reconciliation.js';
import { closeRenderQueue, interruptActiveRenders, startRenderWorker } from './services/renderService.js';
import { catchUpScheduledRun, startScheduler, stopScheduler } from './services/scheduler.js';
import { AppError } from './utils/errors.js';
import { errorMessage, logger } from './utils/logger.js';

export type BuildServerOptions = RouteOptions;

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 30 * 1024 * 1024, // canvas thumbnails arrive as base64 data URLs
    trustProxy: true,
  });

  await app.register(cors, { origin: true });

  // Runs before every route: assigns request.session and rejects unauthenticated /api calls.
  app.addHook('onRequest', authenticate);

  // Uploaded audio, clips and renders (read-only).
  await app.register(fastifyStatic, {
    root: paths.uploads,
    prefix: '/uploads/',
    decorateReply: false,
  });

  // Single-page frontend.
  if (fs.existsSync(paths.frontend)) {
    await app.register(fastifyStatic, {
      root: paths.frontend,
      prefix: '/',
      wildcard: true,
      decorateReply: false,
    });
  }

  // Handlers must be installed before route plugins register, otherwise the child
  // scope keeps Fastify's default error serialisation.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: `No route for ${request.method} ${request.url}` });
    }
    const indexPath = path.join(paths.frontend, 'index.html');
    if (!fs.existsSync(indexPath)) {
      return reply.code(404).type('text/plain').send('Frontend not found. Expected frontend/index.html.');
    }
    return reply.type('text/html').send(fs.readFileSync(indexPath));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error instanceof AppError ? error.statusCode : (error.statusCode ?? 500);
    const message = error.message || 'Unexpected error';

    if (statusCode >= 500) logger.error(`${request.method} ${request.url} → ${statusCode}: ${message}`);
    else logger.warn(`${request.method} ${request.url} → ${statusCode}: ${message}`);

    return reply.code(statusCode).send({
      error: message,
      ...(error instanceof AppError && error.details ? { details: error.details } : {}),
    });
  });

  await app.register(registerRoutes, { uploadDependencies: options.uploadDependencies });

  return app;
}

async function main(): Promise<void> {
  const store = await initStore();
  // Before the worker consumes anything: reclaim renders orphaned by the previous process.
  await reconcileOnBoot();
  const app = await buildServer();

  await app.listen({ port: config.port, host: config.host });
  logger.info(`YT AutoPilot listening on http://localhost:${config.port} (store: ${store.mode}).`);
  logger.info(
    config.apiTokenSource === 'env'
      ? 'API auth: token loaded from API_TOKEN.'
      : `API auth: no API_TOKEN set, so a token was generated in ${path.relative(process.cwd(), config.apiTokenFile)}. Paste it into the sign-in prompt.`,
  );

  const features = configStatus();
  const missing: string[] = [];
  if (!features.gemini) missing.push('GEMINI_API_KEY (topics, script, SEO)');
  if (!features.pexels) missing.push('PEXELS_API_KEY (stock footage)');
  if (!features.youtube) missing.push('YT_CLIENT_ID / YT_CLIENT_SECRET (YouTube upload)');
  if (missing.length) logger.warn(`Not configured yet: ${missing.join('; ')}. See backend/.env.example.`);

  const inlineWarning = inlineRenderWarning({ redisUrl: config.redisUrl, nodeEnv: config.nodeEnv });
  if (inlineWarning) logger.warn(inlineWarning);

  if (config.runWorker) startRenderWorker();
  if (config.schedulerEnabled) {
    startScheduler();
    // A restart just after the scheduled time would otherwise lose the whole day: run once if the
    // newest recorded run is older than the schedule window (the run lock still applies).
    void catchUpScheduledRun().catch((error: unknown) =>
      logger.error(`Boot catch-up run failed: ${errorMessage(error)}`),
    );
  } else {
    logger.info(`Scheduler idle. Set SCHEDULER_ENABLED=true to run "${config.cronSchedule}" (${config.cronTimezone}).`);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; shutting down.`);
    stopScheduler();
    // Stop pulling new jobs, then record how the in-flight render ended instead of leaving it
    // `active` for the next boot (or forever, when no process ever takes the store again).
    await closeRenderQueue({ force: true });
    await interruptActiveRenders(`The API was shut down (${signal}) while the render was running.`);
    await app.close().catch(() => undefined);
    await closeStore();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Only start listening when this file is the entry point; tests import buildServer().
const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPoint === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    logger.error(`Fatal startup error: ${errorMessage(error)}`);
    process.exit(1);
  });
}
