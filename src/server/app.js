import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { config } from '../core/config.js';
import { getDb } from '../core/db.js';
import { ensureSeeded } from '../core/settings.js';
import { startScheduler } from '../scheduler/scheduler.js';
import apiRoutes from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '../../web');

export async function buildApp() {
  // Open DB + seed defaults/providers before anything serves traffic.
  getDb();
  ensureSeeded();
  mkdirSync(config.outputDir, { recursive: true });
  mkdirSync(config.stagingDir, { recursive: true });

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

  // Bearer/?token auth — only enforced when AUTH_TOKEN is configured.
  if (config.authToken) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.url === '/api/health') return;
      const header = req.headers.authorization || '';
      const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
      const token = bearer || req.query?.token;
      if (token !== config.authToken) return reply.code(401).send({ error: 'unauthorized' });
    });
  }

  // Surface errors as { error } so the UI can display them; upstream/source
  // failures (e.g. a blocked or rate-limited API) become 502 rather than 500.
  app.setErrorHandler((err, req, reply) => {
    const upstream = /API error|fetch|MangaDex|getChapterPages|ENOTFOUND|ECONN/i.test(err.message || '');
    const code = err.statusCode && err.statusCode >= 400 ? err.statusCode : (upstream ? 502 : 500);
    req.log.error(err);
    reply.code(code).send({ error: err.message || 'Internal error' });
  });

  await app.register(apiRoutes);
  await app.register(fastifyStatic, { root: WEB_DIR, prefix: '/' });

  return app;
}

// Run directly: node src/server/app.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildApp();
  startScheduler();
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`mangas-binder UI on http://localhost:${config.port}  | output: ${config.outputDir}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
