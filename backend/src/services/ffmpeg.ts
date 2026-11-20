import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';
import { config, paths } from '../config.js';
import { getStore } from '../db/index.js';
import { AppError, badRequest, upstreamError, unavailable } from '../utils/errors.js';
import { errorMessage, logger } from '../utils/logger.js';
import { logStep } from './jobLog.js';
import { downloadClip, searchPexelsVideos, type PexelsVideo } from './pexels.js';

const require = createRequire(import.meta.url);
type FfmpegCommand = ReturnType<typeof ffmpeg>;

/* -------------------------------------------------------------------------- */
/* Binaries                                                                    */
/* -------------------------------------------------------------------------- */

function resolveFfmpegPath(): string {
  if (config.ffmpegPath) return config.ffmpegPath;
  try {
    const candidate = require('ffmpeg-static') as unknown;
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  } catch {
    /* fall back to PATH */
  }
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

function resolveFfprobePath(): string {
  if (config.ffprobePath) return config.ffprobePath;
  try {
    const candidate = require('ffprobe-static') as { path?: string } | undefined;
    if (candidate?.path) return candidate.path;
  } catch {
    /* fall back to PATH */
  }
  return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
}

export const ffmpegBinary = resolveFfmpegPath();
export const ffprobeBinary = resolveFfprobePath();
ffmpeg.setFfmpegPath(ffmpegBinary);
ffmpeg.setFfprobePath(ffprobeBinary);

export function checkFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegBinary, ['-version'], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/* -------------------------------------------------------------------------- */
/* Script -> timed sections                                                    */
/* -------------------------------------------------------------------------- */

export interface ScriptSection {
  text: string;
  keywords: string[];
  start: number;
  duration: number;
  words: number;
}

const STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'always', 'because', 'been', 'before', 'being', 'between', 'both',
  'could', 'does', 'doing', 'down', 'during', 'each', 'even', 'every', 'from', 'have', 'having', 'here',
  'into', 'itself', 'just', 'keep', 'like', 'make', 'many', 'might', 'more', 'most', 'much', 'must',
  'never', 'only', 'other', 'over', 'really', 'same', 'should', 'since', 'some', 'such', 'than', 'that',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'today', 'under',
  'until', 'very', 'want', 'well', 'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with',
  'would', 'your', 'youre', 'yours', 'thing', 'things', 'going', 'gonna', 'actually', 'basically',
]);

function cleanForTiming(script: string): string[] {
  const withoutCues = script
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/^\s*[A-Z][A-Z\s\d:–-]{3,}\s*$/gm, ' ')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\r/g, ' ');

  return withoutCues
    .split(/\n{2,}/)
    .flatMap((block) => block.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => /[a-z0-9]/i.test(sentence) && sentence.split(' ').length > 1);
}

function groupSentences(sentences: string[], targetWords = 30): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let words = 0;

  for (const sentence of sentences) {
    const count = sentence.split(' ').length;
    if (current.length > 0 && words + count > targetWords * 1.6) {
      chunks.push(current.join(' '));
      current = [];
      words = 0;
    }
    current.push(sentence);
    words += count;
  }
  if (current.length > 0) chunks.push(current.join(' '));
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

export function extractKeywords(text: string, niche = ''): string[] {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4 || STOPWORDS.has(raw)) continue;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([word]) => word);

  const nicheWords = niche
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOPWORDS.has(word))
    .slice(0, 1);

  const keywords = [...new Set([...ranked, ...nicheWords])];
  return keywords.length ? keywords : ['abstract background'];
}

