import { getStore } from '../db/index.js';
import type { LogStatus } from '../db/types.js';
import { errorMessage, logger } from '../utils/logger.js';

/** Persists a pipeline step to job_logs, and mirrors it to the process log. */
export async function logStep(
  videoId: string | null,
  step: string,
  status: LogStatus,
  message: string,
): Promise<void> {
  try {
    await getStore().log(videoId, step, status, message);
  } catch (error) {
    logger.warn(`Could not persist job log (${step}): ${errorMessage(error)}`);
  }

  const line = `${step} → ${status}: ${message}`;
  if (status === 'failed') logger.error(line);
  else if (status === 'warning') logger.warn(line);
  else logger.info(line);
}
