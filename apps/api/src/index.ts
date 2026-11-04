import { buildApp } from './app';
import { config } from './config';
import { closeDb } from './db/client';
import { startJobs } from './jobs';
import { startTelegramBot } from './modules/notifications/bot';

const app = await buildApp();

let stopJobs: (() => Promise<void>) | undefined;
if (config.JOBS_ENABLED === 'true') {
  try {
    stopJobs = await startJobs(app.log);
  } catch (err) {
    // The API stays useful without Redis; only scheduled work pauses.
    app.log.error({ err }, 'background jobs did not start');
  }
}

// Polls getUpdates, so it must run on one API instance only. Does nothing without a bot token.
const stopTelegram = startTelegramBot(app.log);

async function shutdown() {
  stopTelegram();
  await stopJobs?.();
  await app.close();
  await closeDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
