import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, paths } from '../config.js';
import { getStore } from '../db/index.js';
import type { JobRow, PipelineRunRow } from '../db/types.js';
import { UPLOAD_CLAIM_TIMEOUT_MS } from '../db/types.js';
import { errorMessage, logger } from '../utils/logger.js';
import { notifyAdmin } from './alerts.js';
import { logStep } from './jobLog.js';

/**
 * Startup recovery.
 *
 * A render only exists as a BullMQ job plus a `render_jobs` row marked `active`; if the process
 * dies mid-render (crash, `kill -9`, container eviction, OOM) nothing ever writes a final status,
 * so the UI polls a job that never finishes and the video stays a draft forever. BullMQ re-runs
 * `active` jobs only when it still owns the lock, and an inline render has no owner at all.
 *
 * Both entry points (API process and standalone worker) therefore run `reconcileOnBoot()` before
 * they start taking work: stale jobs are failed, abandoned temp artefacts are removed, and the
 * admin is told. A graceful shutdown additionally fails whatever is in flight right away, so an
 * ordinary Ctrl+C does not have to wait for the timeout.
 */

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ReconcileOptions {
  /** Override the clock (tests use this to make jobs old without waiting). */
  now?: Date;
  /** Override RENDER_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface ReconcileReport {
  cutoff: string;
  failedJobs: number;
  failedVideos: number;
  jobIds: string[];
}

/**
 * Fails every queued/active job whose last heartbeat is older than the render timeout, and
 * resolves its video to `failed` so it can be re-rendered instead of hanging forever.
 */
export async function reconcileStaleRenderJobs(options: ReconcileOptions = {}): Promise<ReconcileReport> {
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? config.renderTimeoutMs;
  const cutoff = new Date(now.getTime() - timeoutMs).toISOString();
  const store = getStore();

  const stale: JobRow[] = await store.listUnfinishedJobs(cutoff);
  const report: ReconcileReport = { cutoff, failedJobs: 0, failedVideos: 0, jobIds: [] };
  if (stale.length === 0) return report;

  for (const job of stale) {
    const message =
      `Render timed out: the job stayed "${job.status}" at ${job.progress}% ` +
      `(${job.stage ?? 'no stage'}) for more than ${formatDuration(timeoutMs)} with no progress. ` +
      'The process was most likely restarted or killed mid-render. The job is marked failed; render the video again.';

    await store.updateJob(job.id, {
      status: 'failed',
      progress: job.progress,
      stage: 'stalled',
      error: message,
    });
    report.failedJobs += 1;
    report.jobIds.push(job.id);

    const video = await store.getVideo(job.video_id).catch(() => null);
    // Only touch videos that were waiting on this render; never downgrade finished ones.
    if (video && (video.status === 'draft' || video.status === 'failed')) {
      await store.updateVideo(job.video_id, { status: 'failed', error: message });
      report.failedVideos += 1;
    }

    await logStep(job.video_id, 'render', 'failed', message);
    logger.warn(`Failed stale render job ${job.id} for video ${job.video_id} (last seen ${job.updated_at}).`);
  }

  await notifyAdmin(
    `${report.failedJobs} render job(s) were stuck past the ${formatDuration(timeoutMs)} timeout ` +
      '(the process was restarted or killed mid-render) and have been marked failed. Open the dashboard and render those videos again.',
    'error',
  );

  return report;
}

/* -------------------------------------------------------------------------- */
/* Abandoned upload reservations                                              */
/* -------------------------------------------------------------------------- */

export interface UploadReleaseOptions {
  /** Override the clock (tests). */
  now?: Date;
  /** How long a reservation may look "in flight" before it is considered abandoned. */
  inFlightMs?: number;
}

export interface UploadReleaseReport {
  cutoff: string;
  released: number;
  videoIds: string[];
}

/**
 * An upload reserves a quota slot by stamping `uploaded_at` before `videos.insert`, so concurrent
 * requests cannot both take the last slot. If the process dies during the insert, that stamp stays
 * behind with no YouTube video and silently costs one of the day's uploads for 24 hours. Release
 * every reservation older than the in-flight window that never produced a video.
 */
export async function reconcileStaleUploadReservations(
  options: UploadReleaseOptions = {},
): Promise<UploadReleaseReport> {
  const now = options.now ?? new Date();
  const inFlightMs = options.inFlightMs ?? UPLOAD_CLAIM_TIMEOUT_MS;
  const cutoff = new Date(now.getTime() - inFlightMs).toISOString();
  const store = getStore();

  const abandoned = await store.listStaleUploadReservations(cutoff);
  const report: UploadReleaseReport = { cutoff, released: 0, videoIds: [] };
  if (abandoned.length === 0) return report;

  for (const video of abandoned) {
    const reservedAt = video.uploaded_at;
    if (!reservedAt) continue;

    // Scoped to this exact reservation: a video that did get uploaded keeps its slot.
    await store.releaseUploadSlot(video.id, reservedAt);
    report.released += 1;
    report.videoIds.push(video.id);

    const message =
      `Released an upload reservation from ${reservedAt}: no YouTube video was created, so it no ` +
      'longer counts against the daily quota. The upload was interrupted before it finished.';
    await logStep(video.id, 'upload', 'warning', message);
    logger.warn(`Released abandoned upload reservation for video ${video.id} (${reservedAt}).`);
  }

  await notifyAdmin(
    `${report.released} upload reservation(s) were abandoned by an interrupted process and have been ` +
      'released, returning the quota slots. Those videos were never uploaded.',
    'error',
  );

  return report;
}

/* -------------------------------------------------------------------------- */
/* Interrupted pipeline runs                                                   */
/* -------------------------------------------------------------------------- */

export interface RunSweepOptions {
  /** Override the clock (tests). */
  now?: Date;
  /** Override PIPELINE_STALE_RUN_MINUTES. */
  staleMs?: number;
}

export interface RunSweepReport {
  cutoff: string;
  failedRuns: PipelineRunRow[];
}

/**
 * `runDaily` closes its ledger row when it finishes (skipped, completed or failed), so a row still
 * `running` long after it started belongs to a process that was killed mid-run — or to a close that
 * itself failed. Left alone it reports a run that never ended, so "did the pipeline run today?" is
 * unanswerable and the admin keeps seeing a run in flight. Startup recovery closes those rows.
 *
 * The window is generous on purpose: a live run in another instance takes minutes, and a row must
 * never be failed while its process is still working.
 */
export async function reconcileStalePipelineRuns(options: RunSweepOptions = {}): Promise<RunSweepReport> {
  const now = options.now ?? new Date();
  const staleMs = options.staleMs ?? config.pipelineStaleRunMs;
  const cutoff = new Date(now.getTime() - staleMs).toISOString();
  const store = getStore();

  const stale = await store.listStalePipelineRuns(cutoff);
  const report: RunSweepReport = { cutoff, failedRuns: [] };
  if (stale.length === 0) return report;

  const message =
    `Interrupted: this pipeline run was still marked "running" more than ${formatDuration(staleMs)} after it ` +
    'started, so the process that owned it was most likely restarted or killed mid-run. ' +
    'Its draft, if any, was never finished. Start the pipeline again.';

  for (const run of stale) {
    const closed = await store.finishPipelineRun(run.id, { status: 'failed', error: message });
    report.failedRuns.push(closed);
    await logStep(run.video_id, 'pipeline', 'failed', message);
    logger.warn(`Failed stale pipeline run ${run.id} (${run.trigger}, started ${run.started_at}).`);
  }

  await notifyAdmin(
    `${report.failedRuns.length} pipeline run(s) were still marked "running" from an interrupted process ` +
      'and have been closed as failed. Start the pipeline again if today has no draft.',
    'error',
  );

  return report;
}

/* -------------------------------------------------------------------------- */
/* Orphaned artefacts                                                          */
/* -------------------------------------------------------------------------- */

/** Written by `ffmpeg.ts` while burning captions, into the backend working directory. */
const CAPTION_FILTER_FILE = /^\.yt-captions-.*\.ass$/i;
/** Written by `ffmpeg.concatMp3()` into uploads/temp. */
const MP3_CONCAT_LIST = /^mp3-concat-.*\.txt$/i;
/** Written by `ffmpeg.renderVideo()`; one directory per in-flight video. */
const RENDER_TEMP_DIR = /^render-/i;
/** Written by the Pexels downloader before an atomic rename. */
const PARTIAL_DOWNLOAD = /\.part$/i;

export interface CleanupReport {
  removed: string[];
  bytesFreed: number;
  failures: Array<{ target: string; error: string }>;
}

async function sizeOf(target: string): Promise<number> {
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  const entries = await fsp.readdir(target, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) total += await sizeOf(path.join(target, entry.name));
  return total;
}

/**
 * Removes leftovers of renders and downloads that never finished: `render-*` scratch directories,
 * `.part` downloads, concatenation lists and caption filter files.
 *
 * Safe to run at startup because nothing is rendering yet. Deliberately narrow: rendered videos,
 * voiceovers, downloaded clips and thumbnails are user data and are never touched.
 */
export async function cleanOrphanedRenderArtifacts(): Promise<CleanupReport> {
  const report: CleanupReport = { removed: [], bytesFreed: 0, failures: [] };

  const targets: string[] = [];

  const scan = async (dir: string, matches: (name: string) => boolean): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (matches(entry.name)) targets.push(path.join(dir, entry.name));
    }
  };

  await scan(paths.temp, (name) => RENDER_TEMP_DIR.test(name) || MP3_CONCAT_LIST.test(name) || PARTIAL_DOWNLOAD.test(name));
  for (const dir of [paths.clips, paths.audio, paths.videos, paths.thumbnails]) {
    await scan(dir, (name) => PARTIAL_DOWNLOAD.test(name));
  }
  await scan(paths.backend, (name) => CAPTION_FILTER_FILE.test(name));

  for (const target of targets) {
    try {
      const bytes = await sizeOf(target);
      await fsp.rm(target, { recursive: true, force: true });
      report.removed.push(target);
      report.bytesFreed += bytes;
    } catch (error) {
      report.failures.push({ target, error: errorMessage(error) });
      logger.warn(`Could not remove orphaned artefact ${target}: ${errorMessage(error)}`);
    }
  }

  if (report.removed.length > 0) {
    logger.info(
      `Removed ${report.removed.length} orphaned render artefact(s), freeing ${formatBytes(report.bytesFreed)}.`,
    );
  }

  return report;
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Runs before the server starts listening or the worker starts consuming jobs.
 * Never throws: a failed recovery must not stop the app from starting.
 */
