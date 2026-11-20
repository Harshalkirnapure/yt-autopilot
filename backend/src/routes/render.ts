import type { FastifyInstance } from 'fastify';
import { getStore } from '../db/index.js';
import { enqueueRender } from '../services/renderService.js';
import { notFound } from '../utils/errors.js';
import { serializeVideo } from '../utils/urls.js';
import { requireString } from '../utils/validate.js';

export async function renderRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/render', async (request) => {
    const videoId = requireString(request.body, 'videoId', { maxLength: 64, label: 'videoId' });
    const result = await enqueueRender(videoId);
    return { jobId: result.jobId, mode: result.mode, status: 'queued' };
  });

  app.get('/api/status/:jobId', async (request) => {
    const { jobId } = request.params as { jobId: string };
    const store = getStore();

    const job = await store.getJob(jobId);
    if (!job) throw notFound(`Job ${jobId} not found.`);

    const [video, logs] = await Promise.all([
      store.getVideo(job.video_id),
      store.listLogs(job.video_id, 20),
    ]);

    return {
      job,
      video: video ? serializeVideo(video) : null,
      logs,
    };
  });
}
