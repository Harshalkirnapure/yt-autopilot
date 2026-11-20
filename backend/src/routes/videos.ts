import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getStore } from '../db/index.js';
import { logStep } from '../services/jobLog.js';
import { badRequest, notFound } from '../utils/errors.js';
import { serializeVideo } from '../utils/urls.js';
import { optionalBoolean, optionalString, requireString } from '../utils/validate.js';

export async function videoRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/videos', async (request) => {
    const body = request.body;
    const topic = requireString(body, 'topic', { maxLength: 200, label: 'topic' });
    const niche = optionalString(body, 'niche', { maxLength: 120 });
    const audience = optionalString(body, 'audience', { maxLength: 200 });
    const language = optionalString(body, 'language', { maxLength: 120 });

    const store = getStore();
    const video = await store.createVideo({ topic, niche, audience, language });
    await store.addUsedTopic(topic, niche ?? null, video.id);
    await logStep(video.id, 'topic', 'success', `Draft created for "${topic}".`);

    return { video: serializeVideo(video) };
  });

  app.get('/api/videos', async (request) => {
    const query = request.query as { limit?: string };
    const limit = Number(query.limit);
    const store = getStore();
    const videos = await store.listVideos(
      Number.isFinite(limit) && limit > 0 ? Math.min(Math.round(limit), 100) : 20,
    );
    return { videos: videos.map(serializeVideo) };
  });

  app.get('/api/videos/:id', async (request) => {
    const { id } = request.params as { id: string };
    const store = getStore();
    const video = await store.getVideo(id);
    if (!video) throw notFound(`Video ${id} not found.`);

    const [logs, jobs] = await Promise.all([store.listLogs(id, 30), store.listJobs(id, 3)]);
    return { video: serializeVideo(video), logs, jobs };
  });

  app.patch('/api/videos/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body;
    const store = getStore();
    const video = await store.getVideo(id);
    if (!video) throw notFound(`Video ${id} not found.`);

    const topic = optionalString(body, 'topic', { maxLength: 200 });
    const script = optionalString(body, 'script', { maxLength: 30_000 });
    const seoTitle = optionalString(body, 'seoTitle', { maxLength: 100 });
    const seoDescription = optionalString(body, 'seoDescription', { maxLength: 5000 });
    const rawTags = (body as { seoTags?: unknown } | null)?.seoTags;
    const seoTags = Array.isArray(rawTags)
      ? rawTags
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => tag.trim().slice(0, 30))
          .filter(Boolean)
          .slice(0, 15)
      : undefined;

    const updated = await store.updateVideo(id, {
      ...(topic ? { topic } : {}),
      ...(script ? { script } : {}),
      ...(seoTitle ? { seo_title: seoTitle } : {}),
      ...(seoDescription ? { seo_description: seoDescription } : {}),
      ...(seoTags !== undefined ? { seo_tags: seoTags } : {}),
    });

    return { video: serializeVideo(updated) };
  });

  app.post('/api/videos/:id/approve', async (request) => {
    const { id } = request.params as { id: string };
    const approved = optionalBoolean(request.body, 'approved') ?? true;
    if (!approved) throw badRequest('Send {"approved": true} to record human approval.');

    const store = getStore();
    const video = await store.getVideo(id);
    if (!video) throw notFound(`Video ${id} not found.`);
    if (!video.youtube_video_id) {
      throw badRequest('Upload the video as private or unlisted before approving it.');
    }

    const approver = request.session?.name ?? config.approverName;
    const updated = await store.updateVideo(id, {
      approved_at: new Date().toISOString(),
      approved_by: approver,
    });
    await logStep(id, 'approval', 'success', `Approved for publication by ${approver}.`);

    return { video: serializeVideo(updated) };
  });
}
