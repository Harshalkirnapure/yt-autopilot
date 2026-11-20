import type { FastifyInstance } from 'fastify';
import { config, configStatus } from '../config.js';
import { getStore } from '../db/index.js';
import { checkFfmpegAvailable, ffmpegBinary } from '../services/ffmpeg.js';
import { schedulerStatus } from '../services/scheduler.js';
import { uploadQuota } from '../services/youtube.js';

/**
 * A channel that has produced nothing inside the threshold has silently stopped: the cron tick may be
 * dead, the process may not be running, or every run is failing. A fresh ledger is not silent —
 * there is no history to measure yet.
 */
export function pipelineSilent(lastActivityAt: string | null, now: Date, thresholdMs: number): boolean {
  if (!lastActivityAt) return false;
  return Date.parse(lastActivityAt) < now.getTime() - thresholdMs;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    const store = getStore();
    const lastRun = await store.latestPipelineRun();
    const lastCompleted = await store.latestCompletedPipelineRun();
    // Silence is measured from the last video actually produced; before any completed run, any
    // finished attempt is the best evidence the channel is still alive.
    const lastActivityAt = lastCompleted?.finished_at ?? lastRun?.finished_at ?? lastRun?.started_at ?? null;
    return {
      ok: true,
      time: new Date().toISOString(),
      store: store.mode,
      queue: config.redisUrl ? 'redis' : 'inline',
      ffmpeg: { available: await checkFfmpegAvailable(), binary: ffmpegBinary },
      scheduler: schedulerStatus(),
      features: configStatus(),
      quota: await uploadQuota(),
      // The ledger, so "did the pipeline run today?" is answerable without a SQL client. This route
      // needs no session, so only schedule facts are published: no ids, no topic, no error text.
      pipeline: lastRun
        ? {
            trigger: lastRun.trigger,
            status: lastRun.status,
            startedAt: lastRun.started_at,
            finishedAt: lastRun.finished_at,
            reason: lastRun.reason,
            silent: pipelineSilent(lastActivityAt, new Date(), config.pipelineSilentMs),
            silenceHours: Math.max(1, Math.round(config.pipelineSilentMs / 3_600_000)),
          }
        : null,
      defaults: {
        voice: config.defaultVoice,
        niche: config.defaultNiche,
        audience: config.defaultAudience,
        language: config.defaultLanguage,
        scriptLength: config.defaultScriptLength,
      },
    };
  });
}
