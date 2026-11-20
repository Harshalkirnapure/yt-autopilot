import { Queue, Worker } from 'bullmq';
import { config, inlineRenderWarning } from '../config.js';
import { getStore } from '../db/index.js';
import { badRequest, notFound } from '../utils/errors.js';
import { errorMessage, logger } from '../utils/logger.js';
import { notifyAdmin } from './alerts.js';
import { renderVideo } from './ffmpeg.js';
import { logStep } from './jobLog.js';

const QUEUE_NAME = 'yt-render';

interface RenderJobData {
  jobId: string;
  videoId: string;
}

let queue: Queue<RenderJobData> | null = null;
let worker: Worker<RenderJobData> | null = null;
let queueUnavailable = false;

interface InFlightRender {
  jobId: string;
  videoId: string;
  topic: string;
  startedAt: number;
}

/** Renders this process is running right now; shutdown turns these into resolved failures. */
const inFlight = new Map<string, InFlightRender>();

export function activeRenderJobs(): InFlightRender[] {
  return [...inFlight.values()];
}

function redisConnectionOptions() {
  if (!config.redisUrl) return null;
  try {
    const url = new URL(config.redisUrl);
    return {
      host: url.hostname,
      port: Number(url.port || 6379),
      username: url.username || undefined,
      password: url.password || undefined,
      db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
      ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
      maxRetriesPerRequest: null,
    };
  } catch {
    logger.warn(`REDIS_URL could not be parsed; falling back to inline rendering.`);
    return null;
  }
}

function getQueue(): Queue<RenderJobData> | null {
  if (queueUnavailable) return null;
  const connection = redisConnectionOptions();
  if (!connection) {
    queueUnavailable = true;
    return null;
  }
  if (!queue) {
    queue = new Queue<RenderJobData>(QUEUE_NAME, { connection });
    queue.on('error', (error) => logger.error(`Render queue error: ${errorMessage(error)}`));
  }
  return queue;
}

export interface EnqueueResult {
  jobId: string;
  mode: 'queue' | 'inline';
}

export async function enqueueRender(videoId: string): Promise<EnqueueResult> {
  const store = getStore();
  const video = await store.getVideo(videoId);
  if (!video) throw notFound(`Video ${videoId} not found.`);
  if (!video.audio_path) throw badRequest('Generate the voiceover MP3 before starting a render.');
  if (!video.script?.trim()) throw badRequest('The video has no script to render.');

  const job = await store.createJob(videoId, 'queued');

  if (config.redisUrl && !queueUnavailable) {
    try {
      const activeQueue = getQueue();
      if (activeQueue) {
        await activeQueue.add(
          'render',
          { jobId: job.id, videoId },
          { jobId: job.id, removeOnComplete: 50, removeOnFail: 50, attempts: 1 },
        );
        logger.info(`Render job ${job.id} queued for video ${videoId}.`);
        return { jobId: job.id, mode: 'queue' };
      }
    } catch (error) {
      queueUnavailable = true;
      logger.warn(`Redis is unreachable, rendering inline instead: ${errorMessage(error)}`);
    }
  }

  setImmediate(() => {
    void processRenderJob(job.id, videoId).catch((error: unknown) =>
      logger.error(`Inline render job ${job.id} failed: ${errorMessage(error)}`),
    );
  });

  return { jobId: job.id, mode: 'inline' };
}

