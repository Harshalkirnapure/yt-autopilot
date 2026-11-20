import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../src/config.js';
import { closeStore, getStore, initStore } from '../src/db/index.js';
import { uploadQuota, uploadToYouTube } from '../src/services/youtube.js';

const DAY_MS = 24 * 60 * 60 * 1000;

before(async () => {
  const store = await initStore();
  assert.equal(store.mode, 'memory', 'tests must run against the in-memory store');
});

after(async () => {
  await closeStore();
});

test('the quota counts only uploads from the last 24 hours and blocks videos.insert', async () => {
  const store = getStore();
  const recent = new Date().toISOString();
  const stale = new Date(Date.now() - 2 * DAY_MS).toISOString();
  const uploadedIds: string[] = [];

  for (let index = 0; index < 6; index += 1) {
    const video = await store.createVideo({ topic: `Quota test ${index}` });
    await store.updateVideo(video.id, {
      youtube_video_id: `yt-quota-${index}`,
      uploaded_at: recent,
      status: 'uploaded',
    });
    uploadedIds.push(video.id);
  }

  // An upload older than the rolling window must not count against today's quota.
  const oldVideo = await store.createVideo({ topic: 'Quota test stale' });
  await store.updateVideo(oldVideo.id, {
    youtube_video_id: 'yt-quota-stale',
    uploaded_at: stale,
    status: 'uploaded',
  });

  const quota = await uploadQuota();
  assert.equal(quota.used, 6);
  assert.equal(quota.limit, 6);
  assert.equal(quota.remaining, 0);

  const filePath = path.join(paths.temp, 'quota-test.mp4');
  fs.writeFileSync(filePath, Buffer.alloc(1024));

  try {
    await assert.rejects(
      () =>
        uploadToYouTube({
          filePath,
          title: 'Quota test',
          description: 'Blocked by the daily upload guard.',
          tags: [],
          privacyStatus: 'private',
        }),
      /quota guard reached/i,
      'an exhausted quota must stop the upload before any YouTube API call',
    );
  } finally {
    fs.rmSync(filePath, { force: true });
  }

  // Age one upload out of the window: a slot becomes available again.
  await store.updateVideo(uploadedIds[0]!, { uploaded_at: stale });

  const afterAging = await uploadQuota();
  assert.equal(afterAging.used, 5);
  assert.equal(afterAging.remaining, 1);
});
