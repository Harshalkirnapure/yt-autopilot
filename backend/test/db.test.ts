import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { config } from '../src/config.js';
import { closeStore, getPool, getStore, initStore } from '../src/db/index.js';
import type { Store } from '../src/db/types.js';
import { UPLOAD_CLAIM_TIMEOUT_MS } from '../src/db/types.js';
import { buildServer } from '../src/server.js';

/**
 * These tests exercise PgStore against a real PostgreSQL server. `scripts/run-db-tests.mjs`
 * creates a throwaway database and points DATABASE_URL at it, so the suite must never be run
 * against a database whose name does not end in `_test`.
 */

let app: FastifyInstance;
let store: Store;

function pool() {
  const instance = getPool();
  if (!instance) throw new Error('Postgres pool is not initialised.');
  return instance;
}

function statusCodeOf(error: unknown): number | undefined {
  return (error as { statusCode?: number } | null)?.statusCode;
}

const TABLES = [
  'pipeline_runs',
  'render_jobs',
  'job_logs',
  'used_clips',
  'used_topics',
  'oauth_tokens',
  'videos',
];

before(async () => {
  const databaseName = new URL(config.databaseUrl).pathname.replace('/', '');
  assert.match(databaseName, /_test$/, 'integration tests only run against a *_test database');

  store = await initStore();
  assert.equal(store.mode, 'postgres', 'DATABASE_URL must reach PostgreSQL for this suite');
  assert.equal(await (store as Store & { ping(): Promise<boolean> }).ping(), true);

  // The schema is applied by initStore(); running it again proves it is idempotent and that the
  // migration statements (e.g. ADD COLUMN IF NOT EXISTS approved_by) re-apply cleanly.
  const schema = fs.readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
  await pool().query(schema);

  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app.close();
  await pool().query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  await closeStore();
});

beforeEach(async () => {
  await pool().query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
});

/* -------------------------------------------------------------------------- */
/* UUID guard                                                                 */
/* -------------------------------------------------------------------------- */

test('a non-UUID id is a 404, not a 500 from the uuid column', async () => {
  // Without the guard this is exactly what Postgres throws, which the API surfaced as a 500.
  await assert.rejects(
    () => pool().query('SELECT * FROM videos WHERE id = $1', ['not-a-uuid']),
    /invalid input syntax for type uuid/i,
  );

  assert.equal(await store.getVideo('not-a-uuid'), null);
  assert.equal(await store.getJob('not-a-uuid'), null);
  assert.deepEqual(await store.listJobs('not-a-uuid'), []);

  for (const [label, run] of [
    ['updateVideo', () => store.updateVideo('not-a-uuid', { topic: 'x' })],
    ['updateJob', () => store.updateJob('not-a-uuid', { progress: 10 })],
  ] as const) {
    await assert.rejects(run, (error: unknown) => {
      assert.equal(statusCodeOf(error), 404, `${label} must answer 404 for a malformed id`);
      return true;
    });
  }
});

test('a well-formed but unknown UUID still answers not found', async () => {
  const missing = '00000000-0000-4000-8000-000000000000';
  assert.equal(await store.getVideo(missing), null);
  assert.deepEqual(await store.listJobs(missing), []);
  await assert.rejects(
    () => store.updateVideo(missing, { topic: 'x' }),
    (error: unknown) => statusCodeOf(error) === 404,
  );
});

test('the API turns a malformed video id into a JSON 404', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/videos/not-a-uuid',
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(response.statusCode, 404);
  assert.match(response.json().error, /not found/i);
});

/* -------------------------------------------------------------------------- */
/* used_topics expression index                                               */
/* -------------------------------------------------------------------------- */

