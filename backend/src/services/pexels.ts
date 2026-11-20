import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, paths } from '../config.js';
import { AppError, unavailable, upstreamError } from '../utils/errors.js';
import { withRetry } from '../utils/retry.js';

export interface PexelsVideoFile {
  id: number;
  quality: string;
  file_type: string;
  width: number | null;
  height: number | null;
  link: string;
  fps?: number | null;
}

export interface PexelsVideo {
  id: number;
  duration: number;
  video_files: PexelsVideoFile[];
}

interface SearchPayload {
  videos?: PexelsVideo[];
}

const CACHE_TTL_MS = 10 * 60 * 1000;
/** Cached clips must be at least this large; smaller files are treated as truncated downloads. */
const MIN_CLIP_BYTES = 200_000;
const cache = new Map<string, { expiresAt: number; videos: PexelsVideo[] }>();

function scoreFile(file: PexelsVideoFile): number {
  const width = file.width ?? 0;
  const height = file.height ?? 0;
  let score = 0;
  if (width >= 1920) score += 20 - Math.abs(width - 1920) / 100;
  else if (width >= 1280) score += 10;
  if (height > 1080) score -= (height - 1080) / 10;
  if (height >= 720) score += 4;
  if (file.quality === 'hd') score += 5;
  return score;
}

export function pickBestFile(video: PexelsVideo): PexelsVideoFile | null {
  const files = (video.video_files ?? []).filter(
    (file) => file && file.file_type === 'video/mp4' && typeof file.link === 'string' && (file.width ?? 0) > 0,
  );
  if (files.length === 0) return null;
  return [...files].sort((a, b) => scoreFile(b) - scoreFile(a))[0] ?? null;
}

export async function searchPexelsVideos(query: string, perPage = 10): Promise<PexelsVideo[]> {
  if (!config.pexelsApiKey) {
    throw unavailable('PEXELS_API_KEY is not configured. Add a free Pexels API key to backend/.env.');
  }

  const trimmed = query.trim() || 'abstract background';
  const cacheKey = `${trimmed.toLowerCase()}|${perPage}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.videos;

  const url = new URL('https://api.pexels.com/videos/search');
  url.searchParams.set('query', trimmed);
  url.searchParams.set('per_page', String(Math.min(Math.max(perPage, 3), 20)));
  url.searchParams.set('orientation', 'landscape');
  url.searchParams.set('size', 'medium');

  // The HTTP check lives inside the retry so 429/5xx responses are retried too; fetch itself
  // only rejects on transport failures.
  const payload = await withRetry<SearchPayload>(
    async () => {
      const response = await fetch(url, {
        headers: { Authorization: config.pexelsApiKey },
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new AppError(
          response.status === 401 ? 401 : 502,
          `Pexels search failed (${response.status}). ${detail}`,
          { retryable: response.status === 429 || response.status >= 500 },
        );
      }
      return (await response.json()) as SearchPayload;
    },
    { attempts: 3, baseDelayMs: 700, label: `Pexels search "${trimmed}"` },
  );

  const videos = (payload.videos ?? []).filter(
    (video) => video && typeof video.id === 'number' && video.duration >= 3 && pickBestFile(video) !== null,
  );

  cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, videos });
  return videos;
}

export async function downloadClip(video: PexelsVideo): Promise<string> {
  const file = pickBestFile(video);
  if (!file) throw upstreamError(`Pexels clip ${video.id} has no downloadable MP4 file.`);

  const target = path.join(paths.clips, `${video.id}.mp4`);
  const cached = await fsp.stat(target).catch(() => null);
  if (cached && cached.size >= MIN_CLIP_BYTES) return target;
  if (cached) await fsp.rm(target, { force: true });

  const buffer = await withRetry(
    async () => {
      const response = await fetch(file.link);
      if (!response.ok) {
        throw new AppError(502, `Pexels clip download failed (${response.status}).`, {
          retryable: response.status >= 500 || response.status === 429,
        });
      }
      const data = Buffer.from(await response.arrayBuffer());
      if (data.byteLength < MIN_CLIP_BYTES) {
        throw new AppError(502, 'Pexels returned an incomplete clip.', { retryable: true });
      }
      return data;
    },
    { attempts: 3, baseDelayMs: 1000, label: `Pexels download ${video.id}` },
  );

  const tempTarget = `${target}.part`;
  await fsp.writeFile(tempTarget, buffer);
  await fsp.rename(tempTarget, target);
  return target;
}
