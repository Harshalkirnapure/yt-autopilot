import type { FastifyInstance } from 'fastify';
import { getStore } from '../db/index.js';
import { logStep } from '../services/jobLog.js';
import { generateSeo } from '../services/seoService.js';
import { notFound } from '../utils/errors.js';
import { optionalString, requireString } from '../utils/validate.js';

export async function seoRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/seo', async (request) => {
    const body = request.body;
    const topic = requireString(body, 'topic', { maxLength: 200, label: 'topic' });
    const niche = requireString(body, 'niche', { maxLength: 120, label: 'niche' });
    const audience = optionalString(body, 'audience', { maxLength: 200 });
    const language = optionalString(body, 'language', { maxLength: 120 });
    const videoId = optionalString(body, 'videoId', { maxLength: 64 });

    const metadata = await generateSeo({ topic, niche, audience, language });

    if (videoId) {
      const store = getStore();
      const video = await store.getVideo(videoId);
      if (!video) throw notFound(`Video ${videoId} not found.`);
      await store.updateVideo(videoId, {
        seo_title: metadata.title_options[0] ?? topic,
        seo_description: metadata.description,
        seo_tags: metadata.tags,
      });
      await logStep(
        videoId,
        'seo',
        'success',
        `SEO metadata generated (${metadata.title_options.length} titles, ${metadata.tags.length} tags).`,
      );
    }

    return metadata;
  });
}
