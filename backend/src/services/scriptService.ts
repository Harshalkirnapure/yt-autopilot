import { unavailable } from '../utils/errors.js';
import { generateText } from './gemini.js';

export interface ScriptInput {
  topic: string;
  niche: string;
  audience: string;
  language: string;
  length?: number;
}

const FORBIDDEN_OPENERS = [/^\s*namaste\b/i, /^\s*hello friends\b/i, /^\s*hi friends\b/i];

function cleanScript(raw: string): string {
  let script = raw.trim();

  if (script.startsWith('```')) {
    script = script.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
  }

  const lines = script.split('\n');
  while (lines.length > 1 && FORBIDDEN_OPENERS.some((pattern) => pattern.test(lines[0] ?? ''))) {
    lines.shift();
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function generateScript(input: ScriptInput): Promise<string> {
  const length = input.length && input.length > 100 ? Math.min(input.length, 4000) : 700;

  const prompt = [
    `Write a YouTube script for a "${input.niche}" channel.`,
    `Target audience: ${input.audience}.`,
    `Language and tone: ${input.language}.`,
    `Video topic: ${input.topic}.`,
    `Length: approximately ${length} spoken words.`,
    '',
    'Structure the script exactly like this, using plain text with section headings:',
    '1. A 15-second hook that starts with a specific, surprising statement (never "Namaste", "Hello friends", or "In this video").',
    '2. A short intro that states the payoff for the viewer.',
    '3. Four to six sections with a timestamp line above each (for example [01:05]) and a clear spoken transition.',
    '4. A call to action that fits the topic (subscribe for the follow-up series, comment a specific question, or download a checklist).',
    '',
    'Writing rules:',
    '- Write only words that will be spoken aloud; no camera directions, no shot lists, no emoji, no stage cues.',
    '- Use short sentences and concrete examples; no filler phrases.',
    '- Do not quote or summarise third-party videos, and do not instruct viewers to download other people\'s content.',
    '- Keep claims accurate and avoid promising guaranteed financial or medical outcomes.',
    '- End with a 10-second outro that teases the next episode.',
  ].join('\n');

  const raw = await generateText(prompt, { temperature: 0.9, maxOutputTokens: 4096 });
  const script = cleanScript(raw);

  if (script.length < 200) {
    throw unavailable('The AI returned a script that is too short. Please try again.');
  }

  return script;
}
