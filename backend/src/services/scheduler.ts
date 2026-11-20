import cron from 'node-cron';
import { config } from '../config.js';
import { getStore } from '../db/index.js';
import { errorMessage, logger } from '../utils/logger.js';
import { logStep } from './jobLog.js';
import { runDaily, type PipelineResult, type PipelineTrigger } from './pipeline.js';

let task: cron.ScheduledTask | null = null;

export function startScheduler(): void {
  if (task) return;

  if (!cron.validate(config.cronSchedule)) {
    logger.error(`Scheduler disabled: "${config.cronSchedule}" is not a valid cron expression.`);
    return;
  }

  try {
    task = cron.schedule(
      config.cronSchedule,
      () => {
        logger.info('Cron fired: starting the daily pipeline.');
        void runDaily({ trigger: 'schedule' }).catch((error: unknown) =>
          logger.error(`Scheduled pipeline failed: ${errorMessage(error)}`),
        );
      },
      { timezone: config.cronTimezone },
    );
  } catch (error) {
    // An invalid CRON_TIMEZONE throws here; log it instead of crashing the whole server.
    logger.error(`Scheduler disabled: could not arm "${config.cronSchedule}". ${errorMessage(error)}`);
    return;
  }

  logger.info(`Scheduler armed: "${config.cronSchedule}" (${config.cronTimezone}).`);
}

export function stopScheduler(): void {
  task?.stop();
  task = null;
}

export interface CatchUpOptions {
  /** Override the clock (tests). */
  now?: Date;
  /** How stale the newest run may be before a catch-up is justified. */
  windowMs?: number;
  /** Injectable runner (tests); defaults to a real scheduled run. */
  run?: (trigger: PipelineTrigger) => Promise<PipelineResult>;
}

/**
 * A restart can land just after the scheduled time, so the cron tick for that day is simply lost.
 * On boot, if the newest run is older than the schedule period, start exactly one run. The run lock
 * (and the 20-hour rule inside `runDaily`) still prevent duplicates if another process got there
 * first; this only decides *whether* a run looks missing.
 */
export async function catchUpScheduledRun(options: CatchUpOptions = {}): Promise<PipelineResult | null> {
  const now = options.now ?? new Date();
  const windowMs = options.windowMs ?? config.catchUpAfterHours * 60 * 60 * 1000;
  const windowHours = Math.round(windowMs / 3_600_000);

  const last = await getStore().latestPipelineRun();
  // No ledger rows yet means the schedule has certainly been missed.
  const ageMs = last ? now.getTime() - Date.parse(last.started_at) : null;

  if (ageMs !== null && ageMs < windowMs) {
    logger.info(
      `No catch-up run: the newest pipeline run started ${Math.round(ageMs / 60_000)} min ago ` +
        `(${last?.status}), inside the ${windowHours} h window.`,
    );
    return null;
  }

  const description =
    ageMs === null
      ? 'there is no recorded pipeline run yet'
      : `the newest run started ${Math.floor(ageMs / 3_600_000)} h ago (${last?.status})`;
  logger.warn(`Catch-up run: ${description}, which is outside the ${windowHours} h window.`);
  await logStep(null, 'pipeline', 'warning', `Boot catch-up: ${description}. Starting one run.`);

  const run = options.run ?? ((trigger: PipelineTrigger) => runDaily({ trigger }));
  return run('boot');
}

export function schedulerStatus(): { enabled: boolean; armed: boolean; schedule: string; timezone: string } {
  return {
    enabled: config.schedulerEnabled,
    armed: task !== null,
    schedule: config.cronSchedule,
    timezone: config.cronTimezone,
  };
}
