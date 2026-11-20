import type { FastifyInstance } from 'fastify';
import { getStore } from '../db/index.js';
import { generateScript } from '../services/scriptService.js';
import { logStep } from '../services/jobLog.js';
import { notFound } from '../utils/errors.js';
import { optionalNumber, optionalString, requireString } from '../utils/validate.js';

export async function scriptRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/script', async (request) => {
    const body = request.body;
    const topic = requireString(body, 'topic', { maxLength: 200, label: 'topic' });
    const niche = requireString(body, 'niche', { maxLength: 120, label: 'niche' });
    const audience = requireString(body, 'audience', { maxLength: 200, label: 'audience' });
    const language = requireString(body, 'language', { maxLength: 120, label: 'language' });
    const length = optionalNumber(body, 'length', { min: 100, max: 4000 });
    const videoId = optionalString(body, 'videoId', { maxLength: 64 });

    const script = await generateScript({ topic, niche, audience, language, length });
    const wordCount = script.split(/\s+/).filter(Boolean).length;

    if (videoId) {
      const store = getStore();
      const video = await store.getVideo(videoId);
      if (!video) throw notFound(`Video ${videoId} not found.`);
      await store.updateVideo(videoId, { script, topic, niche, audience, language });
      await logStep(videoId, 'script', 'success', `Script generated (${wordCount} words).`);
    }

    return { script, wordCount };
  });
}