/** Splits the script into ~7-10 second sections whose durations sum to the audio length. */
export function buildSections(script: string, audioDuration: number, niche = ''): ScriptSection[] {
  const chunks = groupSentences(cleanForTiming(script));
  if (chunks.length === 0 || audioDuration <= 0) return [];

  const wordCounts = chunks.map((chunk) => Math.max(1, chunk.split(/\s+/).length));
  const totalWords = wordCounts.reduce((sum, count) => sum + count, 0);
  const minDuration = Math.min(3, audioDuration / chunks.length);
  const rawDuration = wordCounts.map((count) => Math.max(minDuration, (count / totalWords) * audioDuration));
  const rawTotal = rawDuration.reduce((sum, value) => sum + value, 0);
  const scale = rawTotal > 0 ? audioDuration / rawTotal : 1;

  let cursor = 0;
  return chunks.map((text, index) => {
    const isLast = index === chunks.length - 1;
    const duration = isLast ? Math.max(0.5, audioDuration - cursor) : rawDuration[index]! * scale;
    const section: ScriptSection = {
      text,
      keywords: extractKeywords(text, niche),
      start: cursor,
      duration,
      words: wordCounts[index]!,
    };
    cursor += duration;
    return section;
  });
}

/* -------------------------------------------------------------------------- */
/* Media helpers                                                               */
/* -------------------------------------------------------------------------- */

export function probeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (error, data) => {
      if (error) {
        reject(upstreamError(`ffprobe could not read ${path.basename(file)}: ${error.message}`));
        return;
      }
      const duration = Number(data?.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(upstreamError(`Could not read a valid duration from ${path.basename(file)}.`));
        return;
      }
      resolve(duration);
    });
  });
}

