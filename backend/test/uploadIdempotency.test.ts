import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { paths } from '../src/config.js';
import { closeStore, getStore, initStore } from '../src/db/index.js';
import { buildServer } from '../src/server.js';

/**
 * POST /api/upload must be idempotent. With no YouTube credentials configured the upload itself
 * fails at the auth step, which is exactly what these tests exploit: the request has to be stopped
 * (or its quota reservation released) before any YouTube call could create a video.
 */

let app: FastifyInstance;
const fixtureFiles: string[] = [];

const AUTH = { authorization: 'Bearer test-token' };

before(async () => {
  const store = await initStore();
  assert.equal(store.mode, 'memory', 'tests must run against the in-memory store');
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app.close();
  await closeStore();
  for (const file of fixtureFiles) fs.rmSync(file, { force: true });
});

async function makeVideo(topic = 'Upload guard test') {
  // A real file so the route gets past the "MP4 is missing" check and reaches the YouTube client.
  const filePath = path.join(paths.temp, `upload-fixture-${randomUUID()}.mp4`);
  fs.writeFileSync(filePath, Buffer.alloc(2048));
  fixtureFiles.push(filePath);

  const store = getStore();
  const video = await store.createVideo({ topic });
  return store.updateVideo(video.id, { video_path: filePath, seo_title: 'Upload guard test' });
}

const upload = (videoId: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/api/upload', headers: AUTH, payload: { videoId, ...payload } });

test('a video that already has a YouTube id is not uploaded twice', async () => {
  const store = getStore();
  const video = await makeVideo('Already on YouTube');
  await store.updateVideo(video.id, {
    youtube_video_id: 'yt-already-there',
    privacy_status: 'private',
    status: 'uploaded',
    uploaded_at: new Date().toISOString(),
  });
  const usedBefore = await store.countUploadsToday();

  const response = await upload(video.id, { confirm: true, privacyStatus: 'private' });

  assert.equal(response.statusCode, 409, JSON.stringify(response.json()));
  assert.match(response.json().error, /already uploaded as yt-already-there/i);
  assert.match(response.json().error, /"replace": true/);
  assert.equal(await store.countUploadsToday(), usedBefore, 'a duplicate must not burn a quota slot');
  assert.equal((await store.getVideo(video.id))?.youtube_video_id, 'yt-already-there');
});

test('a second request while an upload is in flight is refused', async () => {
  const store = getStore();
  const video = await makeVideo('Currently uploading');
  // What a live reservation from another process looks like: a fresh uploaded_at, no YouTube id.
  await store.updateVideo(video.id, { uploaded_at: new Date().toISOString() });
  const usedBefore = await store.countUploadsToday();

  const response = await upload(video.id, { confirm: true });

  assert.equal(response.statusCode, 409, JSON.stringify(response.json()));
  assert.match(response.json().error, /already in progress/i);
  assert.equal(await store.countUploadsToday(), usedBefore);
});

test('replace: true is the deliberate path past the duplicate guard', async () => {
  const store = getStore();
  const video = await makeVideo('Deliberate replacement');
  await store.updateVideo(video.id, {
    youtube_video_id: 'yt-old-version',
    status: 'uploaded',
    uploaded_at: new Date().toISOString(),
  });

  const response = await upload(video.id, { confirm: true, replace: true });

  // Reaching the YouTube client proves the duplicate guard was passed; it fails only because this
  // test environment has no connected channel.
  assert.notEqual(response.statusCode, 409);
  assert.equal(response.statusCode, 401, JSON.stringify(response.json()));
  assert.match(response.json().error, /not connected|authorization/i);
  assert.equal((await store.getVideo(video.id))?.youtube_video_id, 'yt-old-version');
});

test('a failed upload releases its quota reservation', async () => {
  const store = getStore();
  const video = await makeVideo('Failed upload');
  const usedBefore = await store.countUploadsToday();

  const response = await upload(video.id, { confirm: true });

  assert.equal(response.statusCode, 401, 'no channel is connected in tests');
  const stored = await store.getVideo(video.id);
  assert.equal(stored?.uploaded_at, null, 'the reservation must be given back');
  assert.equal(await store.countUploadsToday(), usedBefore, 'a failed insert does not cost a slot');
});

test('the route answers 429 when the daily quota is exhausted', async () => {
  const store = getStore();
  const used = await store.countUploadsToday();
  for (let index = used; index < 6; index += 1) {
    const filler = await store.createVideo({ topic: `Quota filler ${index}` });
    await store.updateVideo(filler.id, {
      youtube_video_id: `yt-filler-${index}`,
      status: 'uploaded',
      uploaded_at: new Date().toISOString(),
    });
  }
  assert.equal(await store.countUploadsToday(), 6);

  const video = await makeVideo('Over quota');
  const response = await upload(video.id, { confirm: true });

  assert.equal(response.statusCode, 429, JSON.stringify(response.json()));
  assert.match(response.json().error, /quota guard reached/i);
  assert.equal((await store.getVideo(video.id))?.uploaded_at, null, 'no slot was taken');
});
