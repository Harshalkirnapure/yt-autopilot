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