test('the lower(topic) unique index exists and dedupes case-insensitively', async () => {
  const index = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
     WHERE schemaname = current_schema() AND tablename = 'used_topics' AND indexname = 'used_topics_topic_key'`,
  );
  assert.equal(index.rowCount, 1, 'used_topics_topic_key must be created by the schema');
  assert.match(index.rows[0]!.indexdef, /UNIQUE INDEX .*lower\(topic\)/i);

  await store.addUsedTopic('Personal Finance Tips', 'finance');
  await store.addUsedTopic('personal finance tips', 'finance');
  await store.addUsedTopic('PERSONAL FINANCE TIPS', 'finance');

  // ON CONFLICT (lower(topic)) only works because of that index; a missing index raises
  // "there is no unique or exclusion constraint matching the ON CONFLICT specification".
  const { rows } = await pool().query<{ count: number }>('SELECT count(*)::int AS count FROM used_topics');
  assert.equal(rows[0]?.count, 1, 'the same topic in different casing is stored once');

  const stored = await pool().query<{ topic: string }>('SELECT topic FROM used_topics');
  assert.equal(stored.rows[0]?.topic, 'Personal Finance Tips', 'the original casing is kept');
});

test('a used topic keeps its video reference and survives the video being deleted', async () => {
  const video = await store.createVideo({ topic: 'Topic ledger owner' });
  await store.addUsedTopic('Topic ledger entry', 'finance', video.id);

  const linked = await pool().query<{ video_id: string | null }>(
    'SELECT video_id FROM used_topics WHERE lower(topic) = lower($1)',
    ['Topic ledger entry'],
  );
  assert.equal(linked.rows[0]?.video_id, video.id);

  await pool().query('DELETE FROM videos WHERE id = $1', [video.id]);

  const orphaned = await pool().query<{ video_id: string | null }>(
    'SELECT video_id FROM used_topics WHERE lower(topic) = lower($1)',
    ['Topic ledger entry'],
  );
  assert.equal(orphaned.rowCount, 1, 'the ledger keeps the topic after the draft is gone');
  assert.equal(orphaned.rows[0]?.video_id, null, 'ON DELETE SET NULL clears the dangling reference');
});

test('recentTopics merges videos and the topic ledger in recency order', async () => {
  const older = await store.createVideo({ topic: 'Ledger topic from video' });
  await store.updateVideo(older.id, { script: 'a' });
  await store.addUsedTopic('Ledger topic from ledger', 'finance');

  const topics = await store.recentTopics(10);
  assert.ok(topics.includes('Ledger topic from video'));
  assert.ok(topics.includes('Ledger topic from ledger'));

  const limited = await store.recentTopics(1);
  assert.equal(limited.length, 1);
});

/* -------------------------------------------------------------------------- */
/* Clip ledger                                                                */
/* -------------------------------------------------------------------------- */

test('the clip ledger records each Pexels id exactly once', async () => {
  const video = await store.createVideo({ topic: 'Clip ledger' });
  await store.markClipUsed('pexels-clip-1', video.id);
  await store.markClipUsed('pexels-clip-1', video.id);

  assert.equal(await store.isClipUsed('pexels-clip-1'), true);
  assert.equal(await store.isClipUsed('pexels-clip-2'), false);
  assert.equal(await store.countUsedClips(), 1);
});

/* -------------------------------------------------------------------------- */
/* Rows, types and constraints                                                */
/* -------------------------------------------------------------------------- */

test('Postgres values round-trip with the expected JS types', async () => {
  const video = await store.createVideo({
    topic: 'Type round-trip',
    niche: 'finance',
    audience: 'freelancers',
    language: 'English',
  });
  assert.equal(video.status, 'draft');
  assert.equal(video.script, null);
  assert.match(video.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'timestamptz is an ISO string');
  assert.ok(video.created_at.endsWith('Z'));

  const updated = await store.updateVideo(video.id, {
    seo_title: 'Title',
    seo_tags: ['one', 'two'],
    audio_duration: 12.5,
  });
  assert.deepEqual(updated.seo_tags, ['one', 'two'], 'TEXT[] round-trips as an array');
  assert.equal(updated.audio_duration, 12.5);
});

test('partial patches only touch the columns they name', async () => {
  const video = await store.createVideo({ topic: 'Partial patch', niche: 'finance' });
  const patched = await store.updateVideo(video.id, { seo_title: 'Only the title' });

  assert.equal(patched.seo_title, 'Only the title');
  assert.equal(patched.niche, 'finance', 'untouched columns keep their value');
  assert.equal(patched.script, null);

  const empty = await store.updateVideo(video.id, {});
  assert.equal(empty.id, video.id, 'an empty patch returns the stored row');
  assert.equal(empty.updated_at, patched.updated_at, 'an empty patch performs no write');
});

test('the updated_at trigger advances on update', async () => {
  const video = await store.createVideo({ topic: 'Trigger check' });
  const first = await store.updateVideo(video.id, { niche: 'finance' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = await store.updateVideo(video.id, { audience: 'creators' });

  assert.ok(
    Date.parse(second.updated_at) > Date.parse(first.updated_at),
    'videos_set_updated_at must stamp a new updated_at on every UPDATE',
  );
});

test('database constraints reject values the API never should send', async () => {
  await assert.rejects(
    () => pool().query(`INSERT INTO videos (topic) VALUES (NULL)`),
    /violates not-null constraint/i,
  );

  const video = await store.createVideo({ topic: 'Check constraint' });
  await assert.rejects(
    () => pool().query(`UPDATE videos SET status = 'nonsense' WHERE id = $1`, [video.id]),
    /violates check constraint/i,
  );

  const job = await store.createJob(video.id);
  await assert.rejects(
    () => pool().query(`UPDATE render_jobs SET status = 'nonsense' WHERE id = $1`, [job.id]),
    /violates check constraint/i,
  );
});

test('deleting a video cascades to its logs and render jobs', async () => {
  const video = await store.createVideo({ topic: 'Cascade check' });
  const job = await store.createJob(video.id);
  await store.log(video.id, 'render', 'success', 'done');

  await pool().query('DELETE FROM videos WHERE id = $1', [video.id]);

  assert.equal(await store.getJob(job.id), null);
  assert.deepEqual(await store.listLogs(video.id), []);
});

/* -------------------------------------------------------------------------- */
/* Approval rule in real SQL                                                  */
/* -------------------------------------------------------------------------- */

test('approval is recorded with its approver and voided by a content edit', async () => {
  const video = await store.createVideo({ topic: 'Approval in SQL' });
  const approved = await store.updateVideo(video.id, {
    approved_at: new Date().toISOString(),
    approved_by: 'Priya Reviewer',
  });
  assert.ok(approved.approved_at);
  assert.equal(approved.approved_by, 'Priya Reviewer');

  const edited = await store.updateVideo(video.id, { seo_title: 'A title nobody approved' });
  assert.equal(edited.approved_at, null, 'editing approved content clears approved_at');
  assert.equal(edited.approved_by, null, 'and it clears the recorded approver too');

  const stored = await pool().query<{ approved_at: string | null; approved_by: string | null }>(
    'SELECT approved_at, approved_by FROM videos WHERE id = $1',
    [video.id],
  );
  assert.equal(stored.rows[0]?.approved_at, null, 'the clearing is persisted, not just returned');
  assert.equal(stored.rows[0]?.approved_by, null);
});

test('bookkeeping writes keep an approval, and a re-render voids it', async () => {
  const video = await store.createVideo({ topic: 'Bookkeeping' });
  await store.updateVideo(video.id, { video_path: 'C:/fake/a.mp4' });
  await store.updateVideo(video.id, {
    approved_at: new Date().toISOString(),
    approved_by: 'Priya Reviewer',
  });

  const published = await store.updateVideo(video.id, { status: 'published', privacy_status: 'public' });
  assert.ok(published.approved_at, 'publishing bookkeeping keeps the approval');
  assert.equal(published.approved_by, 'Priya Reviewer');

  const rerendered = await store.updateVideo(video.id, { video_path: 'C:/fake/b.mp4' });
  assert.equal(rerendered.approved_at, null);
  assert.equal(rerendered.approved_by, null);
});

/* -------------------------------------------------------------------------- */
/* Jobs, logs and quota                                                       */
/* -------------------------------------------------------------------------- */

test('render jobs move through queued → active → completed', async () => {
  const video = await store.createVideo({ topic: 'Job lifecycle' });
  const job = await store.createJob(video.id);
  assert.equal(job.status, 'queued');
  assert.equal(job.progress, 0);

  const active = await store.updateJob(job.id, { status: 'active', progress: 40, stage: 'rendering' });
  assert.equal(active.progress, 40);
  assert.equal(active.stage, 'rendering');

  const completed = await store.updateJob(job.id, { status: 'completed', progress: 100 });
  assert.equal(completed.status, 'completed');

  const history = await store.listJobs(video.id, 5);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.id, job.id);
});

test('logs are newest-first and separate per video from unassigned logs', async () => {
  const video = await store.createVideo({ topic: 'Logs' });
  await store.log(video.id, 'step-1', 'success', 'first');
  await store.log(video.id, 'step-2', 'warning', 'second');
  await store.log(null, 'system', 'info', 'unassigned');

  const scoped = await store.listLogs(video.id, 10);
  assert.deepEqual(
    scoped.map((row) => row.step),
    ['step-2', 'step-1'],
  );

  const global = await store.listLogs(null, 10);
  assert.deepEqual(
    global.map((row) => row.step),
    ['system'],
  );
});

test('the upload count uses a real 24-hour window', async () => {
  const recent = new Date().toISOString();
  const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const fresh = await store.createVideo({ topic: 'Fresh upload' });
  await store.updateVideo(fresh.id, {
    youtube_video_id: 'yt-fresh',
    uploaded_at: recent,
    status: 'uploaded',
  });

  const old = await store.createVideo({ topic: 'Old upload' });
  await store.updateVideo(old.id, { youtube_video_id: 'yt-old', uploaded_at: stale, status: 'uploaded' });

  assert.equal(await store.countUploadsToday(), 1);

  await store.updateVideo(fresh.id, { uploaded_at: stale });
  assert.equal(await store.countUploadsToday(), 0);
});

test('caption outcomes are stored on the video and the failure streak is queryable', async () => {
  const uploaded = async (topic: string, uploadedAt: string, captionsUploaded: boolean | null) => {
    const video = await store.createVideo({ topic });
    return store.updateVideo(video.id, {
      youtube_video_id: `yt-${topic}`,
      uploaded_at: uploadedAt,
      status: 'uploaded',
      ...(captionsUploaded === null ? {} : { captions_uploaded: captionsUploaded }),
      caption_error: captionsUploaded === false ? 'captions.insert: forbidden' : null,
    });
  };

  await uploaded('Older upload with captions', '2026-01-01T00:00:00.000Z', true);
  const failed = await uploaded('Failed captions', '2026-01-02T00:00:00.000Z', false);
  // A row from before this was recorded must neither count nor end the streak.
  await uploaded('Legacy upload', '2026-01-03T00:00:00.000Z', null);
  await uploaded('Newest failure', '2026-01-04T00:00:00.000Z', false);

  assert.equal(failed.captions_uploaded, false);
  assert.equal(failed.caption_error, 'captions.insert: forbidden');

  const reloaded = await store.getVideo(failed.id);
  assert.equal(reloaded?.captions_uploaded, false, 'the failure survives a reload');
  assert.equal(reloaded?.caption_error, 'captions.insert: forbidden');

  assert.equal(await store.captionFailureStreak(), 2, 'two failures, with the legacy row skipped');
});

test('listVideos is newest-first and honours the limit', async () => {
  const first = await store.createVideo({ topic: 'Listing one' });
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = await store.createVideo({ topic: 'Listing two' });

  const listed = await store.listVideos(1);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, second.id);
  assert.notEqual(listed[0]?.id, first.id);
});

/* -------------------------------------------------------------------------- */
/* OAuth tokens                                                               */
/* -------------------------------------------------------------------------- */

test('OAuth tokens are upserted into a single row without losing the refresh token', async () => {
  await store.saveTokens({ accessToken: 'access-1', refreshToken: 'refresh-1', channelId: 'chan-1' });
  await store.saveTokens({ accessToken: 'access-2' });

  const tokens = await store.getTokens();
  assert.ok(tokens);
  assert.equal(tokens.access_token, 'access-2');
  assert.equal(tokens.refresh_token, 'refresh-1', 'a missing refresh token keeps the stored one');
  assert.equal(tokens.channel_id, 'chan-1');

  const { rows } = await pool().query<{ count: number }>(
    'SELECT count(*)::int AS count FROM oauth_tokens',
  );
  assert.equal(rows[0]?.count, 1, 'tokens live in one rotating row');
});

test('OAuth tokens are encrypted at rest, and legacy plaintext rows still read', async () => {
  await store.saveTokens({ accessToken: 'secret-access', refreshToken: 'secret-refresh' });

  const { rows } = await pool().query<{ access_token: string; refresh_token: string | null }>(
    'SELECT access_token, refresh_token FROM oauth_tokens',
  );
  const stored = rows[0]!;
  assert.match(stored.access_token, /^enc:v1:/, 'the access token is encrypted in the column');
  assert.match(stored.refresh_token ?? '', /^enc:v1:/, 'the refresh token is encrypted in the column');
  assert.doesNotMatch(stored.access_token, /secret-access/);
  assert.doesNotMatch(stored.refresh_token ?? '', /secret-refresh/);

  const decrypted = await store.getTokens();
  assert.equal(decrypted?.access_token, 'secret-access', 'the store returns plaintext to callers');
  assert.equal(decrypted?.refresh_token, 'secret-refresh');

  // A row written before encryption existed has no `enc:v1:` prefix and must keep working, so adding
  // a key does not force a reconnect.
  await pool().query(
    "UPDATE oauth_tokens SET access_token = 'legacy-access', refresh_token = 'legacy-refresh'",
  );
  const legacy = await store.getTokens();
  assert.equal(legacy?.access_token, 'legacy-access');
  assert.equal(legacy?.refresh_token, 'legacy-refresh');
});

/* -------------------------------------------------------------------------- */
/* Startup reconciliation                                                     */
/* -------------------------------------------------------------------------- */

test('listUnfinishedJobs returns only jobs that stopped heartbeating', async () => {
  const staleVideo = await store.createVideo({ topic: 'Stale job on Postgres' });
  const busyVideo = await store.createVideo({ topic: 'Live job on Postgres' });

  // The updated_at trigger only fires on UPDATE, so an INSERT can backdate the heartbeat.
  const stale = await pool().query<{ id: string }>(
    `INSERT INTO render_jobs (video_id, status, progress, stage, updated_at)
     VALUES ($1, 'active', 50, 'clip 2/4', now() - interval '2 hours')
     RETURNING id`,
    [staleVideo.id],
  );
  const live = await store.createJob(busyVideo.id);
  const done = await pool().query<{ id: string }>(
    `INSERT INTO render_jobs (video_id, status, progress, stage, updated_at)
     VALUES ($1, 'completed', 100, 'completed', now() - interval '2 hours')
     RETURNING id`,
    [busyVideo.id],
  );

  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const rows = await store.listUnfinishedJobs(cutoff);
  const ids = rows.map((row) => row.id);

  assert.deepEqual(ids, [stale.rows[0]!.id], 'only the stale unfinished job is reclaimed');
  assert.ok(!ids.includes(live.id), 'a job inside the timeout is left for the worker');
  assert.ok(!ids.includes(done.rows[0]!.id), 'finished jobs are never revisited');
});

test('concurrent upload claims never exceed the daily limit on Postgres', async () => {
  const videos = await Promise.all(
    Array.from({ length: 5 }, (_, index) => store.createVideo({ topic: `Claim race ${index}` })),
  );

  // Without pg_advisory_xact_lock every claim could read the same "slots left" count.
  const claims = await Promise.all(
    videos.map((video) => store.claimUploadSlot(video.id, { limit: 3 })),
  );

  assert.equal(claims.filter((claim) => claim.status === 'claimed').length, 3);
  assert.equal(claims.filter((claim) => claim.status === 'quota_exhausted').length, 2);
  assert.equal(await store.countUploadsToday(), 3);

  const claimed = claims.find((claim) => claim.status === 'claimed');
  assert.ok(claimed && claimed.status === 'claimed');
  await store.releaseUploadSlot(claimed.video.id, claimed.reservedAt);
  assert.equal(await store.countUploadsToday(), 2, 'a released reservation does not count');
});

test('an abandoned upload reservation is found and released on Postgres', async () => {
  const abandoned = await store.createVideo({ topic: 'Abandoned reservation' });
  const reserved = await pool().query<{ uploaded_at: string }>(
    `UPDATE videos SET uploaded_at = now() - interval '1 hour' WHERE id = $1 RETURNING uploaded_at`,
    [abandoned.id],
  );

  const uploaded = await store.createVideo({ topic: 'Completed upload' });
  await store.updateVideo(uploaded.id, {
    youtube_video_id: 'yt-keep-this',
    status: 'uploaded',
    uploaded_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });

  const cutoff = new Date(Date.now() - UPLOAD_CLAIM_TIMEOUT_MS).toISOString();
  const stale = await store.listStaleUploadReservations(cutoff);
  assert.deepEqual(stale.map((row) => row.id), [abandoned.id], 'only the abandoned reservation matches');

  await store.releaseUploadSlot(abandoned.id, reserved.rows[0]!.uploaded_at);
  assert.equal((await store.getVideo(abandoned.id))?.uploaded_at, null);
  assert.equal(await store.countUploadsToday(), 1, 'the released slot no longer counts');
  assert.ok((await store.getVideo(uploaded.id))?.uploaded_at, 'a completed upload keeps its slot');
});

test('pipeline runs are recorded and the advisory lock is exclusive', async () => {
  const run = await store.startPipelineRun({ trigger: 'schedule', niche: 'finance' });
  assert.equal(run.status, 'running');
  assert.equal(run.trigger, 'schedule', 'the trigger comes back from the trigger_kind column');
  assert.equal(run.finished_at, null);

  const finished = await store.finishPipelineRun(run.id, { status: 'completed' });
  assert.equal(finished.status, 'completed');
  assert.ok(finished.finished_at);
  assert.equal((await store.latestPipelineRun())?.id, run.id);
  assert.equal(
    (await store.latestCompletedPipelineRun())?.id,
    run.id,
    'the newest completed run is what the silence check reads',
  );

  const release = await store.acquirePipelineLock();
  assert.ok(release, 'the first holder gets the lock');
  assert.equal(await store.acquirePipelineLock(), null, 'a second session cannot hold it');

  await release();
  const again = await store.acquirePipelineLock();
  assert.ok(again, 'releasing frees the lock for the next run');
  await again?.();
});

test('listStalePipelineRuns returns only running rows older than the cutoff', async () => {
  const running = await store.startPipelineRun({ trigger: 'boot' });
  const finished = await store.startPipelineRun({ trigger: 'schedule' });
  await store.finishPipelineRun(finished.id, { status: 'completed' });

  const stale = await store.listStalePipelineRuns(new Date(Date.now() + 60 * 60 * 1000).toISOString());
  assert.deepEqual(
    stale.map((row) => row.id),
    [running.id],
    'a closed run is never swept, whatever its start time',
  );

  const fresh = await store.listStalePipelineRuns(new Date(Date.now() - 60 * 60 * 1000).toISOString());
  assert.equal(fresh.length, 0, 'a run inside the window is left alone');

  await store.finishPipelineRun(running.id, { status: 'failed', error: 'closed by the test' });
});

/* -------------------------------------------------------------------------- */
/* HTTP routes on top of PgStore                                              */
/* -------------------------------------------------------------------------- */

test('the approve route writes approved_by through PgStore', async () => {
  const video = await store.createVideo({ topic: 'HTTP approval on Postgres' });
  await store.updateVideo(video.id, {
    video_path: 'C:/fake/rendered.mp4',
    youtube_video_id: 'yt-pg-approval',
    privacy_status: 'private',
    status: 'uploaded',
    uploaded_at: new Date().toISOString(),
  });

  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { token: 'test-token', name: 'Priya Reviewer' },
  });
  assert.equal(login.statusCode, 200);
  const setCookie = login.headers['set-cookie'];
  const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof rawCookie !== 'string') throw new Error('login must set a session cookie');
  const cookie = rawCookie.split(';')[0]!;

  const approved = await app.inject({
    method: 'POST',
    url: `/api/videos/${video.id}/approve`,
    headers: { cookie },
    payload: { approved: true },
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().video.approved_by, 'Priya Reviewer');

  const stored = await pool().query<{ approved_by: string | null; approved_at: string | null }>(
    'SELECT approved_by, approved_at FROM videos WHERE id = $1',
    [video.id],
  );
  assert.equal(stored.rows[0]?.approved_by, 'Priya Reviewer');
  assert.ok(stored.rows[0]?.approved_at);

  const logs = await store.listLogs(video.id, 10);
  assert.ok(
    logs.some((row) => row.message?.includes('Priya Reviewer')),
    'the approval log names the approver',
  );
});
