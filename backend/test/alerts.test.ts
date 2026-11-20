import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { closeStore, getStore, initStore } from '../src/db/index.js';
import { notifyAdmin } from '../src/services/alerts.js';

/**
 * With Telegram configured an alert leaves the process; without it, the only trace used to be a
 * process-log warning, which is invisible in the studio UI and gone after a restart. These tests
 * run with the Telegram variables blanked by scripts/run-tests.mjs, so every alert must land in
 * job_logs as an activity-log row.
 */

before(async () => {
  const store = await initStore();
  assert.equal(store.mode, 'memory', 'tests must run against the in-memory store');
});

after(async () => {
  await closeStore();
});

test('an alert without Telegram is still written to the activity log', async () => {
  assert.equal(config.telegramBotToken, '', 'the test runner blanks TELEGRAM_BOT_TOKEN');
  assert.equal(config.telegramChatId, '', 'the test runner blanks TELEGRAM_CHAT_ID');

  await notifyAdmin('Render finished for a draft and is waiting for review.');
  await notifyAdmin('Render failed: FFmpeg could not be started.', 'error');

  const alerts = (await getStore().listLogs(null, 20)).filter((row) => row.step === 'alert');
  assert.equal(alerts.length, 2, 'both alerts are persisted, not just logged');

  const messages = alerts.map((row) => row.message ?? '');
  assert.ok(messages.some((message) => /waiting for review/.test(message)));
  assert.ok(messages.some((message) => /FFmpeg could not be started/.test(message)));

  const failure = alerts.find((row) => /FFmpeg could not be started/.test(row.message ?? ''));
  assert.equal(failure?.status, 'warning', 'a failure alert is stored as a warning, not a failure');
  assert.equal(failure?.video_id, null, 'alerts are channel-level rows');
});
