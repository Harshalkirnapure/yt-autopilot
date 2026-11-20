import path from 'node:path';
import { paths } from '../config.js';
import type { VideoRow } from '../db/types.js';

export function publicUploadUrl(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const relative = path.relative(paths.uploads, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return `/uploads/${relative.split(path.sep).join('/')}`;
}

export function serializeVideo(video: VideoRow) {
  return {
    ...video,
    audio_url: publicUploadUrl(video.audio_path),
    video_url: publicUploadUrl(video.video_path),
    thumbnail_url: publicUploadUrl(video.thumbnail_path),
    caption_url: publicUploadUrl(video.caption_path),
    youtube_url: video.youtube_video_id ? `https://youtu.be/${video.youtube_video_id}` : null,
  };
}

export type SerializedVideo = ReturnType<typeof serializeVideo>;
