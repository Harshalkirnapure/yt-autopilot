import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config, paths } from '../config.js';
import { getStore } from '../db/index.js';
import { logStep } from '../services/jobLog.js';
import {
  buildAuthUrl,
  handleOAuthCallback,
  setVideoPrivacy,
  uploadLimit,
  uploadQuota,
  uploadToYouTube,
  youtubeConfigured,
  type UploadPrivacy,
} from '../services/youtube.js';
import { badRequest, conflict, forbidden, notFound, tooManyRequests } from '../utils/errors.js';
import { errorMessage, logger } from '../utils/logger.js';
import { serializeVideo } from '../utils/urls.js';
import { optionalBoolean, optionalEnum, requireString } from '../utils/validate.js';

/** In-process guard so a double-click is rejected before it can reserve a quota slot. */
const uploadsInFlight = new Set<string>();

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/youtube/auth', async (request, reply) => {
    const url = await buildAuthUrl();
    const query = request.query as { redirect?: string };
    if (query.redirect === '1' || query.redirect === 'true') {
      return reply.redirect(url);
    }
    return { url };
  });

  app.get('/api/youtube/callback', async (request, reply) => {
    const query = request.query as { code?: string; error?: string };

    if (query.error) {
      return reply.redirect(`/?youtube=error&reason=${encodeURIComponent(query.error)}`);
    }
    if (!query.code) {
      return reply.code(400).send({ error: 'Missing OAuth authorization code.' });
    }

    try {
      const result = await handleOAuthCallback(query.code);
      await logStep(
        null,
        'youtube',
        'success',
        `YouTube channel connected${result.channelId ? ` (${result.channelId})` : ''}.`,
      );
      return reply.redirect('/?youtube=connected');
    } catch (error) {
      const message = errorMessage(error);
      logger.error(`YouTube OAuth callback failed: ${message}`);
      await logStep(null, 'youtube', 'failed', message);
      return reply.redirect(`/?youtube=error&reason=${encodeURIComponent(message)}`);
    }
  });

  app.get('/api/youtube/status', async () => {
    const tokens = await getStore().getTokens();
    return {
      configured: youtubeConfigured(),
      connected: Boolean(tokens?.refresh_token || tokens?.access_token),
      channelId: tokens?.channel_id ?? null,
      auditPassed: config.ytAuditPassed,
      // Shown in the review step: has every upload declared altered/synthetic content?
      syntheticMediaDisclosure: config.ytDiscloseSyntheticMedia,
      redirectUri: config.ytRedirectUri,
      quota: await uploadQuota(),
    };
  });

  app.post('/api/upload', async (request) => {
    const body = request.body;
    const videoId = requireString(body, 'videoId', { maxLength: 64, label: 'videoId' });
    // Compliance: nothing is published here. Public visibility is a separate, audited step.
    const privacyStatus: UploadPrivacy =
      optionalEnum<UploadPrivacy>(body, 'privacyStatus', ['private', 'unlisted']) ?? 'private';
    const confirmed = optionalBoolean(body, 'confirm');
    if (confirmed !== true) throw badRequest('Set "confirm": true to confirm the upload.');
    // Deliberate escape hatch: re-upload a video that already has a YouTube id.
    const replace = optionalBoolean(body, 'replace') ?? false;

    const store = getStore();
    const video = await store.getVideo(videoId);
    if (!video) throw notFound(`Video ${videoId} not found.`);
    if (!video.video_path) throw badRequest('Render the MP4 before uploading.');
    if (!video.seo_title) throw badRequest('Generate SEO metadata before uploading.');

    // A double-click or a retry after a timeout must never create a second YouTube video or spend
    // a second slot of the daily quota.
    if (video.youtube_video_id && !replace) {
      throw conflict(
        `This video is already uploaded as ${video.youtube_video_id}. Send "replace": true to upload it again as a new YouTube video.`,
      );
    }
    if (uploadsInFlight.has(videoId)) {
      throw conflict('An upload for this video is already in progress. Wait for it to finish.');
    }

    uploadsInFlight.add(videoId);
    let reservedAt: string | null = null;
    let uploaded = false;

    try {
      // Atomic claim: duplicate / in-flight / quota are decided in one store operation, so two
      // concurrent requests cannot both take the last quota slot.
      const claim = await store.claimUploadSlot(videoId, { limit: uploadLimit(), replace });
      if (claim.status === 'already_uploaded') {
        throw conflict(
          `This video is already uploaded as ${claim.youtubeVideoId}. Send "replace": true to upload it again as a new YouTube video.`,
        );
      }
      if (claim.status === 'in_progress') {
        throw conflict(
          `An upload for this video is already in progress (started ${claim.since}). Wait for it to finish instead of retrying.`,
        );
      }
      if (claim.status === 'quota_exhausted') {
        throw tooManyRequests(
          `YouTube upload quota guard reached (${claim.used}/${claim.limit} uploads in the last 24h). Try again after the quota resets.`,
        );
      }
      reservedAt = claim.reservedAt;

      const result = await uploadToYouTube({
        filePath: video.video_path,
        title: video.seo_title,
        description: video.seo_description ?? '',
        tags: video.seo_tags ?? [],
        privacyStatus,
        thumbnailPath: video.thumbnail_path,
        // Written by the render from the same cues as the burned captions.
        subtitlePath: path.join(paths.videos, `${videoId}.srt`),
        quotaClaimed: true,
      });
      uploaded = true;

      const updated = await store.updateVideo(videoId, {
        youtube_video_id: result.youtubeVideoId,
        privacy_status: result.privacyStatus,
        status: 'uploaded',
        uploaded_at: new Date().toISOString(),
        error: null,
      });

      const disclosure = result.syntheticMediaDisclosed
        ? 'Altered/synthetic media disclosed to YouTube.'
        : 'WARNING: YT_DISCLOSE_SYNTHETIC_MEDIA is off, so no altered/synthetic disclosure was sent.';

      await logStep(
        videoId,
        'upload',
        'success',
        `Uploaded as ${result.privacyStatus}: ${result.url}${result.thumbnailApplied ? ' (thumbnail set)' : ''}` +
          `${result.captionsUploaded ? ' (caption track uploaded)' : ''}. ${disclosure}`,
      );

      return {
        youtubeVideoId: result.youtubeVideoId,
        privacyStatus: result.privacyStatus,
        url: result.url,
        thumbnailApplied: result.thumbnailApplied,
        captionsUploaded: result.captionsUploaded,
        syntheticMediaDisclosure: result.syntheticMediaDisclosed,
        video: serializeVideo(updated),
        approvalRequired: true,
      };
    } catch (error) {
      // Give the quota slot back only when no YouTube video was created: a failed insert must not
      // burn one of the day's uploads, and a successful one must never be forgotten.
      if (reservedAt && !uploaded) {
        await store
          .releaseUploadSlot(videoId, reservedAt)
          .catch((releaseError: unknown) =>
            logger.warn(`Could not release the upload quota slot for ${videoId}: ${errorMessage(releaseError)}`),
          );
      }
      throw error;
    } finally {
      uploadsInFlight.delete(videoId);
    }
  });

  app.post('/api/youtube/publish/:videoId', async (request) => {
    const { videoId } = request.params as { videoId: string };
    const confirmed = optionalBoolean(request.body, 'confirm');
    const privacyStatus =
      optionalEnum<'public' | 'unlisted'>(request.body, 'privacyStatus', ['public', 'unlisted']) ?? 'public';

    if (confirmed !== true) throw badRequest('Set "confirm": true to publish.');

    const store = getStore();
    const video = await store.getVideo(videoId);
    if (!video) throw notFound(`Video ${videoId} not found.`);
    if (!video.youtube_video_id) throw badRequest('Upload the video before publishing it.');
    if (!video.approved_at) {
      throw forbidden('A human must approve this video before it can be published.');
    }
    if (!config.ytAuditPassed) {
      throw forbidden(
        'The YouTube compliance audit has not been passed. Keep uploads private or unlisted and set YT_AUDIT_PASSED=true only after Google approves the app.',
      );
    }

    await setVideoPrivacy(video.youtube_video_id, privacyStatus);
    const updated = await store.updateVideo(videoId, {
      privacy_status: privacyStatus,
      status: privacyStatus === 'public' ? 'published' : 'uploaded',
    });

    await logStep(videoId, 'publish', 'success', `Privacy set to ${privacyStatus}.`);
    return { privacyStatus, video: serializeVideo(updated) };
  });
}
