import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeStore, getStore, initStore } from '../src/db/index.js';
import { runDaily, type PipelineTrigger } from '../src/services/pipeline.js';
import { catchUpScheduledRun } from '../src/services/scheduler.js';
import { buildServer } from '../src/server.js';

/**
 * Scheduled runs need two things a bare cron tick cannot give: a record of what ran (so a restart
 * can tell whether the day was missed) and mutual exclusion (so two instances cannot both generate
 * a video). These tests use the memory store; `runDaily` is kept away from Gemini/Edge TTS by the
 * 20-hour rule and by the lock, so no API keys are needed.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

before(async () => {
  const store = await initStore();
  assert.equal(store.mode, 'memory', 'tests must run against the in-memory store');
});

after(async () => {
  await closeStore();
});

test('the pipeline lock admits exactly one holder at a time', async () => {
  const store = getStore();

  const release = await store.acquirePipelineLock();
  assert.ok(release, 'the first run takes the lock');
  assert.equal(await store.acquirePipelineLock(), null, 'a second run is refused');

  await release();
  const again = await store.acquirePipelineLock();
  assert.ok(again, 'the lock is free again after the run finishes');
  await again?.();
});

test('a skipped run is recorded in the ledger with its trigger and reason', async () => {
  const store = getStore();
  const recent = await store.createVideo({ topic: 'Draft from an hour ago' });

  // The 20-hour rule returns before any Gemini/TTS call, so this needs no credentials.
  const result = await runDaily({ trigger: 'boot' });
  assert.equal(result.status, 'skipped');
  assert.match(result.reason ?? '', /last 20 hours/);

  const run = await store.latestPipelineRun();
  assert.ok(run, 'the attempt is in the ledger');
  assert.equal(run.trigger, 'boot');
  assert.equal(run.status, 'skipped');
  assert.equal(run.video_id, recent.id);
  assert.ok(run.finished_at, 'a finished attempt has an end time');
  assert.match(run.reason ?? '', /last 20 hours/);
  assert.doesNotMatch(run.reason ?? '', /Draft from an hour ago/, 'a public reason never carries the topic');
});

test('a run is refused while another run holds the lock, without recording a run', async () => {
  const store = getStore();
  const before = await store.latestPipelineRun();
  assert.ok(before, 'the previous test left a ledger row');

  const release = await store.acquirePipelineLock();
  assert.ok(release);

  const result = await runDaily({ trigger: 'schedule' });
  assert.equal(result.status, 'skipped');
  assert.match(result.reason ?? '', /another pipeline run/i);

  const after = await store.latestPipelineRun();
  assert.equal(after?.id, before.id, 'a refused run must not add a ledger row');

  await release();
});

test('boot catch-up runs once only when the newest run is outside the window', async () => {
  const store = getStore();
  const seeded = await store.startPipelineRun({ trigger: 'schedule' });
  await store.finishPipelineRun(seeded.id, { status: 'completed' });

  const triggers: PipelineTrigger[] = [];
  const run = async (trigger: PipelineTrigger) => {
    triggers.push(trigger);
    return { status: 'started' as const, topic: 'catch-up topic' };
  };

  const notNeeded = await catchUpScheduledRun({ windowMs: DAY_MS, run });
  assert.equal(notNeeded, null, 'a run inside the window means nothing is missing');
  assert.deepEqual(triggers, []);

  const stale = await catchUpScheduledRun({
    now: new Date(Date.now() + 2 * DAY_MS),
    windowMs: DAY_MS,
    run,
  });
  assert.equal(stale?.status, 'started');
  assert.deepEqual(triggers, ['boot'], 'exactly one catch-up run, tagged as a boot run');
});

test('the newest ledger row is visible on /api/health', async () => {
  const store = getStore();
  const run = await store.startPipelineRun({ trigger: 'schedule' });
  await store.finishPipelineRun(run.id, { status: 'skipped', reason: 'Already generated today.' });

  const app = await buildServer();
  await app.ready();
  try {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(response.statusCode, 200);

    const { pipeline } = response.json();
    assert.equal(pipeline.trigger, 'schedule');
    assert.equal(pipeline.status, 'skipped');
    assert.equal(pipeline.reason, 'Already generated today.');
    assert.ok(pipeline.startedAt, 'the start time is reported');
    assert.ok(pipeline.finishedAt, 'the end time is reported');
    assert.deepEqual(
      Object.keys(pipeline).sort(),
      ['finishedAt', 'reason', 'startedAt', 'status', 'trigger'],
      'the public payload carries schedule facts only',
    );
  } finally {
    await app.close();
  }
});

test('a failed ledger insert releases the pipeline lock', async () => {
  const store = getStore();
  const previous = await store.latestPipelineRun();

  const original = store.startPipelineRun;
  let attempts = 0;
  store.startPipelineRun = async () => {
    attempts += 1;
    throw new Error('ledger insert exploded');
  };

  try {
    await assert.rejects(() => runDaily({ trigger: 'manual', force: true }), /ledger insert exploded/);
  } finally {
    store.startPipelineRun = original;
  }

  assert.equal(attempts, 1, 'the run starts by writing its ledger row');
  assert.equal(
    (await store.latestPipelineRun())?.id,
    previous?.id,
    'a run that never started leaves no ledger row',
  );

  // The lock must be free: otherwise every later scheduled run is refused, and in Postgres the
  // pooled connection holding it is never returned.
  const release = await store.acquirePipelineLock();
  assert.ok(release, 'the lock is released when the ledger insert fails');
  await release();
});

test('catch-up treats a fresh ledger with no completed run as a missed schedule', async () => {
  const store = getStore();
  // Latest row is still "running" from the interrupted attempt; it is old enough to be ignored.
  const stale = await store.startPipelineRun({ trigger: 'boot' });

  const triggers: PipelineTrigger[] = [];
  await catchUpScheduledRun({
    now: new Date(Date.parse(stale.started_at) + 3 * DAY_MS),
    windowMs: DAY_MS,
    run: async (trigger) => {
      triggers.push(trigger);
      return { status: 'started' as const };
    },
  });

  assert.deepEqual(triggers, ['boot']);
});
