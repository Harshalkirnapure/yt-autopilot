import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeStore, getStore, initStore } from '../src/db/index.js';
import { UPLOAD_CLAIM_TIMEOUT_MS } from '../src/db/types.js';

/**
 * Store-level quota reservations. The upload route relies on `claimUploadSlot` being the single
 * atomic decision point: duplicate, in-flight and quota are all answered by one call, so concurrent
 * requests cannot both take the last slot of the day.
 */

before(async () => {
  const store = await initStore();
  assert.equal(store.mode, 'memory', 'tests must run against the in-memory store');
});

after(async () => {
  await closeStore();
});

test('concurrent claims never hand out more slots than the daily limit', async () => {
  const store = getStore();
  const videos = await Promise.all(
    Array.from({ length: 10 }, (_, index) => store.createVideo({ topic: `Concurrent upload ${index}` })),
  );

  const claims = await Promise.all(
    videos.map((video) => store.claimUploadSlot(video.id, { limit: 6 })),
  );

  assert.equal(claims.filter((claim) => claim.status === 'claimed').length, 6, 'exactly the limit wins');
  assert.equal(claims.filter((claim) => claim.status === 'quota_exhausted').length, 4);
  assert.equal(await store.countUploadsToday(), 6, 'reservations are counted immediately');
});

test('a second claim for the same video reports the upload in progress', async () => {
  const store = getStore();
  const video = await store.createVideo({ topic: 'Double click' });
  const usedBefore = await store.countUploadsToday();

  const first = await store.claimUploadSlot(video.id, { limit: 50 });
  assert.equal(first.status, 'claimed');
  assert.equal(await store.countUploadsToday(), usedBefore + 1);

  const second = await store.claimUploadSlot(video.id, { limit: 50 });
  assert.equal(second.status, 'in_progress');
  assert.equal(await store.countUploadsToday(), usedBefore + 1, 'the second click must not reserve another slot');
});

test('an abandoned claim stops blocking after the in-flight window', async () => {
  const store = getStore();
  const video = await store.createVideo({ topic: 'Abandoned upload' });
  const claimedAt = new Date();

  assert.equal((await store.claimUploadSlot(video.id, { limit: 50, now: claimedAt })).status, 'claimed');

  const later = new Date(claimedAt.getTime() + UPLOAD_CLAIM_TIMEOUT_MS + 1000);
  const retried = await store.claimUploadSlot(video.id, { limit: 50, now: later });
  assert.equal(retried.status, 'claimed', 'a crashed upload may be retried after the window');
});

test('releasing a failed claim frees the slot and only that reservation', async () => {
  const store = getStore();
  const video = await store.createVideo({ topic: 'Release me' });

  const claim = await store.claimUploadSlot(video.id, { limit: 50 });
  assert.equal(claim.status, 'claimed');
  const reservedAt = claim.status === 'claimed' ? claim.reservedAt : '';
  const before = await store.countUploadsToday();

  await store.releaseUploadSlot(video.id, 'not-the-reservation');
  assert.equal(await store.countUploadsToday(), before, 'a mismatched reservation is ignored');

  await store.releaseUploadSlot(video.id, reservedAt);
  assert.equal(await store.countUploadsToday(), before - 1);
  assert.equal((await store.getVideo(video.id))?.uploaded_at, null);

  const again = await store.claimUploadSlot(video.id, { limit: 50 });
  assert.equal(again.status, 'claimed', 'the freed slot can be used again');
});

test('an uploaded video is never uploaded again without replace', async () => {
  const store = getStore();
  const video = await store.createVideo({ topic: 'Already uploaded' });
  await store.updateVideo(video.id, {
    youtube_video_id: 'yt-existing',
    uploaded_at: new Date().toISOString(),
    status: 'uploaded',
  });

  const blocked = await store.claimUploadSlot(video.id, { limit: 50 });
  assert.deepEqual(blocked, { status: 'already_uploaded', youtubeVideoId: 'yt-existing' });

  const replaced = await store.claimUploadSlot(video.id, { limit: 50, replace: true });
  assert.equal(replaced.status, 'claimed', 'replace is the deliberate way to upload again');
});
