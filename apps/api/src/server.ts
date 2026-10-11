import { buildApp } from './app.js';
import { env } from './env.js';
import { prisma } from './db.js';
import { startJobs } from './jobs/runner.js';
import { demoAccountGate } from './lib/demo-accounts.js';
import { shutdownPdfEngine } from './pdf/renderer.js';
import { syncReference } from './setup/reference.js';
import { APP_VERSION } from './version.js';

const app = await buildApp();

// Audit SEC-8: before anything runs — the reference sync, the jobs, the listener.
if (env.NODE_ENV === 'production') {
  const gate = await demoAccountGate(app.log, env.ALLOW_DEMO_ACCOUNTS);
  if (gate.refuse) {
    await app.close().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(1);
  }
}

// Roadmap #50: an upgraded installation brings its reference data up to the code before it serves.
// A failure is loud but not fatal — the system runs on the reference data it already has.
if (env.REFERENCE_SYNC === 'on') {
  const started = Date.now();
  await syncReference(prisma, { trigger: 'startup', appVersion: APP_VERSION })
    .then((s) => app.log.info({
      version: APP_VERSION, ms: Date.now() - started, recorded: s.recorded,
      organizations: s.organizations.map((o) => ({ id: o.organizationId, formsChanged: o.formsChanged, formsKept: o.formsKept, slaAdded: o.slaAdded, slaUpdated: o.slaUpdated, departmentsAdded: o.departmentsAdded })),
    }, 'reference data in step with the code'))
    .catch((err) => app.log.error({ err }, 'reference sync failed — serving on the reference data already present'));
}
const boss = await startJobs(app.log).catch((err) => {
  app.log.error({ err }, 'failed to start background jobs — continuing without them');
  return null;
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await boss?.stop({ graceful: true }).catch(() => undefined);
  // Before app.close(): the browser is a child process that outlives the Node process otherwise,
  // so every restart leaked a Chromium.
  await shutdownPdfEngine().catch(() => undefined);
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`Hivamis API listening on http://${env.HOST}:${env.PORT}`);
} catch (err) {
  app.log.error({ err }, 'failed to start server');
  process.exit(1);
}
