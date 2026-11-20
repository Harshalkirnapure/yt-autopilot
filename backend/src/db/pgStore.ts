import type { Pool } from 'pg';
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

const DAY_MS = 24 * 60 * 60 * 1000;
/** Arbitrary but fixed key for the quota advisory lock (pg_advisory_xact_lock). */
const UPLOAD_QUOTA_LOCK = 742_019_331;
/** Session-level lock that serialises daily pipeline runs across processes. */
const PIPELINE_LOCK = 742_019_332;

/** `trigger` is a keyword in enough dialects; the column is `trigger_kind`. */
const PIPELINE_RUN_COLUMNS =
  'id, trigger_kind AS trigger, status, niche, audience, video_id, job_id, reason, error, started_at, finished_at';

const VIDEO_COLUMNS: Record<keyof VideoPatch, string> = {
  topic: 'topic',
  niche: 'niche',
  audience: 'audience',
  language: 'language',
  script: 'script',
  audio_path: 'audio_path',
  audio_duration: 'audio_duration',
  video_path: 'video_path',
  caption_path: 'caption_path',
  thumbnail_path: 'thumbnail_path',
  seo_title: 'seo_title',
  seo_description: 'seo_description',
  seo_tags: 'seo_tags',
  youtube_video_id: 'youtube_video_id',
  privacy_status: 'privacy_status',
  status: 'status',
  error: 'error',
  uploaded_at: 'uploaded_at',
  approved_at: 'approved_at',
  approved_by: 'approved_by',
};

const JOB_COLUMNS: Record<keyof JobPatch, string> = {
  status: 'status',
  progress: 'progress',
  stage: 'stage',
  error: 'error',
};

