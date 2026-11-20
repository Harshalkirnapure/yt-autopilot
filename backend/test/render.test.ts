import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';
import { paths } from '../src/config.js';
import { closeStore, getStore, initStore } from '../src/db/index.js';
import {
  checkFfmpegAvailable,
  ffmpegBinary,
  probeDuration,
  renderVideo,
  type ClipSource,
} from '../src/services/ffmpeg.js';
import type { PexelsVideo } from '../src/services/pexels.js';

/**
 * End-to-end render test. The only thing replaced is the Pexels clip source; cutting, concatenation,
 * caption burn-in, the audio mux and the dedupe ledger are all the production code path.
 */

const AUDIO_SECONDS = 6;
const SCRIPT = [
  'Saving money starts with knowing exactly where your money goes each month.',
  'Track every small purchase for thirty days and a pattern appears quickly.',
  'Most households spend far more on subscriptions than they expect to.',
  'Cancelling two unused subscriptions frees real money every single month.',
  'Move the freed amount into savings on the day your salary arrives.',
  'That small automatic transfer quietly grows into an emergency fund.',
  'Review the numbers every quarter and raise the transfer a little.',
  'Consistent habits beat dramatic plans that quietly fade away.',
].join(' ');

const videoId = randomUUID();
const outputPath = path.join(paths.videos, `${videoId}.mp4`);
const captionPath = path.join(paths.videos, `${videoId}.ass`);
const captionFilterCopy = path.join(paths.backend, `.yt-captions-${videoId}.ass`);

let ffmpegReady = false;
let fixtureDir = '';
let audioPath = '';
const clipFiles: string[] = [];

function runFfmpeg(args: string[]): void {
  const result = spawnSync(ffmpegBinary, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`ffmpeg fixture generation failed (${result.status}): ${result.stderr}`);
  }
}

/** One full-resolution 8-bit luma frame, so caption pixels can be inspected directly. */
function grabLumaFrame(file: string, atSeconds: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn(
      ffmpegBinary,
      ['-v', 'error', '-ss', atSeconds.toFixed(3), '-i', file, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'],
      { windowsHide: true },
    );
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', () => undefined);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Could not extract a frame from ${path.basename(file)} (ffmpeg exit ${code}).`));
    });
  });
}

/** `0:00:03.20` → 3.2 */
function assTimestamp(value: string): number {
  const [hours, minutes, seconds] = value.split(':');
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/** Near-white (luma ≥ 220) pixels between two rows: burned-in captions are white on colour. */
function countBrightPixels(frame: Buffer, fromRow: number, toRow: number): number {
  const width = 1920;
  let bright = 0;
  for (let y = fromRow; y < toRow; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((frame[y * width + x] ?? 0) >= 220) bright += 1;
    }
  }
  return bright;
}

function probe(file: string): Promise<{ duration: number; streamTypes: string[] }> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (error, data) => {
      if (error) return reject(error);
      resolve({
        duration: Number(data.format?.duration),
        streamTypes: (data.streams ?? []).map((stream) => String(stream.codec_type)),
      });
    });
  });
}

