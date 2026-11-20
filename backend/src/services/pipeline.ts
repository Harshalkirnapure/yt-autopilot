import { config } from '../config.js';
import { getStore } from '../db/index.js';
import type { FinishPipelineRunPatch } from '../db/types.js';
import { errorMessage, logger } from '../utils/logger.js';
import { notifyAdmin } from './alerts.js';
import { synthesizeSpeech } from './edgeTts.js';
import { logStep } from './jobLog.js';
import { enqueueRender } from './renderService.js';
import { generateScript } from './scriptService.js';
import { generateSeo } from './seoService.js';
import { generateTopics } from './topicService.js';

export type PipelineTrigger = 'schedule' | 'boot' | 'manual';

export interface PipelineOptions {
  niche?: string;
  audience?: string;
  language?: string;
  length?: number;
  voice?: string;
  force?: boolean;
  trigger?: PipelineTrigger;
}

export interface PipelineResult {
  status: 'started' | 'skipped';
  videoId?: string;
  jobId?: string;
  mode?: 'queue' | 'inline';
  topic?: string;
  reason?: string;
}

const TWENTY_HOURS_MS = 20 * 60 * 60 * 1000;

/** One full automated run: topic → script → audio → SEO → render job. Never uploads. */
export async function runDaily(options: PipelineOptions = {}): Promise<PipelineResult> {
  const store = getStore();

  // One run at a time, across processes: a scheduled fire, a boot catch-up and a manual CLI run
  // must never each generate a video. The ledger write happens inside this try, so a failing
  // insert still releases the lock (and, in Postgres, the pooled connection holding it).
  const releaseLock = await store.acquirePipelineLock();
  if (!releaseLock) {
    const reason = 'Another pipeline run is already in progress (advisory lock held).';
    logger.warn(`Daily pipeline skipped: ${reason}`);
    await logStep(null, 'pipeline', 'warning', `Daily run skipped — ${reason}`);
    return { status: 'skipped', reason };
  }

  try {
    return await runPipeline(options);
  } finally {
    await releaseLock();
  }
}

/** One attempt, recorded in the ledger. Only ever called while the pipeline lock is held. */
async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const store = getStore();
  const trigger = options.trigger ?? 'manual';
  const niche = options.niche?.trim() || config.defaultNiche;
  const audience = options.audience?.trim() || config.defaultAudience;
  const language = options.language?.trim() || config.defaultLanguage;
  const length = options.length ?? config.defaultScriptLength;

  const run = await store.startPipelineRun({ trigger, niche, audience });
  const finish = async (patch: FinishPipelineRunPatch): Promise<void> => {
    try {
      await store.finishPipelineRun(run.id, patch);
    } catch (error) {
      logger.warn(`Could not close pipeline run ${run.id}: ${errorMessage(error)}`);
    }
  };

  if (!options.force) {
    const [latest] = await store.listVideos(1);
    if (latest && Date.now() - Date.parse(latest.created_at) < TWENTY_HOURS_MS && latest.status !== 'failed') {
      // No topic here: this string is read back on the public /api/health route, so it stays
      // about the schedule, not the channel's content.
      const reason = `A video was already generated in the last 20 hours (status: ${latest.status}).`;
      logger.info(`Daily pipeline skipped: ${reason} ("${latest.topic}").`);
      await logStep(latest.id, 'pipeline', 'info', `Daily run skipped — ${reason}`);
      await finish({ status: 'skipped', videoId: latest.id, reason });
      return { status: 'skipped', reason, videoId: latest.id };
    }
  }

  logger.info(`Daily pipeline started (${trigger}) for niche "${niche}".`);
  let videoId: string | null = null;

  try {
    const topics = await generateTopics({ niche, audience, language });
    const chosen = topics.topics[0];
    if (!chosen) throw new Error('No usable topic could be generated.');

    const video = await store.createVideo({ topic: chosen.title, niche, audience, language });
    videoId = video.id;
    await store.addUsedTopic(chosen.title, niche, video.id);
    await logStep(video.id, 'topic', 'success', `Topic: ${chosen.title} (source: ${topics.source}).`);

    const script = await generateScript({ topic: chosen.title, niche, audience, language, length });
    await store.updateVideo(video.id, { script });
    await logStep(video.id, 'script', 'success', `Generated a ${script.split(/\s+/).length}-word script.`);

    const speech = await synthesizeSpeech({
      script,
      voice: options.voice ?? config.defaultVoice,
      videoId: video.id,
    });
    await store.updateVideo(video.id, {
      audio_path: speech.filePath,
      audio_duration: speech.durationSeconds,
    });
    await logStep(
      video.id,
      'tts',
      'success',
      `Voiceover generated with ${speech.provider} (${speech.voice}, ${speech.bytes} bytes).`,
    );

    const seo = await generateSeo({ topic: chosen.title, niche, audience, language });
    await store.updateVideo(video.id, {
      seo_title: seo.title_options[0] ?? chosen.title,
      seo_description: seo.description,
      seo_tags: seo.tags,
    });
    await logStep(video.id, 'seo', 'success', `SEO metadata generated (${seo.title_options.length} title options).`);

    const enqueued = await enqueueRender(video.id);
    await logStep(video.id, 'pipeline', 'success', `Render job ${enqueued.jobId} created (${enqueued.mode}).`);

    await notifyAdmin(
      [
        `Daily draft ready: "${chosen.title}"`,
        `Niche: ${niche}`,
        `Render job: ${enqueued.jobId} (${enqueued.mode})`,
        'Uploads stay manual until you approve the video.',
      ].join('\n'),
    );

    await finish({ status: 'completed', videoId: video.id, jobId: enqueued.jobId });
    return {
      status: 'started',
      videoId: video.id,
      jobId: enqueued.jobId,
      mode: enqueued.mode,
      topic: chosen.title,
    };
  } catch (error) {
    const message = errorMessage(error);
    logger.error(`Daily pipeline failed: ${message}`);
    if (videoId) {
      await store.updateVideo(videoId, { status: 'failed', error: message }).catch(() => undefined);
      await logStep(videoId, 'pipeline', 'failed', message);
      await notifyAdmin(`Daily pipeline failed for video ${videoId}: ${message}`, 'error');
    } else {
      await notifyAdmin(`Daily pipeline failed before a video was created: ${message}`, 'error');
    }
    await finish({ status: 'failed', videoId, error: message });
    throw error;
  }
}
