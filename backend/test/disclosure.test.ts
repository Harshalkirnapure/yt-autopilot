import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { config } from '../src/config.js';
import { closeStore, initStore } from '../src/db/index.js';
import { buildServer } from '../src/server.js';
import { videoStatusPayload } from '../src/services/youtube.js';

/**
 * YouTube requires realistic Altered/Synthetic (A/S) content to be disclosed through
 * `status.containsSyntheticMedia` on videos.insert / videos.update. The narration here is
 * synthesised, so the upload must declare it — and the reviewer must be able to see that it does.
 */

let app: FastifyInstance;

function setDisclosure(value: boolean): void {
  (config as unknown as { ytDiscloseSyntheticMedia: boolean }).ytDiscloseSyntheticMedia = value;
}

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

test('every upload status declares altered/synthetic media by default', () => {
  assert.deepEqual(videoStatusPayload('private', { embeddable: true }), {
    privacyStatus: 'private',
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: true,
    embeddable: true,
  });

  // Publishing sends no `embeddable`, but must keep the disclosure.
  assert.deepEqual(videoStatusPayload('public'), {
    privacyStatus: 'public',
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: true,
  });
  assert.deepEqual(videoStatusPayload('unlisted'), {
    privacyStatus: 'unlisted',
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: true,
  });
});

test('the disclosure follows YT_DISCLOSE_SYNTHETIC_MEDIA', () => {
  try {
    setDisclosure(false);
    assert.equal(videoStatusPayload('private').containsSyntheticMedia, false);
  } finally {
    setDisclosure(true);
  }

  assert.equal(videoStatusPayload('private').containsSyntheticMedia, true);
});

test('the review step can see whether the disclosure is on', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/youtube/status',
    headers: { authorization: 'Bearer test-token' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().syntheticMediaDisclosure, true);
});
