import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.js';
import { healthRoutes } from './health.js';
import { renderRoutes } from './render.js';
import { scriptRoutes } from './script.js';
import { seoRoutes } from './seo.js';
import { thumbnailRoutes } from './thumbnail.js';
import { topicRoutes } from './topics.js';
import { ttsRoutes } from './tts.js';
import { uploadRoutes } from './upload.js';
import { videoRoutes } from './videos.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(authRoutes);
  await app.register(healthRoutes);
  await app.register(topicRoutes);
  await app.register(videoRoutes);
  await app.register(scriptRoutes);
  await app.register(ttsRoutes);
  await app.register(seoRoutes);
  await app.register(thumbnailRoutes);
  await app.register(renderRoutes);
  await app.register(uploadRoutes);
}
