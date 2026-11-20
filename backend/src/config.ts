import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** backend/ directory, both when running from src (tsx) and from dist (node). */
const backendRoot = path.resolve(import.meta.dirname, '..');

const uploadsRoot = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.resolve(backendRoot, '..', 'uploads');

export const paths = {
  backend: backendRoot,
  frontend: path.resolve(backendRoot, '..', 'frontend'),
  uploads: uploadsRoot,
  audio: path.join(uploadsRoot, 'audio'),
  clips: path.join(uploadsRoot, 'clips'),
  videos: path.join(uploadsRoot, 'videos'),
  thumbnails: path.join(uploadsRoot, 'thumbnails'),
  temp: path.join(uploadsRoot, 'temp'),
} as const;

for (const dir of Object.values(paths)) {
  fs.mkdirSync(dir, { recursive: true });
}

function envString(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

const apiTokenFile = path.join(backendRoot, '.api-token');

/**
 * There is no unauthenticated mode: without API_TOKEN a random token is generated once and
 * kept in a gitignored file, so restarts don't invalidate sessions and nothing is exposed.
 */
function resolveApiToken(): { token: string; source: 'env' | 'file' } {
  const fromEnv = envString('API_TOKEN');
  if (fromEnv) return { token: fromEnv, source: 'env' };

  try {
    const existing = fs.readFileSync(apiTokenFile, 'utf8').trim();
    if (existing.length >= 32) return { token: existing, source: 'file' };
  } catch {
    /* first run: no token file yet */
  }

  const token = randomBytes(24).toString('hex');
  fs.writeFileSync(apiTokenFile, `${token}\n`, { mode: 0o600 });
  return { token, source: 'file' };
}

const apiToken = resolveApiToken();

const port = envNumber('PORT', 3000);
const publicBaseUrl = envString('PUBLIC_BASE_URL', `http://localhost:${port}`);

export const config = {
  nodeEnv: envString('NODE_ENV', 'development'),
  port,
  // Loopback by default: the API is a single-user studio, not a network service.
  host: envString('HOST', '127.0.0.1'),
  publicBaseUrl,

  // Access control
  apiToken: apiToken.token,
  apiTokenSource: apiToken.source,
  apiTokenFile,
  approverName: envString('APPROVER_NAME', process.env.USERNAME ?? process.env.USER ?? 'owner'),

  // Persistence
  databaseUrl: envString('DATABASE_URL'),
  databaseSsl: envBool('DATABASE_SSL', false),
  redisUrl: envString('REDIS_URL'),
  runWorker: envBool('RUN_WORKER', true),

  // AI
  geminiApiKey: envString('GEMINI_API_KEY'),
  geminiModel: envString('GEMINI_MODEL', 'gemini-2.5-flash'),
  geminiBaseUrl: envString('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com'),

  // Text to speech
  ttsProvider: envString('TTS_PROVIDER', 'edge').toLowerCase(),
  googleTtsKey: envString('GOOGLE_TTS_KEY'),
  googleTtsVoice: envString('GOOGLE_TTS_VOICE'),
  defaultVoice: envString('TTS_VOICE', 'en-IN-NeerjaNeural'),
  ttsRate: envString('TTS_RATE', '+0%'),

  // Visuals
  pexelsApiKey: envString('PEXELS_API_KEY'),

  // YouTube
  ytClientId: envString('YT_CLIENT_ID'),
  ytClientSecret: envString('YT_CLIENT_SECRET'),
  ytRedirectUri: envString('YT_REDIRECT_URI', `${publicBaseUrl}/api/youtube/callback`),
  ytAuditPassed: envBool('YT_AUDIT_PASSED', false),
  // The narration is synthesised and the visuals are assembled, so YouTube's altered/synthetic
  // disclosure (status.containsSyntheticMedia) is on unless explicitly turned off.
  ytDiscloseSyntheticMedia: envBool('YT_DISCLOSE_SYNTHETIC_MEDIA', true),
  ytCategoryId: envString('YT_CATEGORY_ID', '22'),
  // BCP-47 code of the uploaded caption track (the narration is English unless you change TTS).
  ytCaptionLanguage: envString('YT_CAPTION_LANGUAGE', 'en'),
  maxUploadsPerDay: envNumber('MAX_UPLOADS_PER_DAY', 6),

  // Admin alerts
  telegramBotToken: envString('TELEGRAM_BOT_TOKEN'),
  telegramChatId: envString('TELEGRAM_CHAT_ID'),

  // Scheduler
  schedulerEnabled: envBool('SCHEDULER_ENABLED', false),
  cronSchedule: envString('CRON_SCHEDULE', '0 18 * * *'),
  cronTimezone: envString('CRON_TIMEZONE', 'Asia/Kolkata'),
  // A boot with no run inside this window is treated as a missed schedule (see catchUpScheduledRun).
  catchUpAfterHours: envNumber('PIPELINE_CATCH_UP_HOURS', 24),
  // A run only closes its ledger row when it finishes (minutes, not hours; the render it enqueues is
  // tracked separately), so a row still `running` after this long belongs to a dead process.
  pipelineStaleRunMs: envNumber('PIPELINE_STALE_RUN_MINUTES', 120) * 60 * 1000,
  defaultNiche: envString('DEFAULT_NICHE', 'personal finance'),
  defaultAudience: envString('DEFAULT_AUDIENCE', 'young professionals in India'),
  defaultLanguage: envString('DEFAULT_LANGUAGE', 'English (India), conversational'),
  defaultScriptLength: envNumber('DEFAULT_SCRIPT_LENGTH', 700),

  // Media
  ffmpegPath: envString('FFMPEG_PATH'),
  ffprobePath: envString('FFPROBE_PATH'),
  renderTimeoutMs: envNumber('RENDER_TIMEOUT_MS', 30 * 60 * 1000),
  maxUploadsPerDayHardLimit: 6,
} as const;

/**
 * Production must never fall back to the in-memory store. It loses every draft, log and approval on
 * restart, and its topic/clip dedupe ledgers reset, so the same topic and footage could be published
 * again. Development and tests keep the in-memory convenience; production has to fail loudly.
 */
export function assertProductionStoreConfig(input: { nodeEnv: string; databaseUrl: string }): void {
  const isProduction = input.nodeEnv.trim().toLowerCase() === 'production';
  if (!isProduction || input.databaseUrl.trim() !== '') return;

  throw new Error(
    'Refusing to start: NODE_ENV=production requires DATABASE_URL. ' +
      'The in-memory store is development-only and would lose every video, log and approval on restart, ' +
      'while resetting the topic and clip dedupe ledgers. Set DATABASE_URL (see backend/.env.example) ' +
      'or unset NODE_ENV to run in development.',
  );
}

/**
 * Renders run inside the API process when there is no Redis queue. That is fine locally but worth a
 * loud warning: the render shares the API's event loop and dies with it on restart/deploy.
 */
export function inlineRenderWarning(input: { redisUrl: string; nodeEnv: string }): string | null {
  if (input.redisUrl.trim() !== '') return null;

  const productionNote =
    input.nodeEnv.trim().toLowerCase() === 'production'
      ? ' In production a restart or deploy will kill the render mid-flight.'
      : '';

  return (
    'REDIS_URL is not set: render jobs run inline inside the API process instead of the BullMQ queue,' +
    ` so a crash, restart or deploy loses the in-progress render.${productionNote}`
  );
}

export interface ConfigStatus {
  database: string;
  redis: string;
  gemini: boolean;
  pexels: boolean;
  youtube: boolean;
  tts: string;
  alerts: boolean;
}

export function configStatus(): ConfigStatus {
  return {
    database: config.databaseUrl ? 'postgres' : 'memory',
    redis: config.redisUrl ? 'configured' : 'inline',
    gemini: Boolean(config.geminiApiKey),
    pexels: Boolean(config.pexelsApiKey),
    youtube: Boolean(config.ytClientId && config.ytClientSecret),
    tts: config.ttsProvider === 'google' ? 'google' : 'edge',
    alerts: Boolean(config.telegramBotToken && config.telegramChatId),
  };
}
