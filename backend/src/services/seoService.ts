import { generateJson } from './gemini.js';

export interface SeoMetadata {
  title_options: string[];
  description: string;
  tags: string[];
  upload_checklist: string[];
}

interface RawSeoResponse {
  title_options?: unknown;
  description?: unknown;
  tags?: unknown;
  upload_checklist?: unknown;
}

export interface SeoInput {
  topic: string;
  niche: string;
  audience?: string;
  language?: string;
}

function stringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, limit);
}

export async function generateSeo(input: SeoInput): Promise<SeoMetadata> {
  const prompt = [
    'You are a YouTube SEO specialist.',
    `Channel niche: ${input.niche}.`,
    `Video topic: ${input.topic}.`,
    input.audience ? `Target audience: ${input.audience}.` : '',
    input.language ? `Language and tone: ${input.language}.` : '',
    '',
    'Generate YouTube SEO metadata as JSON with this shape:',
    '{"title_options":["..."],"description":"...","tags":["..."],"upload_checklist":["..."]}',
    '',
    'Rules:',
    '- 5 title options, each under 100 characters, specific and honest (no ALL CAPS, no misleading claims).',
    '- Description: 2 short paragraphs followed by 5-8 relevant hashtags on the final line. Mention that visuals are royalty-free stock footage.',
    '- Tags: 10-15 short phrases, under 30 characters each, no spam.',
    '- upload_checklist: 5-8 concrete checks a human should complete before publishing (accuracy, audio levels, captions, copyright, thumbnail legibility, privacy setting).',
    '- Do not include any text outside the JSON object.',
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await generateJson<RawSeoResponse>(prompt, { temperature: 0.7, maxOutputTokens: 3072 });

  const titleOptions = stringArray(raw.title_options, 6)
    .map((title) => title.slice(0, 100))
    .filter((title) => title.length > 5);
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const tags = stringArray(raw.tags, 15).map((tag) => tag.slice(0, 30));
  const checklist = stringArray(raw.upload_checklist, 10);

  if (!titleOptions.length || !description) {
    throw new Error('The AI returned incomplete SEO metadata. Please try again.');
  }

  return {
    title_options: titleOptions.length ? titleOptions : [`${input.topic} | ${input.niche}`],
    description,
    tags,
    upload_checklist: checklist.length ? checklist : ['Verify facts', 'Check audio levels', 'Review captions', 'Confirm privacy setting'],
  };
}
