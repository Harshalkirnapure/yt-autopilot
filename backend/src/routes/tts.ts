import type { FastifyInstance } from 'fastify';
import { getStore } from '../db/index.js';
import { synthesizeSpeech } from '../services/edgeTts.js';
import { logStep } from '../services/jobLog.js';
import { notFound } from '../utils/errors.js';
import { publicUploadUrl, serializeVideo } from '../utils/urls.js';
import { optionalString, requireString } from '../utils/validate.js';

export async function ttsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/tts', async (request) => {
    const body = request.body;
    const script = requireString(body, 'script', { maxLength: 30_000, label: 'script' });
    const voice = optionalString(body, 'voice', { maxLength: 80 });
    const videoId = optionalString(body, 'videoId', { maxLength: 64 });
    const niche = optionalString(body, 'niche', { maxLength: 120 });
    const audience = optionalString(body, 'audience', { maxLength: 200 });
    const language = optionalString(body, 'language', { maxLength: 120 });

    const store = getStore();
    let video = videoId ? await store.getVideo(videoId) : null;
    if (videoId && !video) throw notFound(`Video ${videoId} not found.`);

    if (!video) {
      const topic = script.replace(/\s+/g, ' ').trim().slice(0, 90) || 'Untitled video';
      video = await store.createVideo({ topic, niche, audience, language });
    }

    const speech = await synthesizeSpeech({ script, voice, videoId: video.id });

    const updated = await store.updateVideo(video.id, {
      script,
      audio_path: speech.filePath,
      audio_duration: speech.durationSeconds,
      status: video.status === 'failed' ? 'draft' : video.status,
      error: null,
    });

    await logStep(
      video.id,
      'tts',
      'success',
      `Voiceover generated with ${speech.provider} (${speech.voice}, ${Math.round(speech.bytes / 1024)} KB).`,
    );

    return {
      videoId: video.id,
      audioPath: speech.filePath,
      audioUrl: publicUploadUrl(speech.filePath),
      durationSeconds: speech.durationSeconds,
      provider: speech.provider,
      voice: speech.voice,
      bytes: speech.bytes,
      video: serializeVideo(updated),
    };
  });
}
