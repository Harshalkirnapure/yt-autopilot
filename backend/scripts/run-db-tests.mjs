// Integration suite against a real PostgreSQL server (docker-compose `postgres`).
//
//   docker compose up -d postgres
//   cd backend && npm run test:db
//
// The runner creates a throwaway database (default `yt_autopilot_test`), points DATABASE_URL at
// it, and never touches the development database from backend/.env.
import { spawn } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';

const root = path.resolve(import.meta.dirname, '..');
const testDatabase = process.env.PG_TEST_DATABASE?.trim() || 'yt_autopilot_test';

/** The app's connection string, or the docker-compose default when nothing is configured. */
const baseUrl = process.env.DATABASE_URL?.trim() || 'postgresql://yt:yt@localhost:5432/yt_autopilot';

if (!/_test$/.test(testDatabase)) {
  console.error(`Refusing to run: PG_TEST_DATABASE must end with "_test" (got "${testDatabase}").`);
  process.exit(1);
}

function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const useSsl = /^(1|true|yes|on)$/i.test(process.env.DATABASE_SSL?.trim() ?? '');
const ssl = useSsl ? { rejectUnauthorized: false } : undefined;
const adminUrl = withDatabase(baseUrl, 'postgres');
const testUrl = withDatabase(baseUrl, testDatabase);

const admin = new pg.Client({ connectionString: adminUrl, ssl, connectionTimeoutMillis: 5000 });

try {
  await admin.connect();
} catch (error) {
  console.error(
    [
      '',
      `Cannot reach PostgreSQL at ${adminUrl.replace(/:[^:@/]+@/, ':***@')}.`,
      error instanceof Error ? `  ${error.message}` : '',
      '',
      'This suite needs the docker-compose database:',
      '  docker compose up -d postgres      # from the repository root, then wait for "healthy"',
      '  cd backend && npm run test:db',
      '',
      'Set DATABASE_URL to point somewhere else, e.g.',
      '  DATABASE_URL=postgresql://yt:yt@localhost:5432/yt_autopilot npm run test:db',
      '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  process.exit(1);
}

try {
  // Start from an empty database every run so a stale schema can never mask a migration bug.
  await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${testDatabase}"`);
} finally {
  await admin.end();
}

console.log(`Postgres integration tests against ${testUrl.replace(/:[^:@/]+@/, ':***@')}\n`);

const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: testUrl,
  REDIS_URL: '',
  SCHEDULER_ENABLED: 'false',
  YT_AUDIT_PASSED: 'false',
  API_TOKEN: 'test-token',
  APPROVER_NAME: 'test-approver',
};

for (const key of [
  'GEMINI_API_KEY',
  'GOOGLE_TTS_KEY',
  'PEXELS_API_KEY',
  'YT_CLIENT_ID',
  'YT_CLIENT_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
]) {
  env[key] = '';
}

const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-reporter=spec', path.join(root, 'test/db.test.ts')],
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
