import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';
import { paths } from '../src/config.js';
import { checkFfmpegAvailable, concatMp3, ffmpegBinary, probeDuration } from '../src/services/ffmpeg.js';

/**
 * The chunked TTS path stitches several Edge TTS MP3s together with `concatMp3` before rendering.
 * If the concat list is malformed the voiceover is silently truncated or broken, so this checks the
 * joined file is a real MP3 with the summed duration.
 */

const FIRST_SECONDS = 1.5;
const SECOND_SECONDS = 2.5;

let ffmpegReady = false;
let fixtureDir = '';
const fixtures: string[] = [];
let outputPath = '';

function runFfmpeg(args: string[]): void {
  const result = spawnSync(ffmpegBinary, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`ffmpeg fixture generation failed (${result.status}): ${result.stderr}`);
  }
}

function probeStreams(file: string): Promise<Array<{ codec_type?: string; codec_name?: string }>> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (error, data) => {
      if (error) reject(error);
      else resolve(data.streams ?? []);
    });
  });
}

before(async () => {
  ffmpegReady = await checkFfmpegAvailable();
  if (!ffmpegReady) return;

  fixtureDir = path.join(paths.temp, `concat-test-${randomUUID()}`);
  fs.mkdirSync(fixtureDir, { recursive: true });

  // Two chunks with identical codec parameters, exactly like the TTS chunker produces.
  for (const [index, duration] of [FIRST_SECONDS, SECOND_SECONDS].entries()) {
    const file = path.join(fixtureDir, `chunk-${index}.mp3`);
    runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', `sine=frequency=${440 + index * 220}:duration=${duration}`,
      '-ar', '44100',
      '-ac', '1',
      '-c:a', 'libmp3lame',
      '-b:a', '96k',
      file,
    ]);
    fixtures.push(file);
  }

  outputPath = path.join(fixtureDir, 'voiceover.mp3');
});

after(async () => {
  if (fixtureDir) await fsp.rm(fixtureDir, { recursive: true, force: true }).catch(() => undefined);
});

test('concatMp3 joins TTS chunks into one playable MP3 with the summed duration', async (t) => {
  if (!ffmpegReady) return t.skip('FFmpeg is not available on this machine');

  const concatListsBefore = fs
    .readdirSync(paths.temp)
    .filter((name) => name.startsWith('mp3-concat-') && name.endsWith('.txt')).length;

  await concatMp3(fixtures, outputPath);

  assert.ok(fs.existsSync(outputPath), 'the concatenated MP3 exists');
  assert.ok(fs.statSync(outputPath).size > 5_000, 'the joined file is not empty');

  const duration = await probeDuration(outputPath);
  const expected = FIRST_SECONDS + SECOND_SECONDS;
  assert.ok(
    Math.abs(duration - expected) < 0.3,
    `joined duration ${duration.toFixed(2)}s should be about ${expected}s`,
  );

  const streams = await probeStreams(outputPath);
  assert.equal(streams.length, 1, 'concatenation produces a single stream, without video');
  assert.equal(streams[0]?.codec_type, 'audio');
  assert.equal(streams[0]?.codec_name, 'mp3', 'the chunks are copied, not re-encoded');

  const concatListsAfter = fs
    .readdirSync(paths.temp)
    .filter((name) => name.startsWith('mp3-concat-') && name.endsWith('.txt')).length;
  assert.equal(concatListsAfter, concatListsBefore, 'the temporary concat list is removed');
});
