import { closeStore, initStore, getStore } from './db/index.js';
import { runDaily } from './services/pipeline.js';
import { closeRenderQueue } from './services/renderService.js';
import { errorMessage, logger } from './utils/logger.js';

/**
 * Manual daily run: `npm run run:daily -- "personal finance" "young professionals"`.
 * Useful for a dry run before enabling the scheduler. Uploads are never automatic.
 */
const [nicheArg, audienceArg] = process.argv.slice(2);

await initStore();

try {
  const result = await runDaily({
    niche: nicheArg,
    audience: audienceArg,
    force: true,
    trigger: 'manual',
  });

  if (result.status === 'skipped') {
    logger.info(`Skipped: ${result.reason ?? 'already generated today'}`);
  } else {
    logger.info(`Video ${result.videoId} started (job ${result.jobId}, mode ${result.mode}).`);

    if (result.jobId) {
      const deadline = Date.now() + 45 * 60 * 1000;
      let lastProgress = -1;
      while (Date.now() < deadline) {
        const job = await getStore().getJob(result.jobId);
        if (!job) break;
        if (job.progress !== lastProgress) {
          lastProgress = job.progress;
          logger.info(`Render ${job.status} — ${job.progress}% (${job.stage ?? 'working'})`);
        }
        if (job.status === 'completed' || job.status === 'failed') {
          if (job.status === 'failed') process.exitCode = 1;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }
} catch (error) {
  logger.error(`Manually triggered pipeline failed: ${errorMessage(error)}`);
  process.exitCode = 1;
} finally {
  await closeRenderQueue();
  await closeStore();
}
