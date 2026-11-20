import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { youtube_v3 } from 'googleapis';
import { config } from '../config.js';
import { getStore } from '../db/index.js';
import { badRequest, unauthorized, unavailable, upstreamError } from '../utils/errors.js';
import { errorMessage, logger } from '../utils/logger.js';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
];

export type UploadPrivacy = 'private' | 'unlisted';

/**
 * `status` payload for `videos.insert` and `videos.update`.
 *
 * `containsSyntheticMedia` is YouTube's documented disclosure flag for realistic Altered or
 * Synthetic (A/S) content — settable on both `videos.insert` and `videos.update` (YouTube Data API
 * v3, videos resource → `status.containsSyntheticMedia`). AI narration over assembled stock footage
 * is exactly that, so it is set from `YT_DISCLOSE_SYNTHETIC_MEDIA` (default `true`).
 *
 * The installed `googleapis` typings predate the field, hence the cast where this is passed on.
 */
export interface VideoStatusPayload {
  privacyStatus: UploadPrivacy | 'public';
  selfDeclaredMadeForKids: boolean;
  containsSyntheticMedia: boolean;
  embeddable?: boolean;
}

export function videoStatusPayload(
  privacyStatus: VideoStatusPayload['privacyStatus'],
  options: { embeddable?: boolean } = {},
): VideoStatusPayload {
  return {
    privacyStatus,
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: config.ytDiscloseSyntheticMedia,
    ...(options.embeddable === undefined ? {} : { embeddable: options.embeddable }),
  };
}

export function youtubeConfigured(): boolean {
  return Boolean(config.ytClientId && config.ytClientSecret);
}

// googleapis is a very large module (~10s cold import). Load it on first YouTube
// operation so the API and render worker start immediately.
type GoogleApis = typeof import('googleapis');
let googleModule: GoogleApis | null = null;

async function loadGoogle(): Promise<GoogleApis> {
  if (!googleModule) googleModule = await import('googleapis');
  return googleModule;
}

async function createOAuthClient() {
  if (!youtubeConfigured()) {
    throw unavailable(
      'YouTube OAuth is not configured. Set YT_CLIENT_ID, YT_CLIENT_SECRET and YT_REDIRECT_URI in backend/.env.',
    );
  }
  const { google } = await loadGoogle();
  return new google.auth.OAuth2(config.ytClientId, config.ytClientSecret, config.ytRedirectUri);
}

export async function buildAuthUrl(): Promise<string> {
  const client = await createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: SCOPES,
  });
}

export async function handleOAuthCallback(code: string): Promise<{ channelId: string | null }> {
  const client = await createOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  let channelId: string | null = null;
  try {
    const { google } = await loadGoogle();
    const youtube = google.youtube({ version: 'v3', auth: client });
    const response = await youtube.channels.list({ part: ['id'], mine: true });
    channelId = response.data.items?.[0]?.id ?? null;
  } catch (error) {
    logger.warn(`Could not read the YouTube channel id: ${errorMessage(error)}`);
  }

  if (!tokens.access_token) throw upstreamError('Google did not return an access token.');

  await getStore().saveTokens({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    channelId,
  });

  if (!tokens.refresh_token) {
    logger.warn(
      'Google did not return a refresh token. Remove the app from your Google account permissions and connect again.',
    );
  }

  return { channelId };
}

export async function getAuthorizedClient() {
  const tokens = await getStore().getTokens();
  if (!tokens || (!tokens.access_token && !tokens.refresh_token)) {
    throw unauthorized('The YouTube channel is not connected. Open /api/youtube/auth first.');
  }

  const client = await createOAuthClient();
  client.setCredentials({
    access_token: tokens.access_token ?? undefined,
    refresh_token: tokens.refresh_token ?? undefined,
    expiry_date: tokens.expiry_date ? Date.parse(tokens.expiry_date) : undefined,
  });

  client.on('tokens', (fresh) => {
    void getStore()
      .saveTokens({
        accessToken: fresh.access_token ?? tokens.access_token ?? '',
        refreshToken: fresh.refresh_token ?? tokens.refresh_token,
        expiryDate: fresh.expiry_date ? new Date(fresh.expiry_date).toISOString() : tokens.expiry_date,
        channelId: tokens.channel_id,
      })
      .catch((error: unknown) => logger.warn(`Could not persist refreshed tokens: ${errorMessage(error)}`));
  });

  try {
    const accessToken = await client.getAccessToken();
    if (!accessToken.token) throw new Error('Google returned an empty access token.');
  } catch (error) {
    throw unauthorized(
      `YouTube authorization expired and could not be refreshed. Reconnect the channel at /api/youtube/auth. (${errorMessage(error)})`,
    );
  }

  return client;
}