const TOKEN_ROW_ID = '00000000-0000-0000-0000-000000000001';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres rejects non-UUID text against a uuid column; answer "not found" instead of 500. */
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export class PgStore implements Store {
  readonly mode = 'postgres' as const;

  constructor(private readonly pool: Pool) {}

  async createVideo(input: CreateVideoInput): Promise<VideoRow> {
    const { rows } = await this.pool.query<VideoRow>(
      `INSERT INTO videos (topic, niche, audience, language, status)
       VALUES ($1, $2, $3, $4, 'draft')
       RETURNING *`,
      [input.topic, input.niche ?? null, input.audience ?? null, input.language ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('Failed to create video row.');
    return row;
  }

  async getVideo(id: string): Promise<VideoRow | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query<VideoRow>('SELECT * FROM videos WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async updateVideo(id: string, patch: VideoPatch): Promise<VideoRow> {
    if (!isUuid(id)) throw notFound(`Video ${id} not found.`);
    // Any edit to approved content clears approved_at (see ./approval.ts).
    const safePatch = applyApprovalRule(patch);
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const key of Object.keys(safePatch) as Array<keyof VideoPatch>) {
      const value = safePatch[key];
      if (value === undefined) continue;
      const column = VIDEO_COLUMNS[key];
      if (!column) continue;
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }

    if (sets.length === 0) {
      const existing = await this.getVideo(id);
      if (!existing) throw notFound(`Video ${id} not found.`);
      return existing;
    }

    values.push(id);
    const { rows } = await this.pool.query<VideoRow>(
      `UPDATE videos SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    const row = rows[0];
    if (!row) throw notFound(`Video ${id} not found.`);
    return row;
  }

  async listVideos(limit = 20): Promise<VideoRow[]> {
    const { rows } = await this.pool.query<VideoRow>(
      'SELECT * FROM videos ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return rows;
  }

  async recentTopics(limit = 40): Promise<string[]> {
    const { rows } = await this.pool.query<{ topic: string }>(
      `SELECT topic FROM (
         SELECT topic, created_at FROM videos
         UNION ALL
         SELECT topic, used_at AS created_at FROM used_topics
       ) combined
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => row.topic);
  }

  async addUsedTopic(topic: string, niche?: string | null, videoId?: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO used_topics (topic, niche, video_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (lower(topic)) DO NOTHING`,
      [topic, niche ?? null, videoId ?? null],
    );
  }

  async isClipUsed(pexelsVideoId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM used_clips WHERE pexels_video_id = $1', [
      pexelsVideoId,
    ]);
    return (rowCount ?? 0) > 0;
  }

  async markClipUsed(pexelsVideoId: string, videoId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO used_clips (pexels_video_id, used_in_video_id)
       VALUES ($1, $2)
       ON CONFLICT (pexels_video_id) DO NOTHING`,
      [pexelsVideoId, videoId],
    );
  }

  async countUsedClips(): Promise<number> {
    const { rows } = await this.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM used_clips');
    return rows[0]?.count ?? 0;
  }

  async saveTokens(tokens: SaveTokensInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_tokens (id, access_token, refresh_token, expiry_date, channel_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, oauth_tokens.refresh_token),
         expiry_date = EXCLUDED.expiry_date,
         channel_id = COALESCE(EXCLUDED.channel_id, oauth_tokens.channel_id),
         updated_at = now()`,
      [
        TOKEN_ROW_ID,
        tokens.accessToken,
        tokens.refreshToken ?? null,
        tokens.expiryDate ?? null,
        tokens.channelId ?? null,
      ],
    );
  }

  async getTokens(): Promise<TokenRow | null> {
    const { rows } = await this.pool.query<TokenRow>(
      'SELECT * FROM oauth_tokens ORDER BY updated_at DESC LIMIT 1',
    );
    return rows[0] ?? null;
  }

  async createJob(videoId: string, stage = 'queued'): Promise<JobRow> {
    const { rows } = await this.pool.query<JobRow>(
      `INSERT INTO render_jobs (video_id, status, progress, stage)
       VALUES ($1, 'queued', 0, $2)
       RETURNING *`,
      [videoId, stage],
    );
    const row = rows[0];
    if (!row) throw new Error('Failed to create render job.');
    return row;
  }

  async getJob(id: string): Promise<JobRow | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query<JobRow>('SELECT * FROM render_jobs WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async updateJob(id: string, patch: JobPatch): Promise<JobRow> {
    if (!isUuid(id)) throw notFound(`Job ${id} not found.`);
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const key of Object.keys(patch) as Array<keyof JobPatch>) {
      const value = patch[key];
      if (value === undefined) continue;
      const column = JOB_COLUMNS[key];
      if (!column) continue;
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }

    if (sets.length === 0) {
      const existing = await this.getJob(id);
      if (!existing) throw notFound(`Job ${id} not found.`);
      return existing;
    }

    values.push(id);
    const { rows } = await this.pool.query<JobRow>(
      `UPDATE render_jobs SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    const row = rows[0];
    if (!row) throw notFound(`Job ${id} not found.`);
    return row;
  }

  async listJobs(videoId: string, limit = 1): Promise<JobRow[]> {
    if (!isUuid(videoId)) return [];
    const { rows } = await this.pool.query<JobRow>(
      'SELECT * FROM render_jobs WHERE video_id = $1 ORDER BY created_at DESC LIMIT $2',
      [videoId, limit],
    );
    return rows;
  }

  async listUnfinishedJobs(cutoff: string, limit = 100): Promise<JobRow[]> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT * FROM render_jobs
       WHERE status IN ('queued', 'active')
         AND updated_at < $1
       ORDER BY updated_at ASC
       LIMIT $2`,
      [cutoff, limit],
    );
    return rows;
  }

  async log(videoId: string | null, step: string, status: string, message: string): Promise<void> {
    await this.pool.query('INSERT INTO job_logs (video_id, step, status, message) VALUES ($1, $2, $3, $4)', [
      videoId,
      step,
      status,
      message.slice(0, 4000),
    ]);
  }

  async listLogs(videoId: string | null, limit = 30): Promise<LogRow[]> {
    const { rows } =
      videoId === null
        ? await this.pool.query<LogRow>(
            'SELECT * FROM job_logs WHERE video_id IS NULL ORDER BY created_at DESC LIMIT $1',
            [limit],
          )
        : await this.pool.query<LogRow>(
            'SELECT * FROM job_logs WHERE video_id = $1 ORDER BY created_at DESC LIMIT $2',
            [videoId, limit],
          );
    return rows;
  }

  async countUploadsToday(): Promise<number> {
    // `uploaded_at` is stamped when a quota slot is reserved, so an in-flight upload counts too;
    // otherwise two concurrent uploads would both see a free slot.
    const { rows } = await this.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM videos
       WHERE uploaded_at >= now() - interval '24 hours'`,
    );
    return rows[0]?.count ?? 0;
  }

  async startPipelineRun(input: StartPipelineRunInput): Promise<PipelineRunRow> {
    const { rows } = await this.pool.query<PipelineRunRow>(
      `INSERT INTO pipeline_runs (trigger_kind, niche, audience)
       VALUES ($1, $2, $3)
       RETURNING ${PIPELINE_RUN_COLUMNS}`,
      [input.trigger, input.niche ?? null, input.audience ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('Failed to create pipeline run.');
    return row;
  }

  async finishPipelineRun(id: string, patch: FinishPipelineRunPatch): Promise<PipelineRunRow> {
    if (!isUuid(id)) throw notFound(`Pipeline run ${id} not found.`);
    const { rows } = await this.pool.query<PipelineRunRow>(
      `UPDATE pipeline_runs
       SET status = $2,
           video_id = COALESCE($3, video_id),
           job_id = COALESCE($4, job_id),
           reason = COALESCE($5, reason),
           error = COALESCE($6, error),
           finished_at = now()
       WHERE id = $1
       RETURNING ${PIPELINE_RUN_COLUMNS}`,
      [
        id,
        patch.status,
        patch.videoId ?? null,
        patch.jobId ?? null,
        patch.reason ?? null,
        patch.error ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw notFound(`Pipeline run ${id} not found.`);
    return row;
  }

  async latestPipelineRun(): Promise<PipelineRunRow | null> {
    const { rows } = await this.pool.query<PipelineRunRow>(
      `SELECT ${PIPELINE_RUN_COLUMNS} FROM pipeline_runs ORDER BY started_at DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  async listStalePipelineRuns(cutoff: string, limit = 100): Promise<PipelineRunRow[]> {
    const { rows } = await this.pool.query<PipelineRunRow>(
      `SELECT ${PIPELINE_RUN_COLUMNS} FROM pipeline_runs
       WHERE status = 'running' AND started_at < $1
       ORDER BY started_at ASC
       LIMIT $2`,
      [cutoff, limit],
    );
    return rows;
  }

  /**
   * A dedicated connection holds a session-level advisory lock for the length of the run, so a
   * second instance (or a manual run) is refused instead of generating a duplicate video. The lock
   * disappears by itself if the process dies.
   */
  async acquirePipelineLock(): Promise<(() => Promise<void>) | null> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [PIPELINE_LOCK],
      );
      if (!rows[0]?.locked) {
        client.release();
        return null;
      }

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await client.query('SELECT pg_advisory_unlock($1)', [PIPELINE_LOCK]).catch(() => undefined);
        client.release();
      };
    } catch (error) {
      client.release();
      throw error;
    }
  }

  async listStaleUploadReservations(cutoff: string, limit = 100): Promise<VideoRow[]> {
    const { rows } = await this.pool.query<VideoRow>(
      `SELECT * FROM videos
       WHERE uploaded_at IS NOT NULL
         AND youtube_video_id IS NULL
         AND uploaded_at < $1
       ORDER BY uploaded_at ASC
       LIMIT $2`,
      [cutoff, limit],
    );
    return rows;
  }

  async claimUploadSlot(videoId: string, options: UploadClaimOptions): Promise<UploadClaim> {
    if (!isUuid(videoId)) throw notFound(`Video ${videoId} not found.`);
    const { limit, replace = false } = options;
    const now = options.now ?? new Date();
    const windowStart = new Date(now.getTime() - DAY_MS).toISOString();

    // A transaction-wide advisory lock serialises quota reservations across every API and worker
    // process, so two concurrent uploads can never both read the same "one slot left".
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [UPLOAD_QUOTA_LOCK]);

      const { rows } = await client.query<VideoRow>('SELECT * FROM videos WHERE id = $1 FOR UPDATE', [videoId]);
      const existing = rows[0];
      if (!existing) {
        await client.query('ROLLBACK');
        throw notFound(`Video ${videoId} not found.`);
      }

      if (existing.youtube_video_id && !replace) {
        await client.query('ROLLBACK');
        return { status: 'already_uploaded', youtubeVideoId: existing.youtube_video_id };
      }

      if (
        !existing.youtube_video_id &&
        existing.uploaded_at !== null &&
        now.getTime() - Date.parse(existing.uploaded_at) < UPLOAD_CLAIM_TIMEOUT_MS
      ) {
        await client.query('ROLLBACK');
        return { status: 'in_progress', since: existing.uploaded_at };
      }

      const counted = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM videos
         WHERE id <> $1 AND uploaded_at >= $2`,
        [videoId, windowStart],
      );
      const used = counted.rows[0]?.count ?? 0;
      if (used >= limit) {
        await client.query('ROLLBACK');
        return { status: 'quota_exhausted', used, limit };
      }

      const reservedAt = now.toISOString();
      const updated = await client.query<VideoRow>(
        'UPDATE videos SET uploaded_at = $2 WHERE id = $1 RETURNING *',
        [videoId, reservedAt],
      );
      await client.query('COMMIT');

      const row = updated.rows[0];
      if (!row) throw notFound(`Video ${videoId} not found.`);
      return { status: 'claimed', video: row, reservedAt };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseUploadSlot(videoId: string, reservedAt: string): Promise<void> {
    if (!isUuid(videoId)) return;
    // Scoped to the exact reservation: never frees a slot that already produced a YouTube video.
    await this.pool.query(
      `UPDATE videos SET uploaded_at = NULL
       WHERE id = $1 AND uploaded_at = $2 AND youtube_video_id IS NULL`,
      [videoId, reservedAt],
    );
  }

  /** Used by the health endpoint only. */
  async ping(): Promise<boolean> {
    await this.pool.query('SELECT 1');
    return true;
  }
}

