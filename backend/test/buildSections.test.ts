import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSections } from '../src/services/ffmpeg.js';

const SCRIPT = `[00:00] Saving money is a habit, not an event. Start with one automatic transfer on payday.

[00:12] Keep fixed costs below half of your income. Review the numbers once a month.

[00:30] Adjust one category at a time instead of rebuilding the whole budget. That is the entire system.

[00:45] Track every expense for two weeks so the plan reflects real spending. Then automate the boring parts.
`;

const sentence = (index: number): string =>
  `Sentence number ${index} contains exactly nine plain words here.`;

test('section durations fill the audio and end exactly at its length', () => {
  const audioDuration = 42.5;
  const sections = buildSections(SCRIPT, audioDuration, 'personal finance');

  assert.ok(sections.length >= 2, 'expected the script to split into multiple sections');

  const total = sections.reduce((sum, section) => sum + section.duration, 0);
  assert.ok(Math.abs(total - audioDuration) < 0.001, `durations summed to ${total}, expected ${audioDuration}`);

  const last = sections[sections.length - 1]!;
  assert.ok(Math.abs(last.start + last.duration - audioDuration) < 0.001, 'last section must end at the audio end');
});

test('sections are contiguous and start at zero', () => {
  const sections = buildSections(SCRIPT, 30, 'personal finance');
  assert.equal(sections[0]!.start, 0);

  for (let index = 1; index < sections.length; index += 1) {
    const previous = sections[index - 1]!;
    const current = sections[index]!;
    assert.ok(
      Math.abs(current.start - (previous.start + previous.duration)) < 1e-9,
      `gap or overlap before section ${index}`,
    );
  }
});

test('every section has a positive duration, word count and keyword', () => {
  const sections = buildSections(SCRIPT, 30, 'personal finance');

  for (const section of sections) {
    assert.ok(section.duration > 0, 'duration must be positive');
    assert.ok(section.words > 0, 'word count must be positive');
    assert.ok(section.text.trim().length > 0, 'text must not be blank');
    assert.ok(section.keywords.length > 0, 'every section needs at least one stock-footage keyword');
  }
});

test('timestamps and markdown never reach the spoken text', () => {
  const script = `**Hook:** [00:00] This is the first spoken line.

## Section heading

[00:10] This is the second spoken line with a few more words in it.`;

  const sections = buildSections(script, 20, 'finance');
  const spoken = sections.map((section) => section.text).join(' ');

  assert.ok(!spoken.includes('[00:00]'), 'timestamp cues must be stripped');
  assert.ok(!spoken.includes('[00:10]'), 'timestamp cues must be stripped');
  assert.ok(!spoken.includes('**'), 'markdown emphasis must be stripped');
  assert.ok(!spoken.includes('##'), 'markdown headings must be stripped');
  assert.match(spoken, /first spoken line/);
  assert.match(spoken, /second spoken line/);
});

test('a section with five times the words receives about five times the time', () => {
  const script = [1, 2, 3, 4, 5, 6].map(sentence).join(' ');
  const sections = buildSections(script, 30, 'finance');

  assert.equal(sections.length, 2, 'six nine-word sentences should split into 5 + 1');
  assert.equal(sections[0]!.words, 45);
  assert.equal(sections[1]!.words, 9);

  const ratio = sections[0]!.duration / sections[1]!.duration;
  assert.ok(ratio > 4.8 && ratio < 5.2, `expected a ~5x duration ratio, got ${ratio.toFixed(2)}`);
});

test('empty or wordless scripts produce no sections', () => {
  assert.deepEqual(buildSections('', 10), []);
  assert.deepEqual(buildSections('   \n\n  ', 10), []);
  assert.deepEqual(buildSections('Word', 10), []);
  assert.deepEqual(buildSections('A full sentence exists here.', 0), []);
});
