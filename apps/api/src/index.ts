import { buildApp } from './app';
import { config } from './config';
import { closeDb } from './db/client';
import { startJobs } from './jobs';
import { startTelegramBot } from './modules/notifications/bot';

const app = await buildApp();

// One promise nobody waits for must not end the API, and the fire alerts with it.
process.on('unhandledRejection', (reason) => app.log.error({ err: reason }, 'unhandled rejection'));

// Connects in the background: the API stays useful without Redis, and only scheduled work pauses.
const stopJobs = config.JOBS_ENABLED === 'true' ? startJobs(app.log) : undefined;

// Polls getUpdates, so it must run on one API instance only. Does nothing without a bot token.
const stopTelegram = startTelegramBot(app.log);

async function shutdown() {
  await stopTelegram();
  await stopJobs?.();
  await app.close();
  await closeDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
