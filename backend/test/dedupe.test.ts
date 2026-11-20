import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { getStore, initStore } from '../src/db/index.js';
import { MemoryStore } from '../src/db/memoryStore.js';
import {
  fallbackTopics,
  filterUnusedTopics,
  generateTopics,
  isDuplicate,
} from '../src/services/topicService.js';

before(async () => {
  const store = await initStore();
  assert.equal(store.mode, 'memory', 'tests must run against the in-memory store');
});

test('clip ledger records a Pexels clip exactly once', async () => {
  const store = new MemoryStore();

  assert.equal(await store.isClipUsed('12345'), false);
  await store.markClipUsed('12345', 'video-a');
  await store.markClipUsed('12345', 'video-b');

  assert.equal(await store.isClipUsed('12345'), true);
  assert.equal(await store.countUsedClips(), 1, 're-marking a clip must not duplicate the ledger row');
});

test('used topics are stored once regardless of casing', async () => {
  const store = new MemoryStore();
  await store.addUsedTopic('Budgeting 101');
  await store.addUsedTopic('budgeting 101');

  const recent = await store.recentTopics();
  assert.equal(recent.length, 1);
});

test('near-duplicate topics are detected, unrelated ones are not', () => {
  assert.equal(isDuplicate('Budgeting 101: The Basics', 'budgeting 101 the basics'), true);
  assert.equal(isDuplicate('Personal finance: 5 mistakes beginners make', 'Personal finance 5 mistakes beginners make!'), true);
  assert.equal(isDuplicate('Budgeting 101', 'Investing for beginners'), false);
});

test('filterUnusedTopics drops used topics and in-batch repeats', () => {
  const suggestions = [
    { title: 'Alpha topic for savers', angle: '', keywords: [] },
    { title: 'alpha topic for savers!', angle: '', keywords: [] },
    { title: 'Beta topic for budgeters', angle: '', keywords: [] },
    { title: 'Gamma topic for investors', angle: '', keywords: [] },
  ];

  const accepted = filterUnusedTopics(suggestions, ['Beta topic for budgeters'], 5);

  assert.deepEqual(
    accepted.map((topic) => topic.title),
    ['Alpha topic for savers', 'Gamma topic for investors'],
  );
});

test('filterUnusedTopics stops at the requested count', () => {
  const suggestions = [
    { title: 'Alpha topic for savers', angle: '', keywords: [] },
    { title: 'Gamma topic for investors', angle: '', keywords: [] },
  ];

  assert.equal(filterUnusedTopics(suggestions, [], 1).length, 1);
});

test('generateTopics fills six slots without repeating a used fallback topic', async () => {
  const store = getStore();
  const input = { niche: 'personal finance', audience: 'beginners', language: 'English' };
  const blocked = fallbackTopics(input)[0]!.title;

  await store.addUsedTopic(blocked, input.niche);

  const result = await generateTopics(input);

  assert.equal(result.source, 'fallback', 'no Gemini key is set, so the template path must be used');
  assert.equal(result.topics.length, 6);
  assert.ok(
    !result.topics.some((topic) => isDuplicate(topic.title, blocked)),
    `used topic "${blocked}" must not be suggested again`,
  );
  assert.equal(new Set(result.topics.map((topic) => topic.title)).size, 6, 'suggestions must be unique');
});
