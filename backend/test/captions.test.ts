import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { youtube_v3 } from 'googleapis';
import { config, paths } from '../src/config.js';
import { buildSections, writeSrtFile } from '../src/services/ffmpeg.js';
import { uploadToYouTube } from '../src/services/youtube.js';

/**
 * The caption upload never runs in the offline suite (no channel), so `captions.insert` and its
 * best-effort branches are driven here against a stubbed YouTube client. The .srt is produced by
 * the real render caption code (`buildSections` + `writeSrtFile`), not a hand-written fixture.
 */

const SCRIPT = [
  'Saving money starts with knowing exactly where your money goes each month.',
  'Track every small purchase for thirty days and a pattern appears quickly.',
  'Most households spend far more on subscriptions than they expect to.',
  'Cancelling two unused subscriptions frees real money every single month.',
].join(' ');

const scratchDir = path.join(paths.temp, `caption-test-${randomUUID()}`);
const videoPath = path.join(scratchDir, 'video.mp4');
const subtitlePath = path.join(scratchDir, 'captions.srt');

type CaptionCall = [youtube_v3.Params$Resource$Captions$Insert, { timeout?: number } | undefined];

interface Stub {
  client: youtube_v3.Youtube;
  captionCalls: CaptionCall[];
  insertCalls: number;
  /** The bytes the client actually read from the upload stream. */
  captionBody: string | null;
}

function stubYoutube(options: { captionError?: Error; videoId?: string } = {}): Stub {
  const stub: Stub = {
    client: null as unknown as youtube_v3.Youtube,
    captionCalls: [],
    insertCalls: 0,
    captionBody: null,
  };

  stub.client = {
    videos: {
      insert: async () => {
        stub.insertCalls += 1;
        return { data: { id: options.videoId ?? 'yt-stub-video' } };
      },
    },
    captions: {
      insert: async (params: CaptionCall[0], requestOptions?: CaptionCall[1]) => {
        // Drain inside the call, like the real client: the caller destroys the stream as soon as
        // this resolves, so the body has to be read here rather than by the test afterwards.
        stub.captionBody = params.media?.body ? await streamText(params.media.body as Readable) : null;
        stub.captionCalls.push([params, requestOptions]);
        if (options.captionError) throw options.captionError;
        return { data: {} };
      },
    },
  } as unknown as youtube_v3.Youtube;

  return stub;
}

/** Reads the upload stream the way the API client would, so its bytes can be checked. */
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

const noThumbnail = { filePath: videoPath, title: 'Caption upload test', description: '', tags: [], privacyStatus: 'private' as const, quotaClaimed: true };

before(() => {
  fs.mkdirSync(scratchDir, { recursive: true });
  // uploadToYouTube refuses a missing MP4; its bytes are never uploaded because the client is stubbed.
  fs.writeFileSync(videoPath, Buffer.alloc(2048));
});

after(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

test('the rendered .srt is sent to captions.insert as a text track', async () => {
  const sections = buildSections(SCRIPT, 6, 'personal finance');
  assert.ok(sections.length > 0, 'the script produced caption sections');
  await writeSrtFile(sections, subtitlePath);

  const srt = fs.readFileSync(subtitlePath, 'utf8');
  assert.match(srt, /^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/, 'a real SubRip file');

  const stub = stubYoutube();
  const result = await uploadToYouTube({ ...noThumbnail, subtitlePath }, { youtube: stub.client });

  assert.equal(result.youtubeVideoId, 'yt-stub-video');
  assert.equal(result.captionsUploaded, true, 'the caption result is reported to the caller');
  assert.equal(result.captionError, null, 'a successful track has nothing to report');
  assert.equal(stub.captionCalls.length, 1, 'exactly one caption track is inserted');
  assert.equal(stub.insertCalls, 1, 'the video is still uploaded normally');

  const [params, requestOptions] = stub.captionCalls[0]!;
  assert.deepEqual(params.part, ['snippet']);
  assert.equal(params.requestBody?.snippet?.videoId, 'yt-stub-video', 'the caption is attached to the new video');
  assert.equal(params.requestBody?.snippet?.language, config.ytCaptionLanguage);
  assert.equal(params.requestBody?.snippet?.name, 'Scripted narration');
  assert.equal(params.media?.mimeType, 'text/plain', 'YouTube takes SubRip as a plain-text upload');
  assert.ok(params.media?.body, 'the upload body is a stream');
  assert.equal(stub.captionBody, srt, 'the bytes are the rendered .srt');
  assert.equal(requestOptions?.timeout, 2 * 60 * 1000, 'the caption call has its own timeout');
});

test('a missing or empty .srt skips the caption upload instead of failing the video', async () => {
  const missing = path.join(scratchDir, 'never-written.srt');

  const stub = stubYoutube();
  const withoutFile = await uploadToYouTube({ ...noThumbnail, subtitlePath: missing }, { youtube: stub.client });

  assert.equal(withoutFile.youtubeVideoId, 'yt-stub-video');
  assert.equal(withoutFile.captionsUploaded, false);
  assert.match(withoutFile.captionError ?? '', /No caption sidecar at never-written\.srt/, 'the reason is returned for the row');
  assert.equal(stub.captionCalls.length, 0, 'nothing is sent when the sidecar is absent');

  const empty = path.join(scratchDir, 'empty.srt');
  fs.writeFileSync(empty, '');
  const emptyResult = await uploadToYouTube({ ...noThumbnail, subtitlePath: empty }, { youtube: stub.client });
  assert.equal(emptyResult.captionsUploaded, false);
  assert.match(emptyResult.captionError ?? '', /No caption sidecar at empty\.srt/);
  assert.equal(stub.captionCalls.length, 0, 'an empty sidecar is not uploaded either');
});

test('a rejected caption track is best-effort: the upload still succeeds', async () => {
  const sections = buildSections(SCRIPT, 6, 'personal finance');
  await writeSrtFile(sections, subtitlePath);

  const stub = stubYoutube({ captionError: new Error('captionTrackNotFound: invalid srt') });
  const result = await uploadToYouTube({ ...noThumbnail, subtitlePath }, { youtube: stub.client });

  assert.equal(stub.captionCalls.length, 1, 'the call was attempted');
  assert.equal(stub.captionBody, fs.readFileSync(subtitlePath, 'utf8'), 'the .srt was fully sent before the rejection');
  assert.equal(result.youtubeVideoId, 'yt-stub-video', 'the video upload is not rolled back');
  assert.equal(result.captionsUploaded, false, 'the caller is told the track is missing');
  assert.match(result.captionError ?? '', /captionTrackNotFound: invalid srt/, 'YouTube\'s reason is returned, not swallowed');
  assert.equal(result.privacyStatus, 'private');
});
