import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from '../src/config.js';
import { closeStore, getStore, initStore } from '../src/db/index.js';
import { UPLOAD_CLAIM_TIMEOUT_MS } from '../src/db/types.js';
import {
  cleanOrphanedRenderArtifacts,
  reconcileOnBoot,
  reconcileStalePipelineRuns,
  reconcileStaleRenderJobs,
  reconcileStaleUploadReservations,
} from '../src/services/reconciliation.js';

before(async () => {
  const store = await initStore();
  assert.equal(store.mode, 'memory', 'tests must run against the in-memory store');
});

after(async () => {
  await closeStore();
});

/** A clock far enough ahead that any job created now looks older than the render timeout. */
function afterRenderTimeout(): Date {
  return new Date(Date.now() + config.renderTimeoutMs + 60_000);
}

/** A clock far enough ahead that a pipeline run started now looks abandoned. */
function afterStaleRunWindow(): Date {
  return new Date(Date.now() + config.pipelineStaleRunMs + 60_000);
}

test('a job stuck past the render timeout is failed and its video resolved', async () => {
  const store = getStore();

  const activeVideo = await store.createVideo({ topic: 'Interrupted render' });
  const activeJob = await store.createJob(activeVideo.id);
  await store.updateJob(activeJob.id, { status: 'active', progress: 62, stage: 'clip 3/7' });

  const queuedVideo = await store.createVideo({ topic: 'Queued behind a killed worker' });
  const queuedJob = await store.createJob(queuedVideo.id);

  const report = await reconcileStaleRenderJobs({ now: afterRenderTimeout() });
  assert.equal(report.failedJobs, 2, 'both the active and the queued job are reclaimed');
  assert.equal(report.failedVideos, 2);

  const pairs = [
    [activeJob.id, activeVideo.id],
    [queuedJob.id, queuedVideo.id],
  ] as const;

  for (const [jobId, videoId] of pairs) {
    const job = await store.getJob(jobId);
    assert.equal(job?.status, 'failed');
    assert.equal(job?.stage, 'stalled');
    assert.match(job?.error ?? '', /timed out/i);

    const video = await store.getVideo(videoId);
    assert.equal(video?.status, 'failed', 'the video must resolve so it can be rendered again');
    assert.match(video?.error ?? '', /timed out/i);

    const logs = await store.listLogs(videoId, 10);
    assert.ok(
      logs.some((row) => row.status === 'failed' && /timed out/i.test(row.message ?? '')),
      'the recovery is written to the activity log',
    );
  }
});

test('a render that is still within the timeout is left alone', async () => {
  const store = getStore();
  const video = await store.createVideo({ topic: 'Fresh render' });
  const job = await store.createJob(video.id);
  await store.updateJob(job.id, { status: 'active', progress: 40, stage: 'clip 2/5' });

  const report = await reconcileStaleRenderJobs();
  assert.equal(report.failedJobs, 0, 'an in-progress render must never be failed by recovery');
  assert.equal((await store.getJob(job.id))?.status, 'active');
  assert.equal((await store.getVideo(video.id))?.status, 'draft');
});

test('a rendered video is not downgraded when its stale job is reclaimed', async () => {
  const store = getStore();
  const video = await store.createVideo({ topic: 'Already rendered' });
  await store.updateVideo(video.id, { video_path: 'C:/fake/rendered.mp4', status: 'rendered' });
  const job = await store.createJob(video.id);
  await store.updateJob(job.id, { status: 'active', progress: 99, stage: 'finalising' });

  const report = await reconcileStaleRenderJobs({ now: afterRenderTimeout() });
  assert.ok(report.jobIds.includes(job.id));

  assert.equal((await store.getJob(job.id))?.status, 'failed');
  const stored = await store.getVideo(video.id);
  assert.equal(stored?.status, 'rendered', 'a finished render keeps its status');
  assert.equal(stored?.error, null);
});

test('a pipeline run left running past the window is closed as failed with a reason', async () => {
  const store = getStore();

  const completed = await store.startPipelineRun({ trigger: 'schedule' });
  await store.finishPipelineRun(completed.id, { status: 'completed' });
  const crashed = await store.startPipelineRun({ trigger: 'schedule' });

  const live = await reconcileStalePipelineRuns();
  assert.deepEqual(live.failedRuns, [], 'a run inside the window is not presumed dead');

  const report = await reconcileStalePipelineRuns({ now: afterStaleRunWindow() });
  assert.deepEqual(
    report.failedRuns.map((run) => run.id),
    [crashed.id],
    'only the abandoned run is closed, never one that already finished',
  );

  const closed = report.failedRuns[0];
  assert.ok(closed);
  assert.equal(closed.status, 'failed');
  assert.ok(closed.finished_at, 'the row gets an end time instead of hanging forever');
  assert.match(closed.error ?? '', /interrupted/i);
  assert.match(closed.error ?? '', /2 h/, 'the reason names the window it exceeded');

  const logs = await store.listLogs(null, 20);
  assert.ok(
    logs.some((row) => row.step === 'pipeline' && row.status === 'failed' && /interrupted/i.test(row.message ?? '')),
    'the recovery is written to the activity log',
  );
});

