import type { FastifyInstance } from 'fastify';
import { getStore } from '../db/index.js';
import { logStep } from '../services/jobLog.js';
import { saveThumbnail } from '../services/thumbnail.js';
import { notFound } from '../utils/errors.js';
import { publicUploadUrl } from '../utils/urls.js';
import { requireString } from '../utils/validate.js';

export async function thumbnailRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/thumbnail', async (request) => {
    const videoId = requireString(request.body, 'videoId', { maxLength: 64, label: 'videoId' });
    const image = requireString(request.body, 'image', {
      maxLength: 16_000_000,
      label: 'thumbnail image',
    });

    const store = getStore();
    const video = await store.getVideo(videoId);
    if (!video) throw notFound(`Video ${videoId} not found.`);

    const saved = await saveThumbnail(videoId, image);
    const updated = await store.updateVideo(videoId, { thumbnail_path: saved.filePath });
    await logStep(videoId, 'thumbnail', 'success', `Thumbnail saved (${Math.round(saved.bytes / 1024)} KB).`);

    return {
      thumbnailPath: saved.filePath,
      thumbnailUrl: publicUploadUrl(saved.filePath),
      video: { id: updated.id, status: updated.status },
    };
  });
}
