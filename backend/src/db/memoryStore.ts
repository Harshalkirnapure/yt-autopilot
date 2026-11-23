import { randomUUID } from 'node:crypto';
import { notFound } from '../utils/errors.js';
import { applyApprovalRule } from './approval.js';
import type {
  CreateVideoInput,
  FinishPipelineRunPatch,
  JobPatch,
  JobRow,
  LogRow,
  PipelineRunRow,
  SaveTokensInput,
  StartPipelineRunInput,
  Store,
  TokenRow,
  UploadClaim,
  UploadClaimOptions,
  VideoPatch,
  VideoRow,
} from './types.js';
import { UPLOAD_CLAIM_TIMEOUT_MS } from './types.js';

const MAX_LOGS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const now = (): string => new Date().toISOString();

/**
 * Ephemeral store used when DATABASE_URL is absent (local UI work, demos).
 * The spec's production path is PostgreSQL; this keeps the API usable without Docker.
 */
export class MemoryStore implements Store {
  readonly mode = 'memory' as const;

  private readonly videos = new Map<string, VideoRow>();
  private readonly jobs = new Map<string, JobRow>();
  private readonly logs: LogRow[] = [];
  private readonly usedTopics: Array<{ topic: string; usedAt: string }> = [];
  private readonly usedClips = new Set<string>();
  private readonly pipelineRuns: PipelineRunRow[] = [];
  private pipelineLocked = false;
  private tokens: TokenRow | null = null;

