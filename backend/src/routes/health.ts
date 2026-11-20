import type { FastifyInstance } from 'fastify';
import { config, configStatus } from '../config.js';
import { getStore } from '../db/index.js';
import { checkFfmpegAvailable, ffmpegBinary } from '../services/ffmpeg.js';
import { schedulerStatus } from '../services/scheduler.js';
import { uploadQuota } from '../services/youtube.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    const store = getStore();
    const lastRun = await store.latestPipelineRun();
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
