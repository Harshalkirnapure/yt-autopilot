import { closeStore, initStore } from './index.js';
import { logger } from '../utils/logger.js';

const store = await initStore();
logger.info(`Database ready (${store.mode} mode).`);
if (store.mode === 'postgres') {
  logger.info('Schema migration applied from src/db/schema.sql.');
}
await closeStore();