/** The daily cap the upload route reserves against. */
export function uploadLimit(): number {
  return Math.min(config.maxUploadsPerDay, config.maxUploadsPerDayHardLimit);
}

export async function uploadQuota(): Promise<{ used: number; limit: number; remaining: number }> {
  const used = await getStore().countUploadsToday();
  const limit = uploadLimit();
  return { used, limit, remaining: Math.max(0, limit - used) };
}

export interface UploadInput {
  filePath: string;
  title: string;
  description: string;
  tags: string[];
  privacyStatus: UploadPrivacy;
  thumbnailPath?: string | null;
  /**
   * The caller already reserved a quota slot atomically (POST /api/upload does), so this function
   * must not re-check the count: the reservation itself is counted and would look exhausted.
   */
  quotaClaimed?: boolean;
}

export interface UploadResult {
  youtubeVideoId: string;
  url: string;
  privacyStatus: UploadPrivacy;
  thumbnailApplied: boolean;
  /** Whether the upload told YouTube it contains altered/synthetic media. */
  syntheticMediaDisclosed: boolean;
}

export async function uploadToYouTube(input: UploadInput): Promise<UploadResult> {
  if (!fs.existsSync(input.filePath)) {
    throw badRequest('The rendered MP4 is missing from disk. Render the video again before uploading.');
  }

  if (!input.quotaClaimed) {
    const quota = await uploadQuota();
    if (quota.remaining <= 0) {
      throw upstreamError(
        `YouTube upload quota guard reached (${quota.used}/${quota.limit} uploads in the last 24h). Try again after the quota resets.`,
      );
    }
  }

  const auth = await getAuthorizedClient();
  const { google } = await loadGoogle();
  const youtube = google.youtube({ version: 'v3', auth });

  // The read stream must be released even when videos.insert rejects, otherwise a failed
  // upload keeps the MP4 open (and locked on Windows) for the life of the process.
  const media = fs.createReadStream(input.filePath);
  let youtubeVideoId: string | null = null;
  try {
    const response = await youtube.videos.insert(
      {
        part: ['snippet', 'status'],
        requestBody: {
          snippet: {
            title: input.title.slice(0, 100),
            description: input.description.slice(0, 5000),
            tags: input.tags.slice(0, 15).map((tag) => tag.slice(0, 30)),
            categoryId: config.ytCategoryId,
          },
          status: videoStatusPayload(input.privacyStatus, {
            embeddable: true,
          }) as unknown as youtube_v3.Schema$VideoStatus,
        },
        media: { body: media },
      },
      { timeout: 20 * 60 * 1000 },
    );
    youtubeVideoId = response.data.id ?? null;
  } finally {
    media.destroy();
  }

  if (!youtubeVideoId) throw upstreamError('YouTube accepted the upload but returned no video id.');

  let thumbnailApplied = false;
  if (input.thumbnailPath) {
    try {
      const stats = await fsp.stat(input.thumbnailPath);
      if (stats.size > 2 * 1024 * 1024) {
        logger.warn('Thumbnail exceeds YouTube\'s 2 MB limit; uploading the video without a custom thumbnail.');
      } else {
        await youtube.thumbnails.set({
          videoId: youtubeVideoId,
          media: { body: fs.createReadStream(input.thumbnailPath) },
        });
        thumbnailApplied = true;
      }
    } catch (error) {
      logger.warn(`Video uploaded but the thumbnail was rejected: ${errorMessage(error)}`);
    }
  }

  return {
    youtubeVideoId,
    url: `https://youtu.be/${youtubeVideoId}`,
    privacyStatus: input.privacyStatus,
    thumbnailApplied,
    syntheticMediaDisclosed: config.ytDiscloseSyntheticMedia,
  };
}

export async function setVideoPrivacy(
  youtubeVideoId: string,
  privacyStatus: 'public' | 'unlisted',
): Promise<void> {
  const auth = await getAuthorizedClient();
  const { google } = await loadGoogle();
  const youtube = google.youtube({ version: 'v3', auth });
  await youtube.videos.update({
    part: ['status'],
    requestBody: {
      id: youtubeVideoId,
      // `containsSyntheticMedia` is exempt from the "unspecified status fields are cleared" rule
      // on update, but sending it keeps the disclosure explicit on every status write.
      status: videoStatusPayload(privacyStatus) as unknown as youtube_v3.Schema$VideoStatus,
    },
  });
}
