import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { youtube_v3 } from 'googleapis';
import { config, paths } from '../config.js';
import { closeStore, getStore, initStore } from '../db/index.js';
import { buildSections, ffmpegBinary, writeSrtFile } from '../services/ffmpeg.js';
import { getAuthorizedClient, uploadToYouTube, youtubeConfigured } from '../services/youtube.js';
import { errorMessage } from '../utils/logger.js';

/**
 * Opt-in live check of the whole YouTube path: stored-token refresh, private upload, thumbnail,
 * caption track, `captions.list` and the delete that removes the test video again.
 *
 * `npm test` must stay offline and key-free, so this runs on its own (`npm run smoke:youtube`) and
 * exits 0 with a SKIP line when the credentials or the connected channel are missing.
 */

const FIXTURE_SECONDS = 3;
const FIXTURE_SCRIPT = [
  'This is an automated check of the YouTube upload path.',
  'The video is private and removed again as soon as the check finishes.',
].join(' ');
const CAPTION_NAME = 'Scripted narration';

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function runFfmpeg(args: string[], label: string): void {
  const result = spawnSync(ffmpegBinary, args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed (ffmpeg exit ${result.status}): ${result.stderr?.trim() ?? ''}`);
  }
}

function skip(reason: string): void {
  console.log(`SKIP  YouTube smoke test not run: ${reason}`);
  console.log('      See "Live YouTube smoke test" in README.md §11.');
}

function describeTrack(item: youtube_v3.Schema$Caption): string {
  const snippet = item.snippet;
  return [snippet?.language, snippet?.name, snippet?.trackKind, snippet?.status].filter(Boolean).join('/');
}

/** A few seconds of colour bars with silent audio: tiny, but a real MP4 YouTube will accept. */
function writeFixtureVideo(filePath: string): void {
  runFfmpeg(
    [
      '-y',
      '-v', 'error',
      '-f', 'lavfi',
      '-i', 'testsrc2=size=640x360:rate=30',
      '-f', 'lavfi',
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-t', String(FIXTURE_SECONDS),
      '-shortest',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', '+faststart',
      filePath,
    ],
    'Fixture video generation',
  );
}

/** 1280×720 PNG, well under `thumbnails.set`'s 2 MB limit. */
function writeFixtureThumbnail(filePath: string): void {
  runFfmpeg(
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x1f2937:s=1280x720', '-frames:v', '1', filePath],
    'Fixture thumbnail generation',
  );
}

async function run(youtube: youtube_v3.Youtube): Promise<void> {
  const scratch = path.join(paths.temp, `youtube-smoke-${randomUUID()}`);
  fs.mkdirSync(scratch, { recursive: true });

  const videoPath = path.join(scratch, 'fixture.mp4');
  const thumbnailPath = path.join(scratch, 'fixture.png');
  const subtitlePath = path.join(scratch, 'fixture.srt');

  let youtubeVideoId: string | null = null;
  let failure: unknown = null;
  let cleanupFailure: unknown = null;

  try {
    console.log('STEP  Building the fixture video, thumbnail and .srt');
    writeFixtureVideo(videoPath);
    writeFixtureThumbnail(thumbnailPath);
    const sections = buildSections(FIXTURE_SCRIPT, FIXTURE_SECONDS, 'personal finance');
    check(sections.length > 0, 'the fixture script produced no caption sections');
    await writeSrtFile(sections, subtitlePath);

    console.log('STEP  Uploading as private (thumbnail + caption sidecar)');
    const result = await uploadToYouTube(
      {
        filePath: videoPath,
        title: `YT AutoPilot smoke test ${new Date().toISOString().replace(/[:.]/g, '-')}`,
        description:
          'Automated credential check for YT AutoPilot. Uploaded private and deleted by the script that created it.',
        tags: ['smoke-test'],
        privacyStatus: 'private',
        thumbnailPath,
        subtitlePath,
        // Not a real upload: it must neither spend one of the 6 daily slots nor need a videos row.
        quotaClaimed: true,
      },
      { youtube },
    );
    youtubeVideoId = result.youtubeVideoId;

    console.log(`INFO  YouTube id ${result.youtubeVideoId} · https://youtu.be/${result.youtubeVideoId}`);
    check(result.privacyStatus === 'private', `the upload is not private (${result.privacyStatus})`);
    check(result.thumbnailApplied, 'thumbnails.set did not apply the fixture thumbnail');
    check(result.captionsUploaded, 'captions.insert did not insert the .srt');
    check(result.syntheticMediaDisclosed, 'the synthetic-media disclosure is off (YT_DISCLOSE_SYNTHETIC_MEDIA)');
    console.log('PASS  Private upload, thumbnail and caption insert succeeded');

    console.log('STEP  Verifying the track with captions.list');
    const listed = await youtube.captions.list({ part: ['snippet'], videoId: result.youtubeVideoId });
    const tracks = listed.data.items ?? [];
    check(tracks.length > 0, 'captions.list returned no tracks for the new video');

    const track = tracks.find((item) => item.snippet?.language === config.ytCaptionLanguage);
    check(
      track !== undefined,
      `captions.list has no ${config.ytCaptionLanguage} track (found: ${tracks.map(describeTrack).join(', ') || 'none'})`,
    );
    check(
      track.snippet?.status !== 'failed',
      `the ${config.ytCaptionLanguage} track is marked failed by YouTube (${describeTrack(track)})`,
    );
    check(
      track.snippet?.name === CAPTION_NAME,
      `the ${config.ytCaptionLanguage} track name is "${track.snippet?.name ?? ''}", expected "${CAPTION_NAME}"`,
    );

    console.log(`PASS  captions.list shows ${describeTrack(track)}`);
  } catch (error) {
    failure = error;
  } finally {
    if (youtubeVideoId) {
      console.log(`STEP  Deleting test video ${youtubeVideoId}`);
      try {
        await youtube.videos.delete({ id: youtubeVideoId });
        console.log(`PASS  Deleted https://youtu.be/${youtubeVideoId}`);
      } catch (error) {
        cleanupFailure = error;
        console.error(
          `FAIL  Could not delete the test video. Remove it by hand: https://studio.youtube.com/video/${youtubeVideoId}/edit (${errorMessage(error)})`,
        );
      }
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  if (failure) throw failure;
  if (cleanupFailure) throw new Error('The checks passed but the test video could not be deleted.');
}

async function main(): Promise<void> {
  if (!youtubeConfigured()) {
    skip('YT_CLIENT_ID / YT_CLIENT_SECRET are not set.');
    return;
  }
  if (!config.databaseUrl) {
    skip("DATABASE_URL is not set, so the connected channel's stored tokens cannot be read.");
    return;
  }

  await initStore();
  try {
    const tokens = await getStore().getTokens();
    if (!tokens) {
      skip('No YouTube channel is connected. Open /api/youtube/auth and grant access first.');
      return;
    }

    console.log(
      `INFO  Channel ${tokens.channel_id ?? '(unknown)'} · caption language ${config.ytCaptionLanguage} · fixture ${FIXTURE_SECONDS}s`,
    );
    const auth = await getAuthorizedClient();
    const { google } = await import('googleapis');
    await run(google.youtube({ version: 'v3', auth }));

    console.log('\nPASS  YouTube path verified end to end: private upload, thumbnail, caption track, captions.list, delete.');
  } finally {
    await closeStore();
  }
}

main().catch((error: unknown) => {
  console.error(`\nFAIL  ${errorMessage(error)}`);
  process.exitCode = 1;
});