/** Shared by the BullMQ worker and the inline fallback. */
export async function processRenderJob(jobId: string, videoId: string): Promise<void> {
  const store = getStore();
  const video = await store.getVideo(videoId);
  if (!video) throw notFound(`Video ${videoId} not found.`);

  await store.updateJob(jobId, { status: 'active', progress: 1, stage: 'starting' });
  await logStep(videoId, 'render', 'info', 'Render started.');

  inFlight.set(jobId, { jobId, videoId, topic: video.topic, startedAt: Date.now() });
  let lastProgress = -1;

  try {
    if (!video.audio_path) throw badRequest('The video has no voiceover audio.');
    if (!video.script?.trim()) throw badRequest('The video has no script.');

    const result = await renderVideo({
      videoId,
      audioPath: video.audio_path,
      script: video.script,
      niche: video.niche ?? config.defaultNiche,
      onProgress: (progress, stage) => {
        if (progress === lastProgress) return;
        lastProgress = progress;
        void store
          .updateJob(jobId, { progress, stage })
          .catch((error: unknown) => logger.debug(`Progress update failed: ${errorMessage(error)}`));
      },
    });

    await store.updateVideo(videoId, {
      video_path: result.videoPath,
      caption_path: result.captionPath,
      audio_duration: result.durationSeconds,
      status: 'rendered',
      error: null,
    });
    await store.updateJob(jobId, { status: 'completed', progress: 100, stage: 'completed' });
    await logStep(
      videoId,
      'render',
      'success',
      `Rendered ${result.sections} sections using ${result.clipIds.length} clips (${result.durationSeconds.toFixed(1)}s).`,
    );
    await notifyAdmin(
      `Render finished for "${video.topic}". It is waiting for your review and explicit approval before publishing.`,
    );
  } catch (error) {
    const message = errorMessage(error);
    await store.updateJob(jobId, { status: 'failed', progress: 0, stage: 'failed', error: message });
    await store.updateVideo(videoId, { status: 'failed', error: message });
    await logStep(videoId, 'render', 'failed', message);
    await notifyAdmin(`Render failed for "${video.topic}": ${message}`, 'error');
    throw error;
  } finally {
    inFlight.delete(jobId);
  }
}

/**
 * Called from the shutdown path: the FFmpeg children are about to be killed with the process, so
 * write the outcome now instead of leaving the job `active` until the next boot reclaims it.
 * Best effort — a shutdown must never hang on the database.
 */
export async function interruptActiveRenders(reason: string): Promise<number> {
  const orphans = activeRenderJobs();
  inFlight.clear();
  if (orphans.length === 0) return 0;

  const store = getStore();
  for (const render of orphans) {
    const elapsed = formatElapsed(Date.now() - render.startedAt);
    const message = `${reason} The render of "${render.topic}" was stopped after ${elapsed}, so job ${render.jobId} is marked failed; render it again when the server is back.`;

    await store
      .updateJob(render.jobId, { status: 'failed', stage: 'interrupted', error: message })
      .catch((error: unknown) => logger.warn(`Could not fail interrupted job ${render.jobId}: ${errorMessage(error)}`));

    const video = await store.getVideo(render.videoId).catch(() => null);
    if (video && (video.status === 'draft' || video.status === 'failed')) {
      await store
        .updateVideo(render.videoId, { status: 'failed', error: message })
        .catch((error: unknown) =>
          logger.warn(`Could not mark interrupted video ${render.videoId} failed: ${errorMessage(error)}`),
        );
    }

    await logStep(render.videoId, 'render', 'failed', message);
    logger.warn(message);
  }

  return orphans.length;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function startRenderWorker(): void {
  if (worker) return;
  const connection = redisConnectionOptions();
  if (!connection) {
    // The startup warning about inline rendering is logged once by server.ts.
    logger.debug(inlineRenderWarning({ redisUrl: config.redisUrl, nodeEnv: config.nodeEnv }) ?? 'Inline rendering.');
    return;
  }

  worker = new Worker<RenderJobData>(
    QUEUE_NAME,
    async (job) => {
      await processRenderJob(job.data.jobId, job.data.videoId);
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, error) => logger.error(`Render job ${job?.id ?? '?'} failed: ${errorMessage(error)}`));
  worker.on('error', (error) => logger.error(`Render worker error: ${errorMessage(error)}`));
  logger.info('BullMQ render worker started (concurrency 1).');
}

/**
 * `force: true` closes without waiting for the job in flight. Shutdown wants that: the render is
 * about to be killed anyway, and `interruptActiveRenders()` records how it ended.
 */
export async function closeRenderQueue(options: { force?: boolean } = {}): Promise<void> {
  await worker?.close(options.force ?? false).catch(() => undefined);
  await queue?.close().catch(() => undefined);
  worker = null;
  queue = null;
}
