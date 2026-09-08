import { buildApp } from './app.js';
import { env } from './env.js';
import { prisma } from './db.js';
import { startJobs } from './jobs/runner.js';
import { warnOnDemoAccounts } from './lib/demo-accounts.js';

const app = await buildApp();
const boss = await startJobs(app.log).catch((err) => {
  app.log.error({ err }, 'failed to start background jobs — continuing without them');
  return null;
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await boss?.stop({ graceful: true }).catch(() => undefined);
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

if (env.NODE_ENV === 'production') {
  await warnOnDemoAccounts(app.log).catch(() => undefined);
}

try {
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`Hiva OS API listening on http://${env.HOST}:${env.PORT}`);
} catch (err) {
  app.log.error({ err }, 'failed to start server');
  process.exit(1);
}
