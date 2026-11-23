export type VideoStatus = 'draft' | 'rendered' | 'uploaded' | 'published' | 'failed';
export type JobStatus = 'queued' | 'active' | 'completed' | 'failed';
export type LogStatus = 'success' | 'failed' | 'info' | 'warning';

export type VideoRow = {
  id: string;
  topic: string;
  niche: string | null;
  audience: string | null;
  language: string | null;
  script: string | null;
  audio_path: string | null;
  audio_duration: number | null;
  video_path: string | null;
  caption_path: string | null;
  thumbnail_path: string | null;
  /** Caption track on the uploaded YouTube video: null = never attempted, false = rejected. */
  captions_uploaded: boolean | null;
  /** YouTube's rejection reason when the track failed; null when it uploaded or was never tried. */
  caption_error: string | null;
  seo_title: string | null;
  seo_description: string | null;
  seo_tags: string[] | null;
  youtube_video_id: string | null;
  privacy_status: string | null;
  status: VideoStatus;
  error: string | null;
  uploaded_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Fields listed in `APPROVED_CONTENT_FIELDS` (./approval.ts) clear `approved_at` in the same
 * write, so no caller can edit reviewed content and keep its approval. Setting `approved_at`
 * explicitly always wins.
 */
export interface VideoPatch {
  topic?: string;
  niche?: string | null;
  audience?: string | null;
  language?: string | null;
  script?: string | null;
  audio_path?: string | null;
  audio_duration?: number | null;
  video_path?: string | null;
  caption_path?: string | null;
  thumbnail_path?: string | null;
  captions_uploaded?: boolean | null;
  caption_error?: string | null;
  seo_title?: string | null;
  seo_description?: string | null;
  seo_tags?: string[] | null;
  youtube_video_id?: string | null;
  privacy_status?: string | null;
  status?: VideoStatus;
  error?: string | null;
  uploaded_at?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
}

export interface CreateVideoInput {
  topic: string;
  niche?: string | null;
  audience?: string | null;
  language?: string | null;
}

export type JobRow = {
  id: string;
  video_id: string;
  status: JobStatus;
  progress: number;
  stage: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobPatch {
  status?: JobStatus;
  progress?: number;
  stage?: string | null;
  error?: string | null;
}

export type LogRow = {
  id: string;
  video_id: string | null;
  step: string | null;
  status: string | null;
  message: string | null;
  created_at: string;
}

export type PipelineRunStatus = 'running' | 'completed' | 'skipped' | 'failed';

/** One row per attempted daily pipeline run, so "did today run?" is a query, not a guess. */
export type PipelineRunRow = {
  id: string;
  trigger: string;
  status: PipelineRunStatus;
  niche: string | null;
  audience: string | null;
  video_id: string | null;
  job_id: string | null;
  reason: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

export interface StartPipelineRunInput {
  trigger: string;
  niche?: string | null;
  audience?: string | null;
}

export interface FinishPipelineRunPatch {
  status: Exclude<PipelineRunStatus, 'running'>;
  videoId?: string | null;
  jobId?: string | null;
  reason?: string | null;
  error?: string | null;
}

export type TokenRow = {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
  expiry_date: string | null;
  channel_id: string | null;
  updated_at: string;
}

/**
 * How long a quota reservation counts as "upload in progress". A reservation older than this is
 * treated as abandoned (the process died mid-upload) so a retry is allowed again.
 */
export const UPLOAD_CLAIM_TIMEOUT_MS = 30 * 60 * 1000;

export interface UploadClaimOptions {
  /** Daily upload cap (the `MAX_UPLOADS_PER_DAY` guard). */
  limit: number;
  /** Deliberate re-upload of a video that already has a YouTube id. */
  replace?: boolean;
  /** Override the clock (tests). */
  now?: Date;
}

/**
 * Outcome of an atomic "can I spend a quota slot for this video?" reservation.
 * `claimed` also stamps `uploaded_at`, which is what the quota counts, so the slot cannot be
 * handed out twice even by concurrent requests.
 */
export type UploadClaim =
  | { status: 'claimed'; video: VideoRow; reservedAt: string }
  | { status: 'quota_exhausted'; used: number; limit: number }
  | { status: 'in_progress'; since: string }
  | { status: 'already_uploaded'; youtubeVideoId: string };

export interface SaveTokensInput {
  accessToken: string;
  refreshToken?: string | null;
  expiryDate?: string | null;
  channelId?: string | null;
}

export interface Store {
  readonly mode: 'postgres' | 'memory';

  createVideo(input: CreateVideoInput): Promise<VideoRow>;
  getVideo(id: string): Promise<VideoRow | null>;
  updateVideo(id: string, patch: VideoPatch): Promise<VideoRow>;
  listVideos(limit?: number): Promise<VideoRow[]>;

  recentTopics(limit?: number): Promise<string[]>;
  addUsedTopic(topic: string, niche?: string | null, videoId?: string | null): Promise<void>;

  isClipUsed(pexelsVideoId: string): Promise<boolean>;
  markClipUsed(pexelsVideoId: string, videoId: string): Promise<void>;
  countUsedClips(): Promise<number>;

  saveTokens(tokens: SaveTokensInput): Promise<void>;
  getTokens(): Promise<TokenRow | null>;

  createJob(videoId: string, stage?: string): Promise<JobRow>;
  getJob(id: string): Promise<JobRow | null>;
  updateJob(id: string, patch: JobPatch): Promise<JobRow>;
  listJobs(videoId: string, limit?: number): Promise<JobRow[]>;
  /** Jobs still `queued`/`active` whose last heartbeat (`updated_at`) is older than `cutoff` (ISO). */
  listUnfinishedJobs(cutoff: string, limit?: number): Promise<JobRow[]>;

  log(videoId: string | null, step: string, status: LogStatus | string, message: string): Promise<void>;
  listLogs(videoId: string | null, limit?: number): Promise<LogRow[]>;

  countUploadsToday(): Promise<number>;

  /**
   * How many of the newest uploads in a row lack a caption track. Rows written before the caption
   * outcome was recorded (NULL) are skipped, and the streak stops at the first uploaded video whose
   * track was accepted.
   */
  captionFailureStreak(): Promise<number>;

  /** Videos whose `uploaded_at` is an abandoned quota reservation (no YouTube id), older than `cutoff`. */
  listStaleUploadReservations(cutoff: string, limit?: number): Promise<VideoRow[]>;

  startPipelineRun(input: StartPipelineRunInput): Promise<PipelineRunRow>;
  finishPipelineRun(id: string, patch: FinishPipelineRunPatch): Promise<PipelineRunRow>;
  /** Newest run by `started_at`, whatever its status. */
  latestPipelineRun(): Promise<PipelineRunRow | null>;
  /** Newest run that finished as `completed` by `finished_at`: the last video actually produced. */
  latestCompletedPipelineRun(): Promise<PipelineRunRow | null>;
  /** Rows still `running` whose `started_at` is older than `cutoff` (ISO): the process died. */
  listStalePipelineRuns(cutoff: string, limit?: number): Promise<PipelineRunRow[]>;
  /**
   * Serialises daily runs. Resolves to a release function, or `null` when another run (in this or
   * any other process) already holds the lock.
   */
  acquirePipelineLock(): Promise<(() => Promise<void>) | null>;

  /** Atomic quota reservation: check quota, duplicate and in-flight state in one store operation. */
  claimUploadSlot(videoId: string, options: UploadClaimOptions): Promise<UploadClaim>;
  /** Undo a claim after a failed upload. Only clears the reservation it created. */
  releaseUploadSlot(videoId: string, reservedAt: string): Promise<void>;
}
