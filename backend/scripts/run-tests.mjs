// Runs the focused test suite with no DATABASE_URL and no API keys, so nothing
// touches Postgres, Redis or an external API.
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

const env = {
  ...process.env,
  NODE_ENV: 'test',
  MAX_UPLOADS_PER_DAY: '6',
  YT_AUDIT_PASSED: 'false',
  SCHEDULER_ENABLED: 'false',
  // Fixed token so the tests never read (or create) the real backend/.api-token.
  API_TOKEN: 'test-token',
  APPROVER_NAME: 'test-approver',
};

for (const key of [
  'DATABASE_URL',
  'REDIS_URL',
  'GEMINI_API_KEY',
  'GOOGLE_TTS_KEY',
  'PEXELS_API_KEY',
  'YT_CLIENT_ID',
  'YT_CLIENT_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
]) {
  // dotenv never overrides an existing key, so an empty value here also masks backend/.env.
  env[key] = '';
}

const files = [
  'test/buildSections.test.ts',
  'test/render.test.ts',
  'test/concatMp3.test.ts',
  'test/dedupe.test.ts',
  'test/quota.test.ts',
  'test/uploadClaim.test.ts',
  'test/uploadIdempotency.test.ts',
  'test/auth.test.ts',
  'test/pipelineRuns.test.ts',
  'test/alerts.test.ts',
  'test/startupConfig.test.ts',
  'test/reconciliation.test.ts',
  'test/publish.test.ts',
  'test/disclosure.test.ts',
].map((file) => path.join(root, file));

// One file at a time: they share the uploads directory, and the startup-cleanup and render tests
// would delete each other's scratch files (render-*, .part, .yt-captions-*.ass) if they overlapped.
const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=spec', ...files],
  { cwd: root, env, stdio: 'inherit' },
);

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
