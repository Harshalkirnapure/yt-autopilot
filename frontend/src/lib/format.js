export function wordCount(text) {
  return String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export function shortId(id) {
  return id ? String(id).slice(0, 8) : '—';
}

export function dateTime(value) {
  return value ? new Date(value).toLocaleString() : '';
}

export function clockTime(value) {
  return new Date(value).toLocaleTimeString();
}

export function assetBadges(video) {
  if (!video) return [];
  return [
    { label: 'Script', on: Boolean(video.script) },
    { label: 'Audio', on: Boolean(video.audio_path) },
    { label: 'Video', on: Boolean(video.video_path) },
    { label: 'Thumb', on: Boolean(video.thumbnail_path) },
    { label: 'SEO', on: Boolean(video.seo_title) },
    { label: 'YT', on: Boolean(video.youtube_video_id) },
  ];
}

/**
 * The caption track is best-effort, so a rejection does not fail the upload — which is why it has to
 * be shown here. A video with `captions_uploaded: false` is served with YouTube's auto-captions.
 */
export function captionInfo(video) {
  if (!video || !video.youtube_video_id) {
    return { warn: false, text: 'Caption track: will be sent with the upload.' };
  }
  if (video.captions_uploaded === true) {
    return {
      warn: false,
      text: 'Caption track: uploaded — YouTube serves the script transcript, not auto-captions.',
    };
  }
  if (video.captions_uploaded === false) {
    // The stored reason often ends with its own full stop; do not render a second one.
    const reason = (video.caption_error || 'YouTube rejected it without a message')
      .trim()
      .replace(/[.!?]+$/, '');
    return {
      warn: true,
      text: `Caption track: FAILED — ${reason}. YouTube serves auto-captions for this upload.`,
    };
  }
  return { warn: false, text: 'Caption track: no outcome recorded for this upload.' };
}
