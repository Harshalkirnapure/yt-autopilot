import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { config } from '../src/config.js';
import { closeStore, getStore, initStore } from '../src/db/index.js';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;

/** Mutating routes are authenticated; scripts use the bearer token. */
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
});

function setAuditPassed(value: boolean): void {
  (config as unknown as { ytAuditPassed: boolean }).ytAuditPassed = value;
}

async function makeVideo(options: { uploaded?: boolean; approved?: boolean } = {}) {
  const store = getStore();
  const video = await store.createVideo({ topic: 'Publish gate test' });

  return store.updateVideo(video.id, {
    video_path: 'C:/fake/rendered.mp4',
    seo_title: 'Test title',
    ...(options.uploaded
      ? {
          youtube_video_id: 'yt-gate-test',
          privacy_status: 'private',
          status: 'uploaded' as const,
          uploaded_at: new Date().toISOString(),
        }
      : {}),
    ...(options.approved ? { approved_at: new Date().toISOString() } : {}),
  });
}

const publish = (videoId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/youtube/publish/${videoId}`, headers: AUTH, payload });

test('publishing requires an explicit confirm flag', async () => {
  const video = await makeVideo({ uploaded: true, approved: true });
  const response = await publish(video.id, {});

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /confirm/i);
});

test('publishing is rejected for a video that was never uploaded', async () => {
  const video = await makeVideo();
  const response = await publish(video.id, { confirm: true });

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /upload/i);
});

test('publishing an uploaded video fails without human approval', async () => {
  setAuditPassed(true);
  const video = await makeVideo({ uploaded: true });
  const response = await publish(video.id, { confirm: true });

  assert.equal(response.statusCode, 403);
  assert.match(response.json().error, /approve/i);
});

test('publishing an approved video fails without a passed compliance audit', async () => {
  setAuditPassed(false);
  const video = await makeVideo({ uploaded: true, approved: true });
  const response = await publish(video.id, { confirm: true });

  assert.equal(response.statusCode, 403);
  assert.match(response.json().error, /audit/i);
});

test('recording approval requires an uploaded video first', async () => {
  const video = await makeVideo();
  const response = await app.inject({
    method: 'POST',
    url: `/api/videos/${video.id}/approve`,
    headers: AUTH,
    payload: { approved: true },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /upload/i);
});

test('editing the approved metadata voids the approval', async () => {
  const video = await makeVideo({ uploaded: true, approved: true });
  assert.ok(video.approved_at, 'fixture must start approved');

  const response = await app.inject({
    method: 'PATCH',
    url: `/api/videos/${video.id}`,
    headers: AUTH,
    payload: { seoTitle: 'A title the reviewer never saw' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().video.seo_title, 'A title the reviewer never saw');
  assert.equal(response.json().video.approved_at, null, 'approval must be cleared on content edits');
});

test('an empty PATCH keeps an existing approval', async () => {
  const video = await makeVideo({ uploaded: true, approved: true });
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/videos/${video.id}`,
    headers: AUTH,
    payload: {},
  });

  assert.equal(response.statusCode, 200);
  assert.ok(response.json().video.approved_at, 'no content changed, so the approval still stands');
});

test('the store enforces the approval rule for every writer', async () => {
  const store = getStore();
  const video = await makeVideo({ uploaded: true, approved: true });

  const bookkeeping = await store.updateVideo(video.id, { privacy_status: 'public', status: 'published' });
  assert.ok(bookkeeping.approved_at, 'publishing bookkeeping must keep the approval');

  const rerendered = await store.updateVideo(video.id, { video_path: 'C:/fake/new.mp4' });
  assert.equal(rerendered.approved_at, null, 'a new render clears the approval');

  await store.updateVideo(video.id, { approved_at: new Date().toISOString() });
  const revoiced = await store.updateVideo(video.id, { audio_path: 'C:/fake/new.mp3' });
  assert.equal(revoiced.approved_at, null, 'a new voiceover clears the approval');
});

test('uploading requires an explicit confirm flag', async () => {
  const video = await makeVideo();
  const response = await app.inject({
    method: 'POST',
    url: '/api/upload',
    headers: AUTH,
    payload: { videoId: video.id, privacyStatus: 'private' },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /confirm/i);
});
