import type { VideoPatch } from './types.js';

/**
 * Columns that change what a human actually reviewed: the spoken script, the rendered
 * artefacts, the on-screen thumbnail, the metadata YouTube publishes, and the YouTube
 * video itself. Any write to one of these invalidates an existing approval.
 *
 * Deliberately excluded: `status`, `error`, `privacy_status`, `uploaded_at`, `niche`,
 * `audience`, `language` — housekeeping and publishing bookkeeping that the reviewer
 * already signed off on.
 */
export const APPROVED_CONTENT_FIELDS = [
  'topic',
  'script',
  'audio_path',
  'audio_duration',
  'video_path',
  'caption_path',
  'thumbnail_path',
  'seo_title',
  'seo_description',
  'seo_tags',
  'youtube_video_id',
] as const;

/**
 * The single approval rule, enforced by every store's `updateVideo`.
 *
 * If a patch touches approved content, `approved_at` is cleared in the same write, so no
 * caller can edit a reviewed video and leave its approval standing. An explicit
 * `approved_at` in the patch (the approve route, or a deliberate override) always wins.
 */
export function applyApprovalRule(patch: VideoPatch): VideoPatch {
  if (patch.approved_at !== undefined) return patch;

  const touchesApprovedContent = APPROVED_CONTENT_FIELDS.some((field) => patch[field] !== undefined);
  if (!touchesApprovedContent) return patch;

  return {
    ...patch,
    approved_at: null,
    ...(patch.approved_by === undefined ? { approved_by: null } : {}),
  };
}
