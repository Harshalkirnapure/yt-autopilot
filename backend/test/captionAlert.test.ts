import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { closeStore, initStore } from '../src/db/index.js';
import type { Store } from '../src/db/types.js';
import { alertOnCaptionFailureStreak } from '../src/services/alerts.js';

/**
 * The caption track is best-effort: a rejected track leaves the video uploaded and publishable, so a
 * regression would only show up as YouTube auto-captions. These tests cover the streak the alert is
 * based on and the alert itself (no Telegram in the test runner, so each alert lands in job_logs).
 */

let store: Store;

before(async () => {
  store = await initStore();
  assert.equal(store.mode, 'memory', 'tests must run against the in-memory store');
});

beforeEach(async () => {
  // The streak is computed over every uploaded row, so each test starts from an empty store.
  await closeStore();
  store = await initStore();
});

after(async () => {
  await closeStore();
});

async function uploadedVideo(
  uploadedAt: string,
  captionsUploaded: boolean | null,
  captionError: string | null = null,
) {
  const video = await store.createVideo({ topic: `Caption outcome at ${uploadedAt}` });
  return store.updateVideo(video.id, {
    youtube_video_id: `yt-${video.id}`,
    uploaded_at: uploadedAt,
    status: 'uploaded',
    ...(captionsUploaded === null ? {} : { captions_uploaded: captionsUploaded }),
    caption_error: captionsUploaded === false ? (captionError ?? 'captions.insert rejected') : null,
  });
}

test('the streak counts consecutive uploads without a caption track, newest first', async () => {
  await uploadedVideo('2026-01-01T00:00:00.000Z', true);
  await uploadedVideo('2026-01-02T00:00:00.000Z', false);
  await uploadedVideo('2026-01-03T00:00:00.000Z', false);

  assert.equal(await store.captionFailureStreak(), 2);
});

test('an accepted track ends the streak', async () => {
  await uploadedVideo('2026-01-01T00:00:00.000Z', false);
  await uploadedVideo('2026-01-02T00:00:00.000Z', true);
  await uploadedVideo('2026-01-03T00:00:00.000Z', false);

  assert.equal(await store.captionFailureStreak(), 1);
});

test('uploads from before the outcome was recorded are skipped, not counted as failures', async () => {
  await uploadedVideo('2026-01-01T00:00:00.000Z', true);
  await uploadedVideo('2026-01-02T00:00:00.000Z', null);
  await uploadedVideo('2026-01-03T00:00:00.000Z', false);

  assert.equal(await store.captionFailureStreak(), 1);
});

test('drafts that were never uploaded do not count', async () => {
  await store.createVideo({ topic: 'Never uploaded' });
  assert.equal(await store.captionFailureStreak(), 0);
});

test('the alert fires at the threshold and each multiple, not on every failing upload', async () => {
  assert.equal(config.captionFailureAlertThreshold, 3, 'the default threshold');

  const alerts = async () => (await store.listLogs(null, 50)).filter((row) => row.step === 'alert');

  assert.equal(await alertOnCaptionFailureStreak(1, 'boom'), false);
  assert.equal(await alertOnCaptionFailureStreak(2, 'boom'), false);
  assert.equal((await alerts()).length, 0, 'one or two failures are noise, not an alert');

  assert.equal(
    await alertOnCaptionFailureStreak(3, 'captions.insert: The language is not supported'),
    true,
  );

  const raised = await alerts();
  assert.equal(raised.length, 1);
  assert.equal(raised[0]?.status, 'warning');
  assert.equal(raised[0]?.video_id, null, 'the alert is channel-level, not tied to one video');
  assert.match(raised[0]?.message ?? '', /3 uploads in a row went out without a caption track/);
  assert.match(raised[0]?.message ?? '', /The language is not supported/, 'the last error is included');

  assert.equal(await alertOnCaptionFailureStreak(4, 'still failing'), false);
  assert.equal((await alerts()).length, 1, 'a steady failure streak does not alert every upload');

  assert.equal(await alertOnCaptionFailureStreak(6, 'still failing'), true);
  assert.equal((await alerts()).length, 2, 'the next multiple reminds the admin');
});

test('an alert without an error message still says what happened', async () => {
  assert.equal(await alertOnCaptionFailureStreak(3, null), true);

  const [alert] = (await store.listLogs(null, 20)).filter((row) => row.step === 'alert');
  assert.match(alert?.message ?? '', /rejected the caption track without a message/);
});
