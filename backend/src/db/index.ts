import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { assertProductionStoreConfig, assertTokenEncryptionConfig, config, paths } from '../config.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/retry.js';
import { MemoryStore } from './memoryStore.js';
import { PgStore } from './pgStore.js';
import type { Store } from './types.js';

// Return timestamps as ISO strings so JSON responses and types are predictable.
pg.types.setTypeParser(1184, (value: string) => new Date(value).toISOString()); // timestamptz
pg.types.setTypeParser(1114, (value: string) => new Date(`${value}Z`).toISOString()); // timestamp
pg.types.setTypeParser(20, (value: string) => Number(value)); // int8 -> number

let pool: pg.Pool | null = null;
let store: Store | null = null;

function schemaPath(): string {
  const candidates = [
    path.join(import.meta.dirname, 'schema.sql'),
    path.join(paths.backend, 'src', 'db', 'schema.sql'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`schema.sql not found. Looked in: ${candidates.join(', ')}`);
}

async function connectWithRetry(client: pg.Pool, attempts = 5): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await client.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      logger.warn(`Postgres not ready (attempt ${attempt}/${attempts}); retrying in 2s.`);
      await sleep(2000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not connect to Postgres.');
}

export async function initStore(): Promise<Store> {
  if (store) return store;

  // Both guards run before a connection is opened or a request is accepted. The store check comes
  // first so a production boot missing DATABASE_URL names that variable, not this one.
  assertProductionStoreConfig({ nodeEnv: config.nodeEnv, databaseUrl: config.databaseUrl });
  // Production must not write OAuth tokens in plaintext, and a malformed key must fail here rather
  // than on the first token refresh.
  assertTokenEncryptionConfig({ nodeEnv: config.nodeEnv, tokenEncryptionKey: config.tokenEncryptionKey });

  if (!config.databaseUrl) {
    logger.warn('DATABASE_URL is not set — using the in-memory dev store. Data is lost on restart.');
    store = new MemoryStore();
    return store;
  }

  pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });
  pool.on('error', (error) => logger.error('Unexpected Postgres pool error', error));

  await connectWithRetry(pool);
  const sql = fs.readFileSync(schemaPath(), 'utf8');
  await pool.query(sql);
  logger.info('Postgres connected and schema ensured.');

  store = new PgStore(pool);
  return store;
}

export function getStore(): Store {
  if (!store) throw new Error('Store is not initialised. Call initStore() during startup.');
  return store;
}

export function getPool(): pg.Pool | null {
  return pool;
}

export async function closeStore(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  store = null;
}