test('boot reconciliation closes the interrupted run', async () => {
  const store = getStore();
  const crashed = await store.startPipelineRun({ trigger: 'boot' });

  await reconcileOnBoot({ now: afterStaleRunWindow() });

  const closed = await store.latestPipelineRun();
  assert.equal(closed?.id, crashed.id);
  assert.equal(closed?.status, 'failed', 'a restart finally closes the ledger row');
});

test('an upload reservation abandoned by a crashed process is released at startup', async () => {
  const store = getStore();
  const abandonedAt = new Date(Date.now() - UPLOAD_CLAIM_TIMEOUT_MS - 15 * 60 * 1000).toISOString();

  // Died during videos.insert: uploaded_at is stamped, but no YouTube video was created.
  const abandoned = await store.createVideo({ topic: 'Crashed upload' });
  await store.updateVideo(abandoned.id, { uploaded_at: abandonedAt });

  // A real upload keeps its slot, and an upload that is genuinely still in flight is left alone.
  const uploaded = await store.createVideo({ topic: 'Really uploaded' });
  await store.updateVideo(uploaded.id, {
    youtube_video_id: 'yt-survives',
    status: 'uploaded',
    uploaded_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  const inFlight = await store.createVideo({ topic: 'In flight now' });
  await store.updateVideo(inFlight.id, { uploaded_at: new Date().toISOString() });

  const usedBefore = await store.countUploadsToday();
  const report = await reconcileStaleUploadReservations();

  assert.equal(report.released, 1);
  assert.deepEqual(report.videoIds, [abandoned.id]);
  assert.equal((await store.getVideo(abandoned.id))?.uploaded_at, null, 'the slot comes back');
  assert.equal(await store.countUploadsToday(), usedBefore - 1);

  assert.ok((await store.getVideo(uploaded.id))?.uploaded_at, 'a completed upload keeps its reservation');
  assert.ok((await store.getVideo(inFlight.id))?.uploaded_at, 'a live reservation is not touched');

  const logs = await store.listLogs(abandoned.id, 10);
  assert.ok(
    logs.some((row) => row.step === 'upload' && row.status === 'warning' && /released/i.test(row.message ?? '')),
    'the recovery is visible in the activity log',
  );
});

test('a reservation younger than the in-flight window survives the sweep', async () => {
  const store = getStore();
  const video = await store.createVideo({ topic: 'Just reserved' });
  await store.updateVideo(video.id, { uploaded_at: new Date().toISOString() });

  const report = await reconcileStaleUploadReservations();
  assert.ok(!report.videoIds.includes(video.id));
  assert.ok((await store.getVideo(video.id))?.uploaded_at);
});

test('startup cleanup removes orphaned render artefacts and keeps user media', async () => {
  const renderDir = path.join(paths.temp, `render-${randomUUID()}`);
  fs.mkdirSync(renderDir, { recursive: true });
  fs.writeFileSync(path.join(renderDir, 'seg-000.mp4'), Buffer.alloc(2048));

  const concatList = path.join(paths.temp, 'mp3-concat-test.txt');
  fs.writeFileSync(concatList, "file 'part-1.mp3'");
  const partialClip = path.join(paths.clips, 'pexels-12345.mp4.part');
  fs.writeFileSync(partialClip, Buffer.alloc(1024));
  // ffmpeg.ts burns captions from a hidden .ass file in the backend working directory.
  const captionFilter = path.join(paths.backend, '.yt-captions-test-fixture.ass');
  fs.writeFileSync(captionFilter, '[Script Info]');

  const keepClip = path.join(paths.clips, 'pexels-keep-me.mp4');
  fs.writeFileSync(keepClip, Buffer.alloc(64));
  const keepCaption = path.join(paths.videos, 'keep-me.ass');
  fs.writeFileSync(keepCaption, '[Script Info]');

  try {
    const report = await cleanOrphanedRenderArtifacts();
    const removed = new Set(report.removed.map((entry) => path.resolve(entry)));

    for (const target of [renderDir, concatList, partialClip, captionFilter]) {
      assert.ok(removed.has(path.resolve(target)), `${path.basename(target)} should be removed`);
      assert.equal(fs.existsSync(target), false, `${path.basename(target)} should be gone`);
    }

    assert.ok(report.bytesFreed >= 3072, 'the report accounts for the space that was freed');
    assert.ok(fs.existsSync(keepClip), 'downloaded clips are user media and must survive');
    assert.ok(fs.existsSync(keepCaption), 'rendered caption sidecars must survive');
  } finally {
    for (const target of [keepClip, keepCaption]) fs.rmSync(target, { force: true });
  }
});