export async function reconcileOnBoot(options: ReconcileOptions = {}): Promise<void> {
  try {
    const cleanup = await cleanOrphanedRenderArtifacts();
    if (cleanup.removed.length > 0) {
      await logStep(
        null,
        'recovery',
        'warning',
        `Startup cleanup removed ${cleanup.removed.length} orphaned artefact(s) (${formatBytes(cleanup.bytesFreed)}).`,
      );
    }

    const reservations = await reconcileStaleUploadReservations({ now: options.now });
    if (reservations.released > 0) {
      await logStep(
        null,
        'recovery',
        'warning',
        `Startup recovery released ${reservations.released} abandoned upload reservation(s).`,
      );
    }

    const jobs = await reconcileStaleRenderJobs({ now: options.now });
    if (jobs.failedJobs > 0) {
      await logStep(
        null,
        'recovery',
        'warning',
        `Startup reconciliation failed ${jobs.failedJobs} stale render job(s) from an interrupted run.`,
      );
    }

    const runs = await reconcileStalePipelineRuns({ now: options.now });
    if (runs.failedRuns.length > 0) {
      await logStep(
        null,
        'recovery',
        'warning',
        `Startup recovery closed ${runs.failedRuns.length} interrupted pipeline run(s).`,
      );
    }
  } catch (error) {
    logger.error(`Startup reconciliation failed: ${errorMessage(error)}`);
  }
}
