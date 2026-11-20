import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { closeStore, getStore, initStore } from '../src/db/index.js';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;

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

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') throw new Error('login must set a session cookie');
  const value = raw.split(';')[0]!;
  assert.match(value, /^yt_session=/);
  return value;
}

async function makeUploadedVideo() {
  const store = getStore();
  const video = await store.createVideo({ topic: 'Auth gate test' });
  return store.updateVideo(video.id, {
    video_path: 'C:/fake/rendered.mp4',
    seo_title: 'Test title',
    youtube_video_id: 'yt-auth-test',
    privacy_status: 'private',
    status: 'uploaded' as const,
    uploaded_at: new Date().toISOString(),
  });
}

test('health and session status stay public', async () => {
  const health = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);

  const session = await app.inject({ method: 'GET', url: '/api/session' });
  assert.equal(session.statusCode, 200);
  assert.deepEqual(session.json(), { authenticated: false, approver: null });
});

test('every other API route rejects an anonymous caller', async () => {
  const calls = [
    { method: 'GET' as const, url: '/api/videos' },
    { method: 'GET' as const, url: '/api/youtube/status' },
    { method: 'POST' as const, url: '/api/videos', payload: { topic: 'Anyone can post' } },
    { method: 'POST' as const, url: '/api/youtube/publish/whatever', payload: { confirm: true } },
  ];

  for (const call of calls) {
    const response = await app.inject(call);
    assert.equal(response.statusCode, 401, `${call.method} ${call.url} must require a session`);
    assert.match(response.json().error, /sign in/i);
  }
});

test('a bearer token authenticates scripts and a wrong token does not', async () => {
  const ok = await app.inject({
    method: 'GET',
    url: '/api/videos',
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(ok.statusCode, 200);
  assert.ok(Array.isArray(ok.json().videos));

  const wrong = await app.inject({
    method: 'GET',
    url: '/api/videos',
    headers: { authorization: 'Bearer not-the-token' },
  });
  assert.equal(wrong.statusCode, 401);
});

test('login rejects a bad token and accepts the real one', async () => {
  const rejected = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { token: 'nope', name: 'Mallory' },
  });
  assert.equal(rejected.statusCode, 401);

  const accepted = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { token: 'test-token', name: 'Priya Reviewer' },
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().approver, 'Priya Reviewer');

  const cookie = sessionCookie(accepted);
  const videos = await app.inject({ method: 'GET', url: '/api/videos', headers: { cookie } });
  assert.equal(videos.statusCode, 200, 'the signed cookie must authenticate the browser');
});

test('a tampered session cookie is rejected', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { token: 'test-token', name: 'Priya Reviewer' },
  });
  const cookie = sessionCookie(login);
  const [name, value] = cookie.split('=');
  const [payload, signature] = value!.split('.');
  // Re-sign nothing: flip one character of the signature.
  const flipped = `${payload}.${signature!.slice(0, -1)}${signature!.slice(-1) === 'A' ? 'B' : 'A'}`;

  const response = await app.inject({
    method: 'GET',
    url: '/api/videos',
    headers: { cookie: `${name}=${flipped}` },
  });
  assert.equal(response.statusCode, 401);

  const forged = await app.inject({
    method: 'GET',
    url: '/api/videos',
    headers: { cookie: `${name}=${Buffer.from('{"name":"Mallory","exp":9999999999999}').toString('base64url')}.abc` },
  });
  assert.equal(forged.statusCode, 401, 'an unsigned payload must never be trusted');
});

test('approval records who approved the video', async () => {
  const video = await makeUploadedVideo();
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { token: 'test-token', name: 'Priya Reviewer' },
  });
  const cookie = sessionCookie(login);

  const response = await app.inject({
    method: 'POST',
    url: `/api/videos/${video.id}/approve`,
    headers: { cookie },
    payload: { approved: true },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().video.approved_by, 'Priya Reviewer');
  assert.ok(response.json().video.approved_at);

  const stored = await getStore().getVideo(video.id);
  assert.equal(stored?.approved_by, 'Priya Reviewer', 'the approver is persisted, not just echoed');
});

test('editing approved content clears the approver along with the approval', async () => {
  const video = await makeUploadedVideo();
  await app.inject({
    method: 'POST',
    url: `/api/videos/${video.id}/approve`,
    headers: { authorization: 'Bearer test-token' },
    payload: { approved: true },
  });

  const edited = await app.inject({
    method: 'PATCH',
    url: `/api/videos/${video.id}`,
    headers: { authorization: 'Bearer test-token' },
    payload: { seoTitle: 'A different title' },
  });

  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json().video.approved_at, null);
  assert.equal(edited.json().video.approved_by, null);
});
