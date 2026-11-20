import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, paths } from '../config.js';
import { AppError, badRequest, unavailable, upstreamError } from '../utils/errors.js';
import { errorMessage, logger } from '../utils/logger.js';
import { withRetry, withTimeout } from '../utils/retry.js';
import { concatMp3, probeDuration } from './ffmpeg.js';

export interface SpeechResult {
  filePath: string;
  provider: 'edge' | 'google';
  durationSeconds: number | null;
  bytes: number;
  voice: string;
}

const MAX_CHUNK_CHARS = 2800;

/** Strips markdown, timestamps and stage cues so only spoken words reach the TTS engine. */
export function prepareText(script: string): string {
  return script
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:[^)]*\d+:\d+[^)]*)\)/g, ' ')
    .replace(/[*_#>`~]/g, '')
    .replace(/\r/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function chunkText(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  if (text.length <= maxChars) return [text];

  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let index = 0; index < sentence.length; index += maxChars) {
        chunks.push(sentence.slice(index, index + maxChars));
      }
      continue;
    }
    if ((current ? `${current} ${sentence}` : sentence).length > maxChars) {
      if (current) chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

interface EdgeTtsInstance {
  synthesize(): Promise<{ audio: Blob }>;
}

type EdgeTtsConstructor = new (
  text: string,
  voice?: string,
  options?: { rate?: string; volume?: string; pitch?: string },
) => EdgeTtsInstance;

async function synthesizeWithEdge(text: string, voice: string, outFile: string): Promise<void> {
  // The package is ESM/CJS dual and its typings change between releases; load it defensively.
  const packageName = 'edge-tts-universal';
  let pkg: Record<string, unknown>;
  try {
    pkg = (await import(packageName)) as unknown as Record<string, unknown>;
  } catch (error) {
    throw unavailable(`edge-tts-universal is not installed: ${errorMessage(error)}`);
  }

  const constructor = (pkg.UniversalEdgeTTS ?? pkg.EdgeTTS ?? pkg.default) as
    | EdgeTtsConstructor
    | undefined;
  if (typeof constructor !== 'function') {
    throw unavailable('edge-tts-universal did not expose an EdgeTTS constructor.');
  }

  const chunks = chunkText(text);
  const partFiles: string[] = [];

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      const result = await withRetry(
        () => {
          // A fresh instance per attempt: a socket that already timed out cannot be reused.
          const instance = new constructor(chunk, voice, { rate: config.ttsRate });
          return withTimeout(
            instance.synthesize(),
            45_000,
            'Edge TTS did not respond within 45s. Check outbound access to speech.platform.bing.com.',
          );
        },
        {
          attempts: 3,
          baseDelayMs: 1200,
          label: `Edge TTS chunk ${index + 1}/${chunks.length}`,
        },
      );
      const buffer = Buffer.from(await result.audio.arrayBuffer());
      if (buffer.byteLength < 512) throw upstreamError('Edge TTS returned an empty audio buffer.');
      const partFile = `${outFile}.part-${index}.mp3`;
      await fsp.writeFile(partFile, buffer);
      partFiles.push(partFile);
    }

    await fsp.rm(outFile, { force: true });
    if (partFiles.length === 1) await fsp.rename(partFiles[0]!, outFile);
    else await concatMp3(partFiles, outFile);
  } finally {
    await Promise.all(partFiles.map((part) => fsp.rm(part, { force: true }).catch(() => undefined)));
  }
}

async function synthesizeWithGoogle(text: string, voice: string, outFile: string): Promise<void> {
  if (!config.googleTtsKey) {
    throw unavailable('GOOGLE_TTS_KEY is not configured, so Google Cloud TTS is unavailable.');
  }

  const languageCode = (voice.match(/^[a-z]{2}-[A-Z]{2}/)?.[0] ?? 'en-US') as string;
  const chunks = chunkText(text, 4500);
  const partFiles: string[] = [];

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45_000);
      let response: Response;
      try {
        response = await fetch(
          `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(config.googleTtsKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              input: { text: chunk },
              voice: {
                languageCode,
                ...(config.googleTtsVoice ? { name: config.googleTtsVoice } : {}),
              },
              audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0 },
            }),
            signal: controller.signal,
          },
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new AppError(response.status === 403 ? 401 : 502, `Google TTS failed (${response.status}). ${detail}`, {
          retryable: response.status >= 500 || response.status === 429,
        });
      }

      const payload = (await response.json()) as { audioContent?: string };
      if (!payload.audioContent) throw upstreamError('Google TTS returned no audio content.');

      const partFile = `${outFile}.part-${index}.mp3`;
      await fsp.writeFile(partFile, Buffer.from(payload.audioContent, 'base64'));
      partFiles.push(partFile);
    }

    await fsp.rm(outFile, { force: true });
    if (partFiles.length === 1) await fsp.rename(partFiles[0]!, outFile);
    else await concatMp3(partFiles, outFile);
  } finally {
    await Promise.all(partFiles.map((part) => fsp.rm(part, { force: true }).catch(() => undefined)));
  }
}

export interface SynthesizeInput {
  script: string;
  voice?: string;
  videoId: string;
}

export async function synthesizeSpeech(input: SynthesizeInput): Promise<SpeechResult> {
  const text = prepareText(input.script);
  if (text.length < 20) throw badRequest('The script is too short to turn into a voiceover.');

  const voice = (input.voice ?? config.defaultVoice).trim() || config.defaultVoice;
  const outFile = path.join(paths.audio, `${input.videoId}.mp3`);

  const order: Array<'edge' | 'google'> =
    config.ttsProvider === 'google' ? ['google', 'edge'] : ['edge', 'google'];

  let lastError: unknown;

  for (const provider of order) {
    if (provider === 'google' && !config.googleTtsKey) continue;
    try {
      if (provider === 'edge') await synthesizeWithEdge(text, voice, outFile);
      else await synthesizeWithGoogle(text, voice, outFile);

      const stats = await fsp.stat(outFile);
      if (stats.size < 1024) throw upstreamError('The generated MP3 is empty.');
      const durationSeconds = await probeDuration(outFile).catch(() => null);

      return { filePath: outFile, provider, durationSeconds, bytes: stats.size, voice };
    } catch (error) {
      lastError = error;
      logger.warn(`${provider} TTS failed for video ${input.videoId}: ${errorMessage(error)}`);
      await fsp.rm(outFile, { force: true }).catch(() => undefined);
    }
  }

  throw lastError instanceof Error ? lastError : upstreamError('Text-to-speech failed for every provider.');
}
