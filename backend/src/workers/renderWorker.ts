import { config } from '../config.js';
import { closeStore, initStore } from '../db/index.js';
import { reconcileOnBoot } from '../services/reconciliation.js';
import { closeRenderQueue, interruptActiveRenders, startRenderWorker } from '../services/renderService.js';
import { logger } from '../utils/logger.js';

/** Standalone worker process: `npm run worker` (useful when the API runs elsewhere). */
if (!config.redisUrl) {
  logger.error('REDIS_URL is not set. The standalone worker needs Redis; set REDIS_URL and retry.');
  process.exit(1);
}

await initStore();
// Reclaim renders left `active` by a previous worker process before taking new work.
await reconcileOnBoot();
startRenderWorker();
logger.info('Standalone render worker is running. Press Ctrl+C to stop.');

const shutdown = async (signal: string): Promise<void> => {
  logger.info(`Received ${signal}; shutting down the worker.`);
  await closeRenderQueue({ force: true });
  await interruptActiveRenders(`The render worker was shut down (${signal}) while the render was running.`);
  await closeStore();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
