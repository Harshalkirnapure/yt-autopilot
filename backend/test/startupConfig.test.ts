import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  assertProductionStoreConfig,
  assertTokenEncryptionConfig,
  inlineRenderWarning,
} from '../src/config.js';

const VALID_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';

/* -------------------------------------------------------------------------- */
/* Production must never run on the in-memory store                           */
/* -------------------------------------------------------------------------- */

test('production without DATABASE_URL refuses to start', () => {
  assert.throws(
    () => assertProductionStoreConfig({ nodeEnv: 'production', databaseUrl: '' }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /NODE_ENV=production requires DATABASE_URL/);
      assert.match(message, /in-memory store/);
      return true;
    },
  );

  // A blank value is the same as a missing one.
  assert.throws(() =>
    assertProductionStoreConfig({ nodeEnv: 'production', databaseUrl: '   ' }),
  );
  // Case and stray whitespace in NODE_ENV do not open a loophole.
  assert.throws(() =>
    assertProductionStoreConfig({ nodeEnv: ' Production ', databaseUrl: '' }),
  );
});

test('production with a database, and every non-production mode, is allowed', () => {
  assert.doesNotThrow(() =>
    assertProductionStoreConfig({ nodeEnv: 'production', databaseUrl: 'postgres://localhost/yt' }),
  );
  for (const nodeEnv of ['development', 'test', '']) {
    assert.doesNotThrow(
      () => assertProductionStoreConfig({ nodeEnv, databaseUrl: '' }),
      `${nodeEnv || 'unset'} NODE_ENV may use the in-memory store`,
    );
  }
});

test('the running store actually refuses to boot in production without DATABASE_URL', async () => {
  // The guard lives in the module loaded at startup, so prove it through a real process rather than
  // by inspecting the function in isolation.
  const script =
    "const { initStore } = await import('./src/db/index.ts'); await initStore(); console.log('STORE_READY');";
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: '',
      REDIS_URL: '',
      API_TOKEN: 'test-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(null));
    child.on('exit', (code) => resolve(code));
  });

  assert.match(output, /DATABASE_URL/, 'the failure names the missing variable');
  assert.doesNotMatch(output, /STORE_READY/, 'it must never reach the in-memory fallback');
  assert.notEqual(exitCode, 0, 'the process must exit as a failure');
});

/* -------------------------------------------------------------------------- */
/* Production must not store OAuth tokens in plaintext                        */
/* -------------------------------------------------------------------------- */

test('production without TOKEN_ENCRYPTION_KEY refuses to start', () => {
  assert.throws(
    () => assertTokenEncryptionConfig({ nodeEnv: 'production', tokenEncryptionKey: '' }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /NODE_ENV=production requires TOKEN_ENCRYPTION_KEY/);
      assert.match(message, /plaintext/);
      assert.match(message, /openssl rand -base64 32/, 'it says how to make a key');
      return true;
    },
  );

  // A blank value is the same as a missing one, and NODE_ENV is matched case-insensitively.
  assert.throws(() => assertTokenEncryptionConfig({ nodeEnv: 'production', tokenEncryptionKey: '   ' }));
  assert.throws(() => assertTokenEncryptionConfig({ nodeEnv: ' Production ', tokenEncryptionKey: '' }));
});

test('production with a key, and every non-production mode without one, is allowed', () => {
  assert.doesNotThrow(() =>
    assertTokenEncryptionConfig({ nodeEnv: 'production', tokenEncryptionKey: VALID_KEY }),
  );
  assert.doesNotThrow(() =>
    assertTokenEncryptionConfig({ nodeEnv: 'production', tokenEncryptionKey: Buffer.from(VALID_KEY, 'hex').toString('base64') }),
  );
  for (const nodeEnv of ['development', 'test', '']) {
    assert.doesNotThrow(
      () => assertTokenEncryptionConfig({ nodeEnv, tokenEncryptionKey: '' }),
      `${nodeEnv || 'unset'} NODE_ENV may run without a key`,
    );
  }
});

test('a malformed key is rejected in every mode, not only production', () => {
  assert.throws(
    () => assertTokenEncryptionConfig({ nodeEnv: 'development', tokenEncryptionKey: 'not-a-key' }),
    /TOKEN_ENCRYPTION_KEY must be 32 bytes/,
  );
});

test('the store actually refuses to boot in production without the key', async () => {
  const script =
    "const { initStore } = await import('./src/db/index.ts'); await initStore(); console.log('STORE_READY');";
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      // Set, so the store guard passes and the token guard is what stops the boot. Nothing connects:
      // the key check runs before the pool exists.
      DATABASE_URL: 'postgresql://postgres@127.0.0.1:1/unreachable',
      TOKEN_ENCRYPTION_KEY: '',
      REDIS_URL: '',
      API_TOKEN: 'test-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(null));
    child.on('exit', (code) => resolve(code));
  });

  assert.match(output, /TOKEN_ENCRYPTION_KEY/, 'the failure names the missing variable');
  assert.doesNotMatch(output, /STORE_READY/, 'it never reaches a store');
  assert.notEqual(exitCode, 0, 'the process must exit as a failure');
});

/* -------------------------------------------------------------------------- */
/* Inline rendering without Redis                                             */
/* -------------------------------------------------------------------------- */

test('missing REDIS_URL produces a clear inline-rendering warning', () => {
  const warning = inlineRenderWarning({ redisUrl: '', nodeEnv: 'development' });
  assert.ok(warning);
  assert.match(warning, /REDIS_URL is not set/);
  assert.match(warning, /inline inside the API process/);

  const productionWarning = inlineRenderWarning({ redisUrl: '', nodeEnv: 'production' });
  assert.ok(productionWarning);
  assert.match(productionWarning, /in production/i);

  assert.equal(inlineRenderWarning({ redisUrl: 'redis://localhost:6379', nodeEnv: 'production' }), null);
});