before(async () => {
  const store = await initStore();
  assert.equal(store.mode, 'memory', 'tests must run against the in-memory store');

  ffmpegReady = await checkFfmpegAvailable();
  if (!ffmpegReady) return;

  fixtureDir = path.join(paths.temp, `render-test-${randomUUID()}`);
  fs.mkdirSync(fixtureDir, { recursive: true });

  // Small solid-colour sources; renderVideo loops and rescales them to 1080p.
  for (const [index, colour] of ['blue', 'orange', 'green'].entries()) {
    const file = path.join(fixtureDir, `clip-${index + 1}.mp4`);
    runFfmpeg(['-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=320x180:r=15:d=4`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    clipFiles.push(file);
  }

  audioPath = path.join(fixtureDir, 'voice.mp3');
  runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${AUDIO_SECONDS}`,
    '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', audioPath,
  ]);
});

after(async () => {
  await closeStore();
  if (fixtureDir) await fsp.rm(fixtureDir, { recursive: true, force: true }).catch(() => undefined);
  for (const leftover of [outputPath, captionPath, captionFilterCopy, path.join(paths.temp, `render-${videoId}`)]) {
    fs.rmSync(leftover, { recursive: true, force: true });
  }
});

test('the render pipeline cuts, concatenates, burns captions and muxes a real MP4', async (t) => {
  if (!ffmpegReady) return t.skip('FFmpeg is not available on this machine');

  const store = getStore();
  const clipSource: ClipSource = {
    // Three distinct candidates per search, like a Pexels page.
    async search(): Promise<PexelsVideo[]> {
      return clipFiles.map((_, index) => ({ id: index + 1, duration: 4, video_files: [] }));
    },
    async download(video: PexelsVideo): Promise<string> {
      const file = clipFiles[video.id - 1];
      if (!file) throw new Error(`No fixture clip for id ${video.id}`);
      return file;
    },
  };

  const audioDuration = await probeDuration(audioPath);
  const progress: number[] = [];
  const result = await renderVideo({
    videoId,
    audioPath,
    script: SCRIPT,
    niche: 'personal finance',
    clipSource,
    onProgress: (value) => progress.push(value),
  });

  // Script → sections, each with its own clip, and the real dedupe ledger was written.
  assert.ok(result.sections >= 2, `expected at least two sections, got ${result.sections}`);
  assert.equal(result.clipIds.length, result.sections);
  assert.equal(new Set(result.clipIds).size, result.sections, 'sections do not repeat clips');
  assert.equal(await store.countUsedClips(), result.sections);
  assert.ok(progress.length > 0, 'progress was reported during the render');

  // The MP4 is a real video+audio file matching the voiceover length.
  assert.ok(fs.statSync(result.videoPath).size > 50_000, 'the rendered MP4 is not empty');
  const { duration: renderedDuration, streamTypes } = await probe(result.videoPath);
  assert.ok(streamTypes.includes('video'), 'the MP4 has a video stream');
  assert.ok(streamTypes.includes('audio'), 'the MP4 has the muxed voiceover stream');
  assert.ok(
    Math.abs(renderedDuration - audioDuration) < 1,
    `MP4 duration ${renderedDuration.toFixed(2)}s should match the ${audioDuration.toFixed(2)}s voiceover`,
  );
  assert.ok(Math.abs(result.durationSeconds - audioDuration) < 0.01, 'the result reports the audio duration');

  // Captions: a real .ass sidecar with one Dialogue cue per caption chunk.
  assert.equal(result.captionPath, captionPath);
  const ass = fs.readFileSync(captionPath, 'utf8');
  assert.match(ass, /^\[Script Info\]/m);
  assert.match(ass, /PlayResX: 1920/);
  assert.match(ass, /^Style: Caption,/m);
  const cues = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
  assert.ok(cues.length >= result.sections, `expected caption cues, found ${cues.length}`);

  // Burn-in can silently fall back, so prove it in the pixels. Every source clip is a solid colour
  // (luma < 170), so near-white pixels can only be caption text.
  const [, start, end] = cues[0]!.split(',');
  const frameAt = (assTimestamp(start!.trim()) + assTimestamp(end!.trim())) / 2;
  const frame = await grabLumaFrame(result.videoPath, frameAt);
  assert.equal(frame.length, 1920 * 1080, 'a full 1920x1080 luma frame is read back');

  const captionRow = Math.floor(1080 * 0.72);
  const captionPixels = countBrightPixels(frame, captionRow, 1080);
  assert.ok(
    captionPixels >= 500,
    `expected burned-in caption pixels in the bottom band, found ${captionPixels} ` +
      '(sidecar-only fallback leaves none)',
  );
  assert.equal(countBrightPixels(frame, 0, captionRow), 0, 'the footage itself has no near-white pixels');

  // Scratch state is gone: per-video temp dir and the temporary caption filter copy.
  assert.equal(fs.existsSync(path.join(paths.temp, `render-${videoId}`)), false, 'render temp dir removed');
  assert.equal(fs.existsSync(captionFilterCopy), false, 'caption filter copy removed');
});

test('without a clip source the Pexels key is still required', async (t) => {
  if (!ffmpegReady) return t.skip('FFmpeg is not available on this machine');

  await assert.rejects(
    () => renderVideo({ videoId, audioPath, script: SCRIPT, niche: 'personal finance' }),
    /PEXELS_API_KEY/,
    'the production default stays Pexels',
  );
});
