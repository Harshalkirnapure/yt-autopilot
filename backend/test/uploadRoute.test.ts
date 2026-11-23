import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { youtube_v3 } from 'googleapis';
import { paths } from '../src/config.js';
import { closeStore, getStore, initStore } from '../src/db/index.js';
import { buildServer } from '../src/server.js';

/**
 * Route-level coverage for the caption outcome. POST /api/upload is driven through the real Fastify
 * app and the real route, with only the YouTube client stubbed (the uploadToYouTube seam), so the
 * persistence, the response body and the streak alert are exercised together rather than in pieces.
 */

/** Mutating routes are authenticated; scripts use the bearer token. */
const AUTH = { authorization: 'Bearer test-token' };

/** Read by the stub at call time, so each test decides whether the track is accepted. */
let captionError: Error | null = null;
const captionVideoIds: string[] = [];

let app: FastifyInstance;
const fixtureFiles: string[] = [];

function stubYoutube(): youtube_v3.Youtube {
  return {
    videos: {
      insert: async () => ({ data: { id: 'yt-route-video' } }),
    },
    captions: {
      insert: async (params: youtube_v3.Params$Resource$Captions$Insert) => {
        // Drain inside the call, like the real client: the route destroys the stream once this
        // resolves, so the bytes must be read here.
        const body = params.media?.body as Readable | undefined;
        if (body) await streamText(body);
        captionVideoIds.push(params.requestBody?.snippet?.videoId ?? '');
        if (captionError) throw captionError;
        return { data: {} };
      },
    },
  } as unknown as youtube_v3.Youtube;
}

function streamText(stream: Readable): Promise<string> {
  // Event-based on purpose: an async iterator installs an `end-of-stream` listener that turns the
  // caller's later `destroy()` into an unhandled ERR_STREAM_PREMATURE_CLOSE.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

before(async () => {
  const store = await initStore();
  assert.equal(store.mode, 'memory', 'tests must run against the in-memory store');
  app = await buildServer({ uploadDependencies: { youtube: stubYoutube() } });
  await app.ready();
});

beforeEach(async () => {
  // A fresh store per test keeps the caption-failure streak and the daily quota independent.
  await closeStore();
  const store = await initStore();
  assert.equal(store.mode, 'memory', 'tests must run against the in-memory store');
  captionError = null;
  captionVideoIds.length = 0;
});

after(async () => {
  await app.close();
  await closeStore();
  for (const file of fixtureFiles) fs.rmSync(file, { force: true });
});

async function makeVideo(topic: string) {
  const filePath = path.join(paths.temp, `route-upload-${randomUUID()}.mp4`);
  fs.writeFileSync(filePath, Buffer.alloc(2048));
  fixtureFiles.push(filePath);

  const store = getStore();
  const video = await store.createVideo({ topic });
  // The route reads the sidecar from this exact path, so it has to exist before the request.
  const subtitlePath = path.join(paths.videos, `${video.id}.srt`);
  fs.writeFileSync(
    subtitlePath,
    '1\n00:00:00,000 --> 00:00:02,000\nA real SubRip sidecar for the route test.\n',
  );
  fixtureFiles.push(subtitlePath);

  const updated = await store.updateVideo(video.id, {
    video_path: filePath,
    seo_title: 'Route caption test',
  });
  return { video: updated, subtitlePath };
}

const upload = (videoId: string) =>
  app.inject({
    method: 'POST',
    url: '/api/upload',
    headers: AUTH,
    payload: { videoId, confirm: true, privacyStatus: 'private' },
  });

const alertRows = async () => (await getStore().listLogs(null, 50)).filter((row) => row.step === 'alert');

test('a successful caption track is persisted on the video and returned in the response', async () => {
  const { video } = await makeVideo('Caption route success');

  const response = await upload(video.id);
  assert.equal(response.statusCode, 200, JSON.stringify(response.json()));

  const body = response.json();
  assert.equal(body.captionsUploaded, true, 'the response reports the uploaded track');
  assert.equal(body.captionError, null);
  assert.equal(body.video.captions_uploaded, true, 'the serialized video carries the outcome');
  assert.equal(body.video.caption_error, null);
  assert.equal(body.video.youtube_video_id, 'yt-route-video');

  const stored = await getStore().getVideo(video.id);
  assert.equal(stored?.captions_uploaded, true, 'the outcome is written to the row, not only logged');
  assert.equal(stored?.caption_error, null);
  assert.deepEqual(captionVideoIds, ['yt-route-video'], 'the track is attached to the new video');
  assert.equal((await alertRows()).length, 0, 'a successful track never alerts');
});

test('a rejected caption track is persisted as an error and returned without failing the upload', async () => {
  captionError = new Error('captions.insert: The language is not supported');
  const { video } = await makeVideo('Caption route failure');

  const response = await upload(video.id);
  assert.equal(response.statusCode, 200, 'the video itself was uploaded, so the request succeeds');

  const body = response.json();
  assert.equal(body.captionsUploaded, false);
  assert.match(body.captionError ?? '', /The language is not supported/, 'the reason is returned');
  assert.equal(body.video.captions_uploaded, false);
  assert.match(body.video.caption_error ?? '', /The language is not supported/);
  assert.equal(body.video.status, 'uploaded');

  const stored = await getStore().getVideo(video.id);
  assert.equal(stored?.captions_uploaded, false);
  assert.match(stored?.caption_error ?? '', /The language is not supported/);

  const captionLogs = (await getStore().listLogs(video.id, 20)).filter((row) => row.step === 'caption');
  assert.equal(captionLogs[0]?.status, 'warning', 'the regression is also visible in the activity log');
  assert.match(captionLogs[0]?.message ?? '', /Caption track not uploaded/);
  assert.equal((await alertRows()).length, 0, 'one failure is not yet a streak');
});

test('the caption failure alert fires through the route at the threshold', async () => {
  captionError = new Error('captions.insert: 403 forbidden');

  // The default threshold; the streak counts the uploads this route just made.
  const threshold = 3;
  for (let index = 1; index <= threshold; index += 1) {
    const { video } = await makeVideo(`Caption route streak ${index}`);
    const response = await upload(video.id);
    assert.equal(response.statusCode, 200, JSON.stringify(response.json()));
    assert.equal(response.json().captionsUploaded, false, 'every upload in the streak failed');

    if (index < threshold) {
      assert.equal((await alertRows()).length, 0, `no alert before the threshold (after ${index})`);
    }
  }

  const alerts = await alertRows();
  assert.equal(alerts.length, 1, 'the threshold raises exactly one alert');
  assert.equal(alerts[0]?.status, 'warning');
  assert.equal(alerts[0]?.video_id, null, 'the alert is channel-level');
  assert.match(alerts[0]?.message ?? '', /3 uploads in a row went out without a caption track/);
  assert.match(alerts[0]?.message ?? '', /403 forbidden/, 'the last YouTube error is included');
});
