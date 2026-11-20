import { getStore } from '../db/index.js';
import { errorMessage, logger } from '../utils/logger.js';
import { generateJson } from './gemini.js';

export interface TopicSuggestion {
  title: string;
  angle: string;
  keywords: string[];
}

export interface TopicInput {
  niche: string;
  audience: string;
  language: string;
}

export interface TopicsResult {
  topics: TopicSuggestion[];
  source: 'gemini' | 'fallback';
  requested: number;
}

interface RawTopicsResponse {
  topics?: Array<{ title?: unknown; angle?: unknown; keywords?: unknown }>;
}

const TARGET_COUNT = 6;

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(normalise(value).split(' ').filter((word) => word.length > 2));
}

/** True when the title is close enough to a generated one to count as a repeat. */
export function isDuplicate(candidate: string, existing: string): boolean {
  const a = normalise(candidate);
  const b = normalise(existing);
  if (!a || !b) return false;
  if (a === b) return true;
  const tokensA = tokenSet(a);
  const tokensB = tokenSet(b);
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  let shared = 0;
  for (const token of tokensA) if (tokensB.has(token)) shared += 1;
  return shared / Math.max(tokensA.size, tokensB.size) >= 0.8;
}

/** Removes already-used topics and in-batch near-duplicates, keeping the first `count` winners. */
export function filterUnusedTopics(
  suggestions: TopicSuggestion[],
  recent: string[],
  count: number,
): TopicSuggestion[] {
  const accepted: TopicSuggestion[] = [];
  const seen: string[] = [...recent];

  for (const suggestion of suggestions) {
    if (!suggestion.title || !suggestion.title.trim()) continue;
    if (seen.some((topic) => isDuplicate(topic, suggestion.title))) continue;
    accepted.push(suggestion);
    seen.push(suggestion.title);
    if (accepted.length >= count) break;
  }
  return accepted;
}

function keywordsFor(niche: string, extra: string[] = []): string[] {
  const base = niche
    .split(/[\s,/]+/)
    .map((word) => word.replace(/[^a-z0-9]/gi, '').toLowerCase())
    .filter((word) => word.length > 2)
    .slice(0, 2);
  const merged = [...new Set([...extra, ...base])].filter(Boolean);
  return merged.slice(0, 3);
}

export function fallbackTopics(input: TopicInput): TopicSuggestion[] {
  const niche = input.niche.trim() || 'your niche';
  const audience = input.audience.trim() || 'beginners';
  const titleCase = niche.charAt(0).toUpperCase() + niche.slice(1);

  const templates: Array<{ title: string; angle: string }> = [
    {
      title: `${titleCase}: 5 mistakes beginners make (and how to avoid them)`,
      angle: 'Common pitfalls explained with concrete fixes the viewer can apply today.',
    },
    {
      title: `The 10-minute ${niche} routine that actually works`,
      angle: 'A practical, repeatable routine framed around a tight time budget.',
    },
    {
      title: `${titleCase} myths ${audience} should stop believing`,
      angle: 'Myth-busting format that clears up confusion and builds trust.',
    },
    {
      title: `How ${audience} can start ${niche} with almost no budget`,
      angle: 'Zero-to-first-result roadmap for people with limited resources.',
    },
    {
      title: `${titleCase} in 2026: what changed and what to do next`,
      angle: 'Timely update that positions the channel as current and informed.',
    },
    {
      title: `A step-by-step ${niche} checklist for complete beginners`,
      angle: 'Checklist format with a clear, actionable sequence of steps.',
    },
    {
      title: `Why your ${niche} progress stalls (and the fix)`,
      angle: 'Diagnoses a specific frustration the audience already feels.',
    },
    {
      title: `${titleCase} explained in plain language`,
      angle: 'Beginner-friendly explainer with simple analogies and examples.',
    },
  ];

  // Return every template so the dedupe pass can still fill `count` when some are already used.
  return templates.map((template) => ({
    title: template.title,
    angle: template.angle,
    keywords: keywordsFor(niche),
  }));
}

export async function generateTopics(input: TopicInput, count = TARGET_COUNT): Promise<TopicsResult> {
  const store = getStore();
  const recent = await store.recentTopics(40);

  const prompt = [
    `You are a YouTube content strategist for a "${input.niche}" channel.`,
    `Target audience: ${input.audience}.`,
    `Output language and tone: ${input.language}.`,
    '',
    `Suggest ${count} original video topics that are specific, searchable and evergreen.`,
    'Each topic must be different from these already-used topics:',
    recent.length ? recent.map((topic) => `- ${topic}`).join('\n') : '- (none yet)',
    '',
    'Rules:',
    '- No clickbait that the video cannot deliver on.',
    '- No re-uploads, reaction content, or topics requiring third-party footage.',
    '- Each topic must be producible with stock footage, screen recordings or AI-generated visuals.',
    '- Titles must be under 80 characters and must not start with "Namaste" or "Hello friends".',
    '- Keywords must be short stock-footage search phrases (1-3 words) that match the topic.',
    '',
    'Respond with JSON only, matching this shape:',
    '{"topics":[{"title":"...","angle":"one sentence on the unique angle","keywords":["...","..."]}]}',
  ].join('\n');

  let suggestions: TopicSuggestion[] = [];
  let source: TopicsResult['source'] = 'gemini';

  try {
    const raw = await generateJson<RawTopicsResponse>(prompt, { temperature: 0.9, maxOutputTokens: 2048 });
    suggestions = (raw.topics ?? [])
      .map((entry) => {
        const title = typeof entry.title === 'string' ? entry.title.trim() : '';
        const angle = typeof entry.angle === 'string' ? entry.angle.trim() : '';
        const keywords = Array.isArray(entry.keywords)
          ? entry.keywords.filter((keyword): keyword is string => typeof keyword === 'string').map((k) => k.trim())
          : [];
        return { title, angle, keywords: keywords.slice(0, 4) };
      })
      .filter((entry) => entry.title.length >= 8)
      .map((entry) => ({
        ...entry,
        keywords: entry.keywords.length ? entry.keywords : keywordsFor(input.niche),
      }));
  } catch (error) {
    logger.warn(`Topic generation fell back to templates: ${errorMessage(error)}`);
    source = 'fallback';
  }

  let accepted = filterUnusedTopics(suggestions, recent, count);

  if (accepted.length < count) {
    const extra = filterUnusedTopics(
      fallbackTopics(input),
      [...recent, ...accepted.map((entry) => entry.title)],
      count - accepted.length,
    );
    accepted = [...accepted, ...extra];
    if (suggestions.length === 0) source = 'fallback';
  }

  return { topics: accepted.slice(0, count), source, requested: count };
}
