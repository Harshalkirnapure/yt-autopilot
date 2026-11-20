import { config } from '../config.js';
import { AppError, unavailable } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

export interface GenerateOptions {
  temperature?: number;
  maxOutputTokens?: number;
  json?: boolean;
  systemInstruction?: string;
}

interface GeminiPayload {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

export function geminiConfigured(): boolean {
  return Boolean(config.geminiApiKey);
}

async function requestGemini(
  prompt: string,
  options: GenerateOptions,
  withThinkingBudget: boolean,
): Promise<string> {
  if (!config.geminiApiKey) {
    throw unavailable('GEMINI_API_KEY is not configured. Add it to backend/.env to enable AI generation.');
  }

  const base = config.geminiBaseUrl.replace(/\/+$/, '');
  const url = `${base}/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: options.temperature ?? 0.85,
      maxOutputTokens: options.maxOutputTokens ?? 4096,
      ...(options.json ? { responseMimeType: 'application/json' } : {}),
      ...(withThinkingBudget ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
    ...(options.systemInstruction
      ? { systemInstruction: { parts: [{ text: options.systemInstruction }] } }
      : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.geminiApiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(502, `Could not reach the Gemini API: ${message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();

  if (!response.ok) {
    let apiMessage = raw.slice(0, 400) || response.statusText;
    try {
      const parsed = JSON.parse(raw) as GeminiPayload;
      if (parsed.error?.message) apiMessage = parsed.error.message;
    } catch {
      /* keep the raw snippet */
    }
    const retryable = [429, 500, 502, 503, 504].includes(response.status);
    throw new AppError(
      response.status === 429 ? 429 : retryable ? 502 : 400,
      `Gemini request failed (${response.status}): ${apiMessage}`,
      { retryable },
    );
  }

  let payload: GeminiPayload;
  try {
    payload = JSON.parse(raw) as GeminiPayload;
  } catch {
    throw new AppError(502, 'Gemini returned a non-JSON response.', { retryable: true });
  }

  if (payload.promptFeedback?.blockReason) {
    throw new AppError(422, `Gemini blocked this prompt: ${payload.promptFeedback.blockReason}`, {
      retryable: false,
    });
  }

  const text = (payload.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? '')
    .join('')
    .trim();

  if (!text) {
    const reason = payload.candidates?.[0]?.finishReason;
    throw new AppError(502, `Gemini returned an empty response${reason ? ` (${reason})` : ''}.`, {
      retryable: true,
    });
  }

  return text;
}

export async function generateText(prompt: string, options: GenerateOptions = {}): Promise<string> {
  return withRetry(
    async () => {
      try {
        return await requestGemini(prompt, options, true);
      } catch (error) {
        // Older API revisions reject thinkingConfig; retry the same prompt without it.
        if (error instanceof AppError && /thinking/i.test(error.message)) {
          logger.warn('Gemini rejected thinkingConfig; retrying without it.');
          return await requestGemini(prompt, options, false);
        }
        throw error;
      }
    },
    { attempts: 3, baseDelayMs: 1500, label: 'Gemini generateContent' },
  );
}

function parseJsonLoose<T>(raw: string): T {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* try to recover an embedded JSON value */
  }

  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    } catch {
      /* fall through */
    }
  }

  throw new AppError(502, 'Gemini response was not valid JSON.', { retryable: false });
}

export async function generateJson<T>(prompt: string, options: GenerateOptions = {}): Promise<T> {
  const raw = await generateText(prompt, { ...options, json: true });
  return parseJsonLoose<T>(raw);
}
