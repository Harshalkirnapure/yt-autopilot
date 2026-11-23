import { config } from '../config.js';
import { errorMessage, logger } from '../utils/logger.js';
import { logStep } from './jobLog.js';

export function alertsConfigured(): boolean {
  return Boolean(config.telegramBotToken && config.telegramChatId);
}

/** Sends an admin alert through Telegram when configured; otherwise logs it. */
export async function notifyAdmin(message: string, level: 'info' | 'error' = 'info'): Promise<void> {
  const text = `${level === 'error' ? '🚨 YT AutoPilot error' : '✅ YT AutoPilot'}\n${message}`;

  if (!alertsConfigured()) {
    // Without Telegram an alert used to exist only in the process log: invisible in the UI and lost
    // on restart. Persist it as an activity-log row so a stopped channel still shows what happened.
    await logStep(null, 'alert', level === 'error' ? 'warning' : 'info', message);
    return;
  }

  try {
    // Alerts must never stall a render or the daily pipeline on a slow Telegram endpoint.
    const response = await fetch(
      `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.telegramChatId,
          text: text.slice(0, 4000),
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8000),
      },
    );

    if (!response.ok) {
      logger.warn(`Telegram alert failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
    }
  } catch (error) {
    logger.warn(`Telegram alert failed: ${errorMessage(error)}`);
  }
}

/**
 * Alerts when uploads keep going out without their caption track.
 *
 * Nothing else fails in that case — the video is uploaded, approved and published normally — so the
 * regression is otherwise silent while YouTube serves auto-captions instead of the script. The alert
 * fires when the streak reaches the threshold and again on each further multiple of it, so a long
 * outage is reminded about but a per-upload spam is not.
 *
 * Returns whether an alert was raised (tests and callers do not need it, but it makes the trigger
 * explicit).
 */
export async function alertOnCaptionFailureStreak(
  streak: number,
  detail: string | null,
): Promise<boolean> {
  const threshold = config.captionFailureAlertThreshold;
  if (streak < threshold || streak % threshold !== 0) return false;

  const reason = detail?.trim() || 'YouTube rejected the caption track without a message.';
  await notifyAdmin(
    `${streak} uploads in a row went out without a caption track, so those videos show YouTube's ` +
      `auto-captions instead of the script. Last error: ${reason}`,
    'error',
  );
  return true;
}