function runCommand(command: FfmpegCommand, label: string, timeoutMs = config.renderTimeoutMs): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderrTail = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        command.kill('SIGKILL');
      } catch {
        /* the command may not have spawned yet */
      }
      reject(new AppError(504, `${label} timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    const finish = (error?: AppError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    command
      .on('start', (commandLine: string) => logger.debug(`[ffmpeg:${label}] ${commandLine}`))
      .on('stderr', (line: string) => {
        stderrTail = `${stderrTail}\n${line}`.slice(-4000);
      })
      .on('error', (error: Error) =>
        finish(
          new AppError(
            500,
            `${label} failed: ${error.message}${stderrTail ? `\n${stderrTail.slice(-1200)}` : ''}`,
          ),
        ),
      )
      .on('end', () => finish())
      .run();
  });
}

function escapeConcatPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/'/g, "'\\''");
}

/** Concatenates mono-format MP3 chunks (used by the TTS chunker). */
export async function concatMp3(parts: string[], outFile: string): Promise<void> {
  const listPath = path.join(paths.temp, `mp3-concat-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  await fsp.writeFile(listPath, parts.map((part) => `file '${escapeConcatPath(part)}'`).join('\n'), 'utf8');
  try {
    await runCommand(
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c', 'copy', '-y'])
        .output(outFile),
      'concat audio',
      120_000,
    );
  } finally {
    await fsp.rm(listPath, { force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* Captions                                                                    */
/* -------------------------------------------------------------------------- */

function assTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const centis = Math.min(99, Math.floor((total - Math.floor(total)) * 100));
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}

function escapeAss(text: string): string {
  return text.replace(/[{}]/g, '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function wrapCaption(text: string, maxChars = 40, maxLines = 3): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.join('\\N');
}

/** Builds an .ass sidecar timed across each section, chunked into readable captions. */
export async function writeAssFile(sections: ScriptSection[], filePath: string): Promise<void> {
  const events: string[] = [];

  for (const section of sections) {
    const words = section.text.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const wordsPerCaption = 9;
    const chunks: string[] = [];
    for (let index = 0; index < words.length; index += wordsPerCaption) {
      chunks.push(words.slice(index, index + wordsPerCaption).join(' '));
    }
    const sliceDuration = section.duration / chunks.length;

    chunks.forEach((chunk, index) => {
      const start = section.start + index * sliceDuration;
      const end = Math.min(section.start + section.duration, start + sliceDuration);
      if (end - start <= 0.05) return;
      events.push(
        `Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${wrapCaption(escapeAss(chunk))}`,
      );
    });
  }

  const content = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'PlayResX: 1920',
    'PlayResY: 1080',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Caption,Arial,58,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,120,120,80,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');

  await fsp.writeFile(filePath, content, 'utf8');
}

/* -------------------------------------------------------------------------- */
/* Render                                                                      */
/* -------------------------------------------------------------------------- */

export interface RenderRequest {
  videoId: string;
  audioPath: string;
  script: string;
  niche: string;
  onProgress?: (progress: number, stage: string) => void;
  /** Where clips come from. Defaults to Pexels; a local source lets the render run offline. */
  clipSource?: ClipSource;
}

/** The two Pexels operations a render needs, narrowed so they can be swapped out. */
export interface ClipSource {
  search(query: string, perPage: number): Promise<PexelsVideo[]>;
  download(video: PexelsVideo): Promise<string>;
}

const pexelsClipSource: ClipSource = {
  search: searchPexelsVideos,
  download: downloadClip,
};

export interface RenderResult {
  videoPath: string;
  captionPath: string;
  durationSeconds: number;
  sections: number;
  clipIds: string[];
}

interface AcquiredClip {
  video: PexelsVideo;
  filePath: string;
}

/**
 * Picks the first Pexels clip that is not in the dedupe ledger and downloads it. Results are
 * de-duplicated by Pexels id across all queries. If every candidate is already in the ledger the
 * render continues with a reused clip (and says so in the job log) instead of failing outright.
 */
async function acquireClip(
  keywords: string[],
  niche: string,
  videoId: string,
  usedThisRender: ReadonlySet<string>,
  clipSource: ClipSource,
): Promise<AcquiredClip> {
  const store = getStore();
  const queries = [
    ...new Set(
      [...keywords.map((keyword) => keyword.trim()), niche.trim()].filter((query) => query.length > 1),
    ),
  ];
  const candidates = new Map<number, PexelsVideo>();

  for (const query of queries) {
    const videos = await clipSource.search(query, 10);
    for (const video of videos) {
      if (candidates.has(video.id)) continue;
      candidates.set(video.id, video);
      const clipId = String(video.id);
      if (usedThisRender.has(clipId) || (await store.isClipUsed(clipId))) continue;
      const filePath = await clipSource.download(video);
      return { video, filePath };
    }
  }

  if (candidates.size > 0) {
    const pool = [...candidates.values()];
    // Prefer a clip this render has not shown yet so adjacent sections do not repeat footage.
    const fallback = pool.find((video) => !usedThisRender.has(String(video.id))) ?? pool[0]!;
    const message = `Every Pexels result for "${queries[0] ?? niche}" is already in the dedupe ledger; reused clip ${fallback.id}.`;
    logger.warn(message);
    await logStep(videoId, 'render', 'warning', message);
    return { video: fallback, filePath: await clipSource.download(fallback) };
  }

  throw upstreamError(`No royalty-free Pexels clips found for "${queries[0] ?? niche}".`);
}

async function buildSegment(clipPath: string, outPath: string, duration: number): Promise<void> {
  const seconds = Math.max(1.5, duration);
  await runCommand(
    ffmpeg(clipPath)
      .inputOptions(['-stream_loop', '-1'])
      .videoFilters('scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,fps=30')
      .outputOptions([
        '-t',
        seconds.toFixed(3),
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-y',
      ])
      .output(outPath),
    `segment ${path.basename(outPath)}`,
  );
}

function buildMuxCommand(basePath: string, audioPath: string, outPath: string, captionFile?: string): FfmpegCommand {
  const command = ffmpeg().input(basePath).input(audioPath);
  if (captionFile) command.videoFilters(`subtitles=${captionFile}`);
  return command
    .outputOptions([
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '21',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '44100',
      '-shortest',
      '-movflags',
      '+faststart',
      '-y',
    ])
    .output(outPath);
}

export async function renderVideo(request: RenderRequest): Promise<RenderResult> {
  const { videoId, audioPath, script, niche, onProgress } = request;
  const report = (progress: number, stage: string): void => {
    try {
      onProgress?.(Math.max(0, Math.min(100, Math.round(progress))), stage);
    } catch (error) {
      logger.debug(`Progress callback failed: ${errorMessage(error)}`);
    }
  };

  const clipSource = request.clipSource ?? pexelsClipSource;
  if (!request.clipSource && !config.pexelsApiKey) {
    throw unavailable('PEXELS_API_KEY is not configured — royalty-free clips cannot be fetched.');
  }
  if (!fs.existsSync(audioPath)) {
    throw badRequest('The voiceover MP3 is missing. Generate the audio before rendering.');
  }

  const ffmpegReady = await checkFfmpegAvailable();
  if (!ffmpegReady) {
    throw unavailable(
      `FFmpeg could not be started (tried "${ffmpegBinary}"). Install FFmpeg or set FFMPEG_PATH.`,
    );
  }

  report(2, 'reading audio');
  const audioDuration = await probeDuration(audioPath);
  const sections = buildSections(script, audioDuration, niche);
  if (sections.length === 0) throw badRequest('The script has no speakable sections to render.');

  const tempDir = path.join(paths.temp, `render-${videoId}`);
  await fsp.rm(tempDir, { recursive: true, force: true });
  await fsp.mkdir(tempDir, { recursive: true });

  const segmentPaths: string[] = [];
  const clipIds: string[] = [];
  const usedThisRender = new Set<string>();
  const store = getStore();

  try {
    for (let index = 0; index < sections.length; index += 1) {
      const section = sections[index]!;
      const clip = await acquireClip(section.keywords, niche, videoId, usedThisRender, clipSource);
      const segmentPath = path.join(tempDir, `seg-${String(index).padStart(3, '0')}.mp4`);
      await buildSegment(clip.filePath, segmentPath, section.duration);
      segmentPaths.push(segmentPath);
      const clipId = String(clip.video.id);
      clipIds.push(clipId);
      usedThisRender.add(clipId);
      await store.markClipUsed(clipId, videoId);
      report(4 + ((index + 1) / sections.length) * 66, `clip ${index + 1}/${sections.length}`);
    }

    report(72, 'concatenating clips');
    const listPath = path.join(tempDir, 'concat.txt');
    await fsp.writeFile(
      listPath,
      segmentPaths.map((segment) => `file '${escapeConcatPath(segment)}'`).join('\n'),
      'utf8',
    );
    const basePath = path.join(tempDir, 'base.mp4');
    await runCommand(
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c', 'copy', '-y'])
        .output(basePath),
      'concat clips',
    );

    report(78, 'writing captions');
    const captionPath = path.join(paths.videos, `${videoId}.ass`);
    await writeAssFile(sections, captionPath);

    report(84, 'muxing audio and captions');
    const videoPath = path.join(paths.videos, `${videoId}.mp4`);
    const captionFilterName = `.yt-captions-${videoId}.ass`;
    const localCaption = path.join(process.cwd(), captionFilterName);
    await fsp.copyFile(captionPath, localCaption);

    try {
      await runCommand(buildMuxCommand(basePath, audioPath, videoPath, captionFilterName), 'mux with captions');
    } catch (error) {
      logger.warn(`Caption burn-in failed; muxing without burned captions. ${errorMessage(error)}`);
      await logStep(
        videoId,
        'render',
        'warning',
        `Caption burn-in failed (${errorMessage(error)}). Captions are available as a .ass sidecar.`,
      );
      await fsp.rm(videoPath, { force: true });
      await runCommand(buildMuxCommand(basePath, audioPath, videoPath), 'mux without captions');
    } finally {
      await fsp.rm(localCaption, { force: true });
    }

    report(97, 'finalising');
    const stats = await fsp.stat(videoPath);
    if (stats.size < 50_000) throw upstreamError('The rendered MP4 is unexpectedly small.');

    return {
      videoPath,
      captionPath,
      durationSeconds: audioDuration,
      sections: sections.length,
      clipIds,
    };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