  async createVideo(input: CreateVideoInput): Promise<VideoRow> {
    const timestamp = now();
    const row: VideoRow = {
      id: randomUUID(),
      topic: input.topic,
      niche: input.niche ?? null,
      audience: input.audience ?? null,
      language: input.language ?? null,
      script: null,
      audio_path: null,
      audio_duration: null,
      video_path: null,
      caption_path: null,
      thumbnail_path: null,
      captions_uploaded: null,
      caption_error: null,
      seo_title: null,
      seo_description: null,
      seo_tags: null,
      youtube_video_id: null,
      privacy_status: null,
      status: 'draft',
      error: null,
      uploaded_at: null,
      approved_at: null,
      approved_by: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.videos.set(row.id, row);
    return { ...row };
  }

  async getVideo(id: string): Promise<VideoRow | null> {
    const row = this.videos.get(id);
    return row ? { ...row } : null;
  }

  async updateVideo(id: string, patch: VideoPatch): Promise<VideoRow> {
    const existing = this.videos.get(id);
    if (!existing) throw notFound(`Video ${id} not found.`);
    const updated: VideoRow = { ...existing };
    // Any edit to approved content clears approved_at (see ./approval.ts).
    for (const [key, value] of Object.entries(applyApprovalRule(patch))) {
      if (value === undefined) continue;
      (updated as unknown as Record<string, unknown>)[key] = value;
    }
    updated.updated_at = now();
    this.videos.set(id, updated);
    return { ...updated };
  }

  async listVideos(limit = 20): Promise<VideoRow[]> {
    return [...this.videos.values()]
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async recentTopics(limit = 40): Promise<string[]> {
    const fromVideos = [...this.videos.values()].map((row) => ({ topic: row.topic, usedAt: row.created_at }));
    return [...fromVideos, ...this.usedTopics]
      .sort((a, b) => Date.parse(b.usedAt) - Date.parse(a.usedAt))
      .slice(0, limit)
      .map((entry) => entry.topic);
  }

  async addUsedTopic(topic: string, _niche?: string | null, _videoId?: string | null): Promise<void> {
    const normalised = topic.trim().toLowerCase();
    if (!normalised) return;
    if (this.usedTopics.some((entry) => entry.topic.trim().toLowerCase() === normalised)) return;
    this.usedTopics.push({ topic: topic.trim(), usedAt: now() });
  }

  async isClipUsed(pexelsVideoId: string): Promise<boolean> {
    return this.usedClips.has(pexelsVideoId);
  }

  async markClipUsed(pexelsVideoId: string, _videoId: string): Promise<void> {
    this.usedClips.add(pexelsVideoId);
  }

  async countUsedClips(): Promise<number> {
    return this.usedClips.size;
  }

  async saveTokens(tokens: SaveTokensInput): Promise<void> {
    this.tokens = {
      id: '00000000-0000-0000-0000-000000000001',
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken ?? this.tokens?.refresh_token ?? null,
      expiry_date: tokens.expiryDate ?? null,
      channel_id: tokens.channelId ?? this.tokens?.channel_id ?? null,
      updated_at: now(),
    };
  }

  async getTokens(): Promise<TokenRow | null> {
    return this.tokens ? { ...this.tokens } : null;
  }

  async createJob(videoId: string, stage = 'queued'): Promise<JobRow> {
    const timestamp = now();
    const row: JobRow = {
      id: randomUUID(),
      video_id: videoId,
      status: 'queued',
      progress: 0,
      stage,
      error: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.jobs.set(row.id, row);
    return { ...row };
  }

  async getJob(id: string): Promise<JobRow | null> {
    const row = this.jobs.get(id);
    return row ? { ...row } : null;
  }

  async updateJob(id: string, patch: JobPatch): Promise<JobRow> {
    const existing = this.jobs.get(id);
    if (!existing) throw notFound(`Job ${id} not found.`);
    const updated: JobRow = { ...existing, ...patch, updated_at: now() };
    this.jobs.set(id, updated);
    return { ...updated };
  }

  async listJobs(videoId: string, limit = 1): Promise<JobRow[]> {
    return [...this.jobs.values()]
      .filter((job) => job.video_id === videoId)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, limit)
      .map((job) => ({ ...job }));
  }

  async listUnfinishedJobs(cutoff: string, limit = 100): Promise<JobRow[]> {
    const cutoffMs = Date.parse(cutoff);
    return [...this.jobs.values()]
      .filter(
        (job) =>
          (job.status === 'queued' || job.status === 'active') && Date.parse(job.updated_at) < cutoffMs,
      )
      .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
      .slice(0, limit)
      .map((job) => ({ ...job }));
  }

  async log(videoId: string | null, step: string, status: string, message: string): Promise<void> {
    this.logs.push({
      id: randomUUID(),
      video_id: videoId,
      step,
      status,
      message: message.slice(0, 4000),
      created_at: now(),
    });
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
  }

  async listLogs(videoId: string | null, limit = 30): Promise<LogRow[]> {
    return this.logs
      .filter((row) => row.video_id === videoId)
      .slice(-limit)
      .reverse()
      .map((row) => ({ ...row }));
  }

  async countUploadsToday(): Promise<number> {
    const cutoff = Date.now() - DAY_MS;
    // `uploaded_at` is stamped when a slot is reserved, so in-flight uploads count too: otherwise
    // two concurrent uploads would both see a free slot.
    return [...this.videos.values()].filter(
      (row) => row.uploaded_at !== null && Date.parse(row.uploaded_at) >= cutoff,
    ).length;
  }

  async startPipelineRun(input: StartPipelineRunInput): Promise<PipelineRunRow> {
    const row: PipelineRunRow = {
      id: randomUUID(),
      trigger: input.trigger,
      status: 'running',
      niche: input.niche ?? null,
      audience: input.audience ?? null,
      video_id: null,
      job_id: null,
      reason: null,
      error: null,
      started_at: now(),
      finished_at: null,
    };
    this.pipelineRuns.push(row);
    return { ...row };
  }

  async finishPipelineRun(id: string, patch: FinishPipelineRunPatch): Promise<PipelineRunRow> {
    const index = this.pipelineRuns.findIndex((row) => row.id === id);
    const existing = index === -1 ? undefined : this.pipelineRuns[index];
    if (!existing) throw notFound(`Pipeline run ${id} not found.`);

    const updated: PipelineRunRow = {
      ...existing,
      status: patch.status,
      video_id: patch.videoId ?? existing.video_id,
      job_id: patch.jobId ?? existing.job_id,
      reason: patch.reason ?? existing.reason,
      error: patch.error ?? existing.error,
      finished_at: now(),
    };
    this.pipelineRuns[index] = updated;
    return { ...updated };
  }

  async latestPipelineRun(): Promise<PipelineRunRow | null> {
    const newest = [...this.pipelineRuns].sort(
      (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at),
    )[0];
    return newest ? { ...newest } : null;
  }

  async latestCompletedPipelineRun(): Promise<PipelineRunRow | null> {
    const newest = this.pipelineRuns
      .filter((row) => row.status === 'completed' && row.finished_at !== null)
      .sort((a, b) => Date.parse(b.finished_at!) - Date.parse(a.finished_at!))[0];
    return newest ? { ...newest } : null;
  }

  async listStalePipelineRuns(cutoff: string, limit = 100): Promise<PipelineRunRow[]> {
    const cutoffMs = Date.parse(cutoff);
    return this.pipelineRuns
      .filter((row) => row.status === 'running' && Date.parse(row.started_at) < cutoffMs)
      .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async acquirePipelineLock(): Promise<(() => Promise<void>) | null> {
    if (this.pipelineLocked) return null;
    this.pipelineLocked = true;
    return async () => {
      this.pipelineLocked = false;
    };
  }

  async captionFailureStreak(): Promise<number> {
    const uploaded = [...this.videos.values()]
      .filter((row) => row.uploaded_at !== null && row.captions_uploaded !== null)
      .sort((a, b) => Date.parse(b.uploaded_at ?? '') - Date.parse(a.uploaded_at ?? ''));

    let streak = 0;
    for (const row of uploaded) {
      if (row.captions_uploaded) break;
      streak += 1;
    }
    return streak;
  }

  async listStaleUploadReservations(cutoff: string, limit = 100): Promise<VideoRow[]> {
    const cutoffMs = Date.parse(cutoff);
    return [...this.videos.values()]
      .filter(
        (row) =>
          row.uploaded_at !== null &&
          row.youtube_video_id === null &&
          Date.parse(row.uploaded_at) < cutoffMs,
      )
      .sort((a, b) => Date.parse(a.uploaded_at!) - Date.parse(b.uploaded_at!))
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async claimUploadSlot(videoId: string, options: UploadClaimOptions): Promise<UploadClaim> {
    const { limit, replace = false } = options;
    const now = options.now ?? new Date();

    // Everything below runs without an await, so it is atomic with respect to other claims in
    // this single-threaded store.
    const existing = this.videos.get(videoId);
    if (!existing) throw notFound(`Video ${videoId} not found.`);

    if (existing.youtube_video_id && !replace) {
      return { status: 'already_uploaded', youtubeVideoId: existing.youtube_video_id };
    }

    if (
      !existing.youtube_video_id &&
      existing.uploaded_at !== null &&
      now.getTime() - Date.parse(existing.uploaded_at) < UPLOAD_CLAIM_TIMEOUT_MS
    ) {
      return { status: 'in_progress', since: existing.uploaded_at };
    }

    const windowStart = now.getTime() - DAY_MS;
    const used = [...this.videos.values()].filter(
      (row) => row.id !== videoId && row.uploaded_at !== null && Date.parse(row.uploaded_at) >= windowStart,
    ).length;
    if (used >= limit) return { status: 'quota_exhausted', used, limit };

    const reservedAt = now.toISOString();
    const updated: VideoRow = { ...existing, uploaded_at: reservedAt, updated_at: reservedAt };
    this.videos.set(videoId, updated);
    return { status: 'claimed', video: { ...updated }, reservedAt };
  }

  async releaseUploadSlot(videoId: string, reservedAt: string): Promise<void> {
    const existing = this.videos.get(videoId);
    if (!existing) return;
    // Only the reservation we made may be released: never a successful upload, never a newer one.
    if (existing.youtube_video_id !== null || existing.uploaded_at !== reservedAt) return;
    this.videos.set(videoId, { ...existing, uploaded_at: null, updated_at: now() });
  }
}
