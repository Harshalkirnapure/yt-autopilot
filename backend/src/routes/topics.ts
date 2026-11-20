import type { FastifyInstance } from 'fastify';
import { generateTopics } from '../services/topicService.js';
import { requireString } from '../utils/validate.js';

export async function topicRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/topics', async (request) => {
    const body = request.body;
    const niche = requireString(body, 'niche', { maxLength: 120, label: 'niche' });
    const audience = requireString(body, 'audience', { maxLength: 200, label: 'audience' });
    const language = requireString(body, 'language', { maxLength: 120, label: 'language' });

    return generateTopics({ niche, audience, language });
  });
}
